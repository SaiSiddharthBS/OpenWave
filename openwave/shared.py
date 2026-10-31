"""Shared playlists: one playlist that friends and family edit together, each from their own OpenWave.

How it works
------------
* Sharing a playlist gives it a random **key**. The invite link carries that key (after the "#",
  so it never reaches a web server). Anyone with the link can join; everyone can add, remove and
  reorder songs; only the owner can rename it, remove people or delete it for everyone.
* Every member's OpenWave keeps the whole playlist as a small *document* in which each song
  records who last changed it and when. Two copies always **merge** to the same result, in any
  order, so edits made offline or at the same moment are never lost.
* Each member publishes their copy, encrypted with the key, to a few public Nostr relays
  (see nostr.py) and listens for everyone else's. Relays only see scrambled bytes.
* Owner-only settings (name, description, removed people, deleted) are signed by the owner, so
  other members can't fake them. Removing someone gives the playlist a **new key**, handed only to
  the people who remain, so the removed person can no longer read or change it.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import zlib

from . import nostr

log = logging.getLogger("openwave.shared")

KIND = 30078                      # Nostr "application data" (replaceable per author and room)
JOIN_URL = "https://saisiddharthbs.github.io/OpenWave/join/#"
DEFAULT_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net", "wss://nostr.mom"]
MAX_TRACKS = 2000
MAX_MESSAGE = 90_000              # public relays commonly refuse messages over 128 KB
MAX_CHUNKS = 16                   # a big playlist is split by song across up to this many messages
REPUBLISH_EVERY = 24 * 3600       # refresh our copy on the relays now and then, even with no changes


class ShareError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def relays() -> list[str]:
    """OPENWAVE_RELAYS="wss://a,wss://b" picks relays; "off" disables syncing (local only)."""
    raw = os.getenv("OPENWAVE_RELAYS")
    if raw is None:
        return list(DEFAULT_RELAYS)
    if raw.strip().lower() in ("", "off", "none", "0"):
        return []
    return [u.strip() for u in raw.split(",") if u.strip().startswith(("ws://", "wss://"))]


def now_ms() -> int:
    return int(time.time() * 1000)


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


# --------------------------------------------------------------------------- encryption
# Encrypt-then-MAC with HMAC-SHA256 as both the stream cipher (counter mode) and the tag: only the
# standard library, fast enough for whole playlists, and authenticated so tampering is detected.


def _subkeys(key: bytes) -> tuple[bytes, bytes]:
    return hmac.new(key, b"openwave-enc", hashlib.sha256).digest(), hmac.new(key, b"openwave-mac", hashlib.sha256).digest()


def _stream(enc: bytes, nonce: bytes, n: int) -> bytes:
    out = bytearray()
    for i in range((n + 31) // 32):
        out += hmac.new(enc, nonce + i.to_bytes(8, "big"), hashlib.sha256).digest()
    return bytes(out[:n])


def _xor(a: bytes, b: bytes) -> bytes:
    return (int.from_bytes(a, "big") ^ int.from_bytes(b, "big")).to_bytes(len(a), "big") if a else b""


def seal(key: bytes, data: bytes) -> str:
    enc, mac = _subkeys(key)
    nonce = os.urandom(16)
    body = zlib.compress(data, 9)
    ct = _xor(body, _stream(enc, nonce, len(body)))
    tag = hmac.new(mac, b"\x01" + nonce + ct, hashlib.sha256).digest()
    return base64.b64encode(b"\x01" + nonce + ct + tag).decode()


def unseal(key: bytes, blob: str) -> bytes:
    try:
        raw = base64.b64decode(blob, validate=True)
    except (ValueError, TypeError) as e:
        raise ShareError("not an OpenWave message") from e
    if len(raw) < 49 or raw[0] != 1:
        raise ShareError("not an OpenWave message")
    nonce, ct, tag = raw[1:17], raw[17:-32], raw[-32:]
    enc, mac = _subkeys(key)
    if not hmac.compare_digest(tag, hmac.new(mac, raw[:1] + nonce + ct, hashlib.sha256).digest()):
        raise ShareError("wrong key or damaged message")
    d = zlib.decompressobj()
    out = d.decompress(_xor(ct, _stream(enc, nonce, len(ct))), 8 * 1024 * 1024)
    if d.unconsumed_tail:
        raise ShareError("message too large")
    return out


# --------------------------------------------------------------------------- invites


def room_of(share_id: str) -> str:
    return hashlib.sha256(b"openwave-room:" + share_id.encode()).hexdigest()[:40]


def invite_link(share_id: str, key: bytes, epoch: int, owner: str, name: str) -> str:
    payload = json.dumps({"v": 1, "s": share_id, "k": _b64(key), "e": epoch, "o": owner, "n": name[:100]},
                         separators=(",", ":"), ensure_ascii=False).encode()
    return JOIN_URL + _b64(payload)


def parse_invite(text: str) -> dict:
    """Accepts the full link (from any app, with stray spaces or text around it) or just its code."""
    text = (text or "").strip()
    code = text.split("#", 1)[1] if "#" in text else text
    code = code.strip().split()[0] if code.strip() else ""
    try:
        d = json.loads(_unb64(code))
        share_id, key, owner = str(d["s"]), _unb64(d["k"]), str(d["o"])
        epoch = int(d.get("e", 1))
        bytes.fromhex(owner)
        if len(key) != 32 or len(owner) != 64 or not 8 <= len(share_id) <= 64:
            raise ValueError
    except (ValueError, KeyError, TypeError, IndexError) as e:
        raise ShareError("That isn't a valid OpenWave invite link. Ask for a new one and paste the whole link.") from e
    return {"share": share_id, "key": key, "epoch": epoch, "owner": owner, "name": str(d.get("n") or "Shared playlist")[:100]}


# --------------------------------------------------------------------------- the document
#
# {"share": id, "owner": pubkey,
#  "tracks": {videoId: {"t": track, "in": [0|1, ts, by], "pos": [number, ts, by], "add": [ts, by]}},
#              ("by" is the first 8 characters of the author's public key; "t" is dropped once removed)
#  "people": {pubkey: {"name": [name, ts, pubkey], "left": ts}},
#  "meta": {"name", "description", "deleted", "removed": {pubkey: ts}, "epoch", "ts", "sig"}}   # signed by the owner
#
# Every field is last-writer-wins on (timestamp, author), so merging is commutative, associative
# and idempotent: all members end up identical whatever order copies arrive in.

TRACK_KEYS = ("videoId", "title", "artists", "album", "duration", "thumbnail", "explicit")


def slim(t: dict) -> dict:
    out = {k: t.get(k) for k in TRACK_KEYS if t.get(k) not in (None, "", False, [])}
    if out.get("artists"):
        out["artists"] = [{"name": str(a.get("name", ""))[:200], **({"id": a["id"]} if a.get("id") else {})}
                          for a in out["artists"] if isinstance(a, dict)][:6]
    if isinstance(out.get("album"), dict):
        out["album"] = {k: v for k, v in out["album"].items() if k in ("name", "id") and v}
    if out.get("title"):
        out["title"] = str(out["title"])[:300]
    return out


def new_doc(share_id: str, owner: str) -> dict:
    return {"share": share_id, "owner": owner, "tracks": {}, "people": {}, "meta": {}}


def _lww(a, b, size: int):
    """The later of two [value…, ts, author] registers (None-safe)."""
    if not isinstance(a, list) or len(a) != size:
        return b if isinstance(b, list) and len(b) == size else None
    if not isinstance(b, list) or len(b) != size:
        return a
    return a if (a[-2], str(a[-1])) >= (b[-2], str(b[-1])) else b


def _meta_body(meta: dict) -> bytes:
    return json.dumps({k: v for k, v in meta.items() if k != "sig"}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()


def sign_meta(meta: dict, secret: str) -> dict:
    meta = {k: v for k, v in meta.items() if k != "sig"}
    meta["sig"] = nostr.sign(hashlib.sha256(_meta_body(meta)).digest(), secret)
    return meta


def meta_ok(meta, owner: str) -> bool:
    return (isinstance(meta, dict) and isinstance(meta.get("sig"), str)
            and nostr.verify(hashlib.sha256(_meta_body(meta)).digest(), owner, meta["sig"]))


def merge(a: dict, b: dict) -> dict:
    """Combine two copies of the same playlist. Pure: neither input is changed."""
    out = new_doc(a["share"], a["owner"])
    for vid in set(a.get("tracks", {})) | set(b.get("tracks", {})):
        x, y = a.get("tracks", {}).get(vid) or {}, b.get("tracks", {}).get(vid) or {}
        if not isinstance(x, dict) or not isinstance(y, dict):
            continue
        add = _lww(x.get("add"), y.get("add"), 2)
        entry = {"in": _lww(x.get("in"), y.get("in"), 3), "pos": _lww(x.get("pos"), y.get("pos"), 3), "add": add}
        # The song details travel with the most recent add.
        newer = x if add == x.get("add") else y
        if entry["in"] is None:
            continue
        if entry["in"][0]:
            entry["t"] = newer.get("t") or x.get("t") or y.get("t") or {"videoId": vid}
        out["tracks"][vid] = entry
    for pub in set(a.get("people", {})) | set(b.get("people", {})):
        x, y = a.get("people", {}).get(pub) or {}, b.get("people", {}).get(pub) or {}
        out["people"][pub] = {"name": _lww(x.get("name"), y.get("name"), 3) or ["", 0, pub], "left": max(x.get("left") or 0, y.get("left") or 0)}
    metas = [m for m in (a.get("meta"), b.get("meta")) if meta_ok(m, a["owner"])]
    out["meta"] = max(metas, key=lambda m: (m.get("ts", 0), m["sig"])) if metas else {}
    return out


def clock(doc: dict) -> int:
    """A timestamp later than anything in the document (so a new edit always wins), even with skewed clocks."""
    latest = 0
    for e in doc.get("tracks", {}).values():
        for f in ("in", "pos"):
            if isinstance(e.get(f), list):
                latest = max(latest, int(e[f][1]))
    latest = max([latest, int(doc.get("meta", {}).get("ts") or 0)]
                 + [int((p.get("name") or ["", 0])[1]) for p in doc.get("people", {}).values()])
    return max(now_ms(), latest + 1)


def who(pub: str) -> str:
    """The short author tag stored on every edit (keeps big playlists small)."""
    return pub[:8]


def view(doc: dict) -> list[dict]:
    """The playlist as members see it: present songs in order, each with who added it."""
    names = {who(pub): (p.get("name") or [""])[0] for pub, p in doc.get("people", {}).items()}
    present = [(e["pos"][0] if e.get("pos") else 0, (e.get("add") or [0])[0], vid, e)
               for vid, e in doc.get("tracks", {}).items() if e.get("in") and e["in"][0]]
    out = []
    for _, _, vid, e in sorted(present, key=lambda x: (x[0], x[1], x[2])):
        t = dict(e.get("t") or {})
        t.setdefault("videoId", vid)
        t.setdefault("type", "song")
        t.setdefault("artists", [])
        by = (e.get("add") or [0, ""])[1]
        if names.get(by):
            t["addedBy"] = names[by]
        out.append(t)
    return out


def edit_add(doc: dict, tracks: list[dict], me: str) -> dict:
    doc, me = json.loads(json.dumps(doc)), who(me)
    present = [e for e in doc["tracks"].values() if e.get("in") and e["in"][0]]
    if len(present) + len(tracks) > MAX_TRACKS:
        raise ShareError(f"A shared playlist can hold up to {MAX_TRACKS} songs.", 413)
    pos = max([e["pos"][0] for e in present if e.get("pos")] or [-1])
    for t in tracks:
        t = slim(t)
        vid = t.get("videoId")
        if not vid or (doc["tracks"].get(vid, {}).get("in") or [0])[0]:
            continue
        ts = clock(doc)
        pos += 1
        doc["tracks"][vid] = {"t": t, "in": [1, ts, me], "pos": [pos, ts, me], "add": [ts, me]}
    return doc


def edit_remove(doc: dict, video_id: str, me: str) -> dict:
    doc, me = json.loads(json.dumps(doc)), who(me)
    e = doc["tracks"].get(video_id)
    if e and e.get("in") and e["in"][0]:
        e["in"] = [0, clock(doc), me]
        e.pop("t", None)
    return doc


def edit_order(doc: dict, video_ids: list[str], me: str) -> dict:
    doc, me = json.loads(json.dumps(doc)), who(me)
    current = [t["videoId"] for t in view(doc)]
    wanted = [v for v in video_ids if v in current]
    wanted += [v for v in current if v not in wanted]    # never lose songs on a stale reorder
    ts = clock(doc)
    for i, vid in enumerate(wanted):
        e = doc["tracks"][vid]
        if not e.get("pos") or e["pos"][0] != i:
            e["pos"] = [i, ts, me]
    return doc


def set_person(doc: dict, pub: str, name: str | None = None, left: bool = False) -> dict:
    doc = json.loads(json.dumps(doc))
    p = doc["people"].setdefault(pub, {"name": ["", 0, pub], "left": 0})
    if name is not None and p["name"][0] != name[:40]:
        p["name"] = [name[:40], clock(doc), pub]
    if left:
        p["left"] = clock(doc)
    return doc


def set_meta(doc: dict, secret: str, **changes) -> dict:
    """Owner-only: name, description, deleted, removed, epoch. Re-signed on every change."""
    doc = json.loads(json.dumps(doc))
    meta = {"name": "", "description": "", "deleted": False, "removed": {}, "epoch": 1, **{k: v for k, v in doc.get("meta", {}).items() if k != "sig"}}
    meta.update(changes)
    meta["ts"] = clock(doc)
    doc["meta"] = sign_meta(meta, secret)
    return doc


def chunks(doc: dict, n: int) -> list[dict]:
    """The document split by song into n pieces. Each piece is a valid partial copy (merging the
    pieces gives the whole), and a song always lands in the same piece for a given n (a power of
    two), so pieces left over from an older, larger split only hold older edits: harmless."""
    if n == 1:
        return [doc]
    parts = [{**doc, "tracks": {}} for _ in range(n)]
    for vid, e in doc["tracks"].items():
        parts[zlib.crc32(vid.encode()) % n]["tracks"][vid] = e
    return parts


def sealed_pieces(doc: dict, key: bytes) -> list[str]:
    """The encrypted messages for a document: as few as possible, each small enough for relays."""
    n = 1
    while True:
        pieces = [seal(key, json.dumps(p, separators=(",", ":"), ensure_ascii=False).encode()) for p in chunks(doc, n)]
        if max(len(x) for x in pieces) <= MAX_MESSAGE or n >= MAX_CHUNKS:
            return pieces
        n *= 2


def piece_tag(room: str, i: int) -> str:
    return room if i == 0 else f"{room}/{i}"


def room_tags(room: str) -> list[str]:
    return [piece_tag(room, i) for i in range(MAX_CHUNKS)] + [room + ":k"]


def members(doc: dict) -> list[str]:
    """Everyone still in the playlist (joined, not left, not removed), owner first."""
    removed = doc.get("meta", {}).get("removed") or {}
    people = [p for p, v in doc.get("people", {}).items() if not v.get("left") and p not in removed]
    return sorted(people, key=lambda p: (p != doc["owner"], (doc["people"][p].get("name") or [""])[0].lower(), p))


# --------------------------------------------------------------------------- syncing


class Sync:
    """Runs inside the engine: publishes local changes and merges everyone else's.

    The Library calls `kick()` after every local change; this class does all networking. With no
    shared playlists, no relay is ever contacted.
    """

    def __init__(self, library, relay_urls: list[str] | None = None):
        self.library = library
        self.urls = relays() if relay_urls is None else relay_urls
        self.pool = nostr.RelayPool(self.urls, self._on_event, self._on_caught_up)
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.pending: dict[str, list[dict]] = {}     # room -> events for a key we don't have yet
        self.last_publish: dict[str, float] = {}
        self.retry_at: dict[str, float] = {}
        self.last_stamp: dict[str, int] = {}          # relays keep one copy per second: never reuse one

    def _stamp(self, key: str) -> int:
        stamp = max(int(time.time()), self.last_stamp.get(key, 0) + 1)
        self.last_stamp[key] = stamp
        return stamp

    async def start(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.library.on_share_change = self.kick
        if not self.task:
            self.task = asyncio.create_task(self._loop())
        self.kick()

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.task
            self.task = None
        await self.pool.stop()

    def kick(self) -> None:
        """Safe from any thread (the API runs library writes in a thread pool)."""
        loop = getattr(self, "loop", None)
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            self.wake.set()
        else:
            loop.call_soon_threadsafe(self.wake.set)

    def status(self) -> dict:
        st = self.pool.status()
        return {"relays": len(self.urls), "connected": sum(1 for r in st.values() if r["connected"]),
                "errors": {u: r["error"] for u, r in st.items() if r["error"]}}

    async def _loop(self) -> None:
        while True:
            self.wake.clear()    # before the work, so a change that arrives during it isn't missed
            try:
                rooms = []
                for s in self.library.share_rows():
                    rooms += room_tags(s["room"])
                if self.urls:
                    await self.pool.set_rooms(rooms)
                    await self._publish_due()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - one bad playlist must never stop syncing the others
                log.exception("shared playlist sync failed")
            with contextlib.suppress(asyncio.TimeoutError):
                await asyncio.wait_for(self.wake.wait(), timeout=30)
            await asyncio.sleep(0.8)    # gather bursts of edits into one publish

    async def _publish_due(self) -> None:
        now = time.time()
        for s in self.library.share_rows():
            pid = s["playlist_id"]
            if self.retry_at.get(pid, 0) > now:
                continue
            due = s["published"] != s["hash"] or now - self.last_publish.get(pid, 0) > REPUBLISH_EVERY
            keys_due = s["is_owner"] and s["keys_published"] < s["epoch"] and s["epoch"] > 1
            if not (due or keys_due):
                continue
            secret = self.library.identity(s["profile_id"])
            events = []
            if keys_due:
                events.append(self._keys_event(s, secret))
            if due:
                for i, content in enumerate(sealed_pieces(s["doc"], s["keys"][str(s["epoch"])])):
                    tag = piece_tag(s["room"], i)
                    events.append(nostr.make_event(secret, KIND, [["d", tag], ["epoch", str(s["epoch"])], ["client", "openwave"]], content,
                                                   created_at=self._stamp(tag + s["profile_id"])))
            stored = True
            for ev in events:
                ok = await self.pool.publish(ev)
                stored = stored and bool(ok)
            if stored:
                self.retry_at.pop(pid, None)
                self.last_publish[pid] = now
                self.library.share_published(pid, s["hash"] if due else s["published"], s["epoch"] if keys_due else None)
            else:
                wait = min(300, 15 * 2 ** min(5, int(self.retry_at.get(pid + ":n", 0))))
                self.retry_at[pid] = now + wait
                self.retry_at[pid + ":n"] = self.retry_at.get(pid + ":n", 0) + 1
                self.library.share_error(pid, "Waiting for an internet connection to sync." if not self.status()["connected"]
                                         else "Couldn't save changes to the relays yet; retrying.")

    def _keys_event(self, s: dict, secret: str) -> dict:
        key = s["keys"][str(s["epoch"])]
        envelopes = {pub: seal(nostr.shared_secret(secret, pub), key) for pub in members(s["doc"]) if pub != s["owner"]}
        content = json.dumps({"epoch": s["epoch"], "for": envelopes}, separators=(",", ":"))
        return nostr.make_event(secret, KIND, [["d", s["room"] + ":k"], ["client", "openwave"]], content,
                                created_at=self._stamp(s["room"] + ":k"))

    async def _on_caught_up(self, _url: str) -> None:
        self.library.share_synced_now()

    async def _on_event(self, ev: dict, _url: str) -> None:
        d = nostr.tag(ev, "d") or ""
        for s in self.library.share_rows(room=d.removesuffix(":k").split("/")[0]):
            try:
                if d.endswith(":k"):
                    self._on_keys(s, ev)
                else:
                    self._on_state(s, ev)
            except ShareError:
                continue     # someone else's garbage or an old key: ignore
            except Exception:  # noqa: BLE001
                log.exception("bad shared playlist event")

    def _on_keys(self, s: dict, ev: dict) -> None:
        if ev["pubkey"] != s["owner"] or s["is_owner"]:
            return
        body = json.loads(ev["content"])
        epoch = int(body.get("epoch", 0))
        if epoch <= s["epoch"]:
            return
        me = nostr.public_key(self.library.identity(s["profile_id"]))
        sealed = (body.get("for") or {}).get(me)
        if not sealed:
            # A newer key exists and none of it is for us: we were removed, or we joined with an
            # invite from before someone was removed (then we never saw the playlist at all).
            self.library.share_ended(s["playlist_id"], "removed" if s["acked"] else "expired")
            return
        key = unseal(nostr.shared_secret(self.library.identity(s["profile_id"]), s["owner"]), sealed)
        self.library.share_new_key(s["playlist_id"], epoch, key)
        for old in self.pending.pop(s["room"], []):
            with contextlib.suppress(ShareError):
                self._on_state(self.library.share_rows(playlist_id=s["playlist_id"])[0], old)
        self.kick()

    def _on_state(self, s: dict, ev: dict) -> None:
        epoch = int(nostr.tag(ev, "epoch") or 0)
        if epoch > s["epoch"]:
            self.pending.setdefault(s["room"], []).append(ev)
            return
        if epoch < s["epoch"]:
            return    # written with a retired key (possibly by someone who was removed)
        doc = json.loads(unseal(s["keys"][str(epoch)], ev["content"]))
        if not isinstance(doc, dict) or doc.get("share") != s["doc"]["share"] or doc.get("owner") != s["owner"]:
            return
        if ev["pubkey"] == s["owner"] and s["me"] in (doc.get("people") or {}) and not s["acked"]:
            self.library.share_acked(s["playlist_id"])
        if self.library.share_merge(s["playlist_id"], doc):
            self.kick()
