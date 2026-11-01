"""OpenWave Connect: a paired phone reaches this engine from anywhere, with no accounts, no port
forwarding and no VPN.

Pairing: Settings shows a QR code holding a link to the OpenWave web app with this engine's public
key and a pairing ticket after the "#" (so it never reaches a web server). The ticket works for
15 minutes. A phone that uses it makes its own key pair and sends the public half; from then on the
phone and the engine share a device key that neither ever sends (ECDH), so a photo of the QR code,
or someone watching the relays, can't connect later. Removing the phone in Settings revokes it.

Finding each other: the phone posts a WebRTC offer to public Nostr relays as a short-lived event
(relays pass it on and don't store it), encrypted and authenticated with its device key (or the
ticket, the first time); the engine answers the same way. The relays see nothing but random-looking
bytes from throwaway identities.

Talking: a WebRTC data channel, directly between the two devices (STUN finds a path through home
routers and mobile networks; the channel is encrypted end to end with DTLS). Each request the
phone makes goes to this engine's own HTTP API, in-process, so the phone runs the same web app
with the same profiles as any browser at home, and gets no more access than one.

Wire format on the channel. Phone -> engine, text: {"i": id, "m": method, "p": path, "h": headers,
"b": body text or null}, {"i": id, "x": 1} to cancel, or {"i": id, "ping": 1}. Engine -> phone:
text {"i": id, "s": status, "h": headers}, then binary frames (4-byte id + bytes), then text
{"i": id, "end": 1} or {"i": id, "err": message}; {"i": id, "pong": 1} answers a ping.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import ipaddress
import json
import logging
import os
import re
import secrets
import socket
import time
from pathlib import Path
from urllib.parse import unquote

from . import _nomedia, nostr, shared

log = logging.getLogger("openwave.connect")

API = 1                           # what the web app checks before using an engine through Connect
KIND = 21078                      # ephemeral: relays forward it to listeners and never store it
WEB_APP = "https://saisiddharthbs.github.io/OpenWave/app/"
STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]
PAIR_TTL = 15 * 60                # a pairing code (QR) stops working after this long
MAX_DEVICES = 50
MAX_PER_TICKET = 5                # phones one pairing code can add
MAX_SKEW = 120                    # seconds an offer stays valid
MAX_PEERS = 3                     # connections per phone (a new one replaces the oldest)
MAX_REQUESTS = 32                 # requests in flight per connection
MAX_BODY = 8 * 1024 * 1024        # largest request body a phone may send
CHUNK = 16 * 1024 - 4             # every browser accepts 16 KB data-channel messages
HIGH_WATER = 1024 * 1024          # pause a response while this much is queued on the channel
REQUEST_HEADERS = {"authorization", "content-type", "range", "accept", "if-none-match", "user-agent"}
RESPONSE_HEADERS = {"content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"}


class ConnectError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def web_app() -> str:
    """Where pairing links point: the OpenWave web app (OPENWAVE_CONNECT_APP overrides it)."""
    return os.getenv("OPENWAVE_CONNECT_APP") or WEB_APP


def unavailable() -> str | None:
    """Why Connect can't run here, or None if it can."""
    if os.getenv("OPENWAVE_CONNECT", "1").strip().lower() in ("0", "off", "false", "no"):
        return "Turned off on this computer (OPENWAVE_CONNECT=0)."
    if not shared.relays():
        return "Needs internet relays, which are turned off on this computer (OPENWAVE_RELAYS=off)."
    try:
        import aioice  # noqa: F401
        import cryptography  # noqa: F401
        import pylibsrtp  # noqa: F401
    except ImportError:
        return "Not available in this version of OpenWave."
    return None


def room_of(host_pub: str) -> str:
    return hashlib.sha256(b"openwave-connect:" + host_pub.encode()).hexdigest()[:40]


def reply_room(session: str) -> str:
    return hashlib.sha256(b"openwave-connect-reply:" + session.encode()).hexdigest()[:40]


def seal(key: bytes, data: dict, aad: str) -> str:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    nonce = os.urandom(12)
    return base64.b64encode(nonce + AESGCM(key).encrypt(nonce, json.dumps(data).encode(), aad.encode())).decode()


def unseal(key: bytes, blob: str, aad: str) -> dict | None:
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    try:
        raw = base64.b64decode(blob, validate=True)
        if len(raw) < 29:
            return None
        msg = json.loads(AESGCM(key).decrypt(raw[:12], raw[12:], aad.encode()))
        return msg if isinstance(msg, dict) else None
    except (InvalidTag, ValueError, TypeError):
        return None


def device_key(host_secret: str, phone_pub: str) -> bytes:
    """The key a paired phone and this engine share without ever sending it."""
    return hashlib.sha256(b"openwave-connect-device" + nostr.shared_secret(host_secret, phone_pub)).digest()


def pair_link(host_pub: str, ticket: bytes, name: str, relays: list[str], base: str | None = None) -> str:
    payload: dict = {"v": 1, "h": host_pub, "k": _b64(ticket), "n": name[:60]}
    if relays != shared.DEFAULT_RELAYS:
        payload["r"] = relays          # the web app uses the default relays unless told otherwise
    return f"{base or web_app()}#connect={_b64(json.dumps(payload, separators=(',', ':')).encode())}"


def device_label(user_agent: str) -> str:
    ua = user_agent or ""
    for needle, label in (("iPad", "iPad"), ("iPhone", "iPhone"), ("Android", "Android phone"), ("Macintosh", "Mac"), ("Windows", "Windows PC"), ("Linux", "Computer")):
        if needle in ua:
            return label
    return "Phone"


# --------------------------------------------------------------------------- ICE tuning


def _default_source() -> str | None:
    """The address this computer uses to reach the internet (no packet is sent)."""
    with contextlib.suppress(OSError), socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("1.1.1.1", 53))
        return s.getsockname()[0]
    return None


def _tune_ice() -> None:
    """aioice waits up to 5 s for STUN answers on every network interface, including ones that
    never answer (VPNs such as Tailscale, link-local addresses), and that wait was most of the time
    a connection took. Use only interfaces that can reach the internet, and wait at most 2 s."""
    from aioice import ice
    if getattr(ice, "_openwave_tuned", False):
        return
    addresses = ice.get_host_addresses

    def usable(use_ipv4: bool, use_ipv6: bool) -> list[str]:
        default = _default_source()
        keep = []
        for a in addresses(use_ipv4, use_ipv6):
            ip = ipaddress.ip_address(a)
            if ip.is_link_local or ip.is_loopback:
                continue
            if ip.version == 4 and ip in ipaddress.ip_network("100.64.0.0/10") and a != default:
                continue                       # carrier-grade NAT range: Tailscale and similar VPNs
            keep.append(a)
        return keep

    gather = ice.Connection.get_component_candidates

    async def quick(self, component, addresses, timeout=5):
        return await gather(self, component, addresses, timeout=min(timeout, 2))

    ice.get_host_addresses = usable
    ice.Connection.get_component_candidates = quick
    ice._openwave_tuned = True


def _without_mdns(sdp: str) -> str:
    """Browsers hide their local address behind a random .local name; resolving it costs seconds
    and isn't needed, since the browser's own checks reveal its address (peer reflexive)."""
    return "".join(line for line in sdp.splitlines(keepends=True) if not re.match(r"a=candidate:\S+ \d+ \S+ \d+ \S+\.local ", line))


# --------------------------------------------------------------------------- host


class Host:
    """Listens on the relays for this engine's paired phones and serves their connections."""

    def __init__(self, app, state_file: Path, relays: list[str], name: str | None = None, stun: list[str] | None = None):
        self.app, self.state_file, self.relays = app, state_file, relays
        self.stun = STUN if stun is None else stun
        self.name = (name or os.getenv("OPENWAVE_DEVICE_NAME") or socket.gethostname().split(".")[0] or "OpenWave")[:60]
        self.state = self._load()
        self.pub = nostr.public_key(self.state["secret"])
        self.room = room_of(self.pub)
        self.pool: nostr.RelayPool | None = None
        self.peers: dict = {}             # RTCPeerConnection -> (device id, started)
        self.seen: dict[str, float] = {}  # offer sessions already answered
        self.offers: dict[str, list[float]] = {}   # device or ticket id -> recent offer times
        self.tasks: set[asyncio.Task] = set()
        self.started = False

    # ---------------------------------------------------------------- state
    # {"secret": engine key, "tickets": {id: {key, created, devices}}, "devices": {id: {pub, key, label, added, seen}}}

    def _load(self) -> dict:
        try:
            st = json.loads(self.state_file.read_text())
            if isinstance(st.get("secret"), str) and isinstance(st.get("devices"), dict):
                st.setdefault("tickets", {})
                return st
        except (OSError, ValueError):
            pass
        return {"secret": nostr.new_secret(), "tickets": {}, "devices": {}}

    def _save(self) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.state))
        with contextlib.suppress(OSError):
            os.chmod(tmp, 0o600)
        tmp.replace(self.state_file)

    def _expire(self) -> None:
        now = time.time()
        stale = [t for t, v in self.state["tickets"].items() if now - v.get("created", 0) > PAIR_TTL]
        for t in stale:
            del self.state["tickets"][t]
        if stale:
            self._save()

    def pair(self) -> dict:
        """A pairing ticket: a link (for a QR code) that pairs phones for the next 15 minutes."""
        self._expire()
        if len(self.state["devices"]) >= MAX_DEVICES:
            raise ConnectError(f"Remove a phone you no longer use first ({MAX_DEVICES} at most).", 409)
        key = os.urandom(32)
        tid = secrets.token_hex(4)
        self.state["tickets"][tid] = {"key": _b64(key), "created": int(time.time()), "devices": []}
        self._save()
        return {"id": tid, "link": pair_link(self.pub, key, self.name, self.relays), "expires": int(time.time()) + PAIR_TTL}

    async def remove(self, dev: str) -> None:
        if self.state["devices"].pop(dev, None) is None:
            raise ConnectError("That phone isn't paired.", 404)
        self._save()
        for pc, (d, _) in list(self.peers.items()):
            if d == dev:
                await self._drop(pc)

    def status(self) -> dict:
        self._expire()
        online = {d for d, _ in self.peers.values()}
        relays = self.pool.status() if self.pool else {}
        return {
            "name": self.name,
            "relays": sum(1 for r in relays.values() if r["connected"]),
            "devices": [
                {"id": d, "label": v.get("label") or "Phone", "added": v.get("added"), "seen": v.get("seen"), "online": d in online}
                for d, v in sorted(self.state["devices"].items(), key=lambda kv: kv[1].get("added", 0))
            ],
            "tickets": [
                {"id": t, "expires": v["created"] + PAIR_TTL, "devices": [d for d in v.get("devices", []) if d in self.state["devices"]]}
                for t, v in self.state["tickets"].items()
            ],
        }

    def _enroll(self, tid: str, phone_pub: str, ua: str) -> str | None:
        """Pair the phone with this public key (again, if it retries) and return its device id."""
        for dev, d in self.state["devices"].items():
            if d.get("pub") == phone_pub:
                return dev
        ticket = self.state["tickets"].get(tid)
        if not ticket or len(ticket["devices"]) >= MAX_PER_TICKET or len(self.state["devices"]) >= MAX_DEVICES:
            return None
        dev = secrets.token_hex(4)
        self.state["devices"][dev] = {"pub": phone_pub, "key": _b64(device_key(self.state["secret"], phone_pub)),
                                      "label": device_label(ua), "added": int(time.time()), "seen": None}
        ticket["devices"].append(dev)
        self._save()
        log.info("paired a new %s (%s)", self.state["devices"][dev]["label"], dev)
        return dev

    # ---------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        if self.started:
            return
        _nomedia.install()
        from ._vendor import aiortc  # noqa: F401 - fail here, not on a phone's first call, if a build left it out
        self.started = True
        self._save()                  # keep the engine's identity stable from the first start
        self.pool = nostr.RelayPool(self.relays, self._on_event, kinds=(KIND,), tag="t")
        await self.pool.set_rooms([self.room])

    async def stop(self) -> None:
        self.started = False
        if self.pool:
            await self.pool.stop()
        for pc in list(self.peers):
            await self._drop(pc)
        for t in list(self.tasks):
            t.cancel()

    async def _drop(self, pc) -> None:
        self.peers.pop(pc, None)
        with contextlib.suppress(Exception):
            await pc.close()

    def _spawn(self, coro) -> None:
        t = asyncio.create_task(coro)
        self.tasks.add(t)
        t.add_done_callback(self.tasks.discard)

    # ---------------------------------------------------------------- signaling

    def _open(self, content: str) -> tuple[str, str, bytes, dict] | None:
        """Which paired phone (or live ticket) sealed this offer: ("device" | "ticket", id, key, message)."""
        aad = "offer:" + self.room
        for dev, d in self.state["devices"].items():
            key = _unb64(d["key"])
            msg = unseal(key, content, aad)
            if msg is not None and msg.get("t") == "offer":
                return "device", dev, key, msg
        now = time.time()
        for tid, t in self.state["tickets"].items():
            if now - t.get("created", 0) > PAIR_TTL:
                continue
            key = _unb64(t["key"])
            msg = unseal(key, content, aad)
            if msg is not None and msg.get("t") == "enroll":
                return "ticket", tid, key, msg
        return None

    async def _on_event(self, ev: dict, url: str) -> None:
        if ev.get("kind") != KIND or len(ev.get("content", "")) > 64_000:
            return
        opened = self._open(ev["content"])
        if not opened:
            return
        how, ident, key, msg = opened
        session, sdp = msg.get("s"), msg.get("sdp")
        if not isinstance(session, str) or not isinstance(sdp, str) or not 8 <= len(session) <= 64:
            return
        now = time.time()
        if not isinstance(msg.get("ts"), (int, float)) or abs(now - msg["ts"] / 1000) > MAX_SKEW or session in self.seen:
            return
        recent = [t for t in self.offers.get(ident, []) if now - t < 60]
        if len(recent) >= 12:         # a phone retrying in a loop shouldn't keep this engine busy
            return
        self.offers[ident] = recent + [now]
        self.seen = {k: v for k, v in self.seen.items() if v > now - 2 * MAX_SKEW}
        self.seen[session] = now
        ua = str(msg.get("ua", ""))[:200]
        if how == "ticket":
            pub = msg.get("pub")
            if not isinstance(pub, str) or not re.fullmatch(r"[0-9a-f]{64}", pub) or nostr._lift_x(int(pub, 16)) is None:
                return
            dev = self._enroll(ident, pub, ua)
            if dev is None:
                return
        else:
            dev = ident
        log.info("offer from device %s via %s", dev, url)
        self._spawn(self._answer(dev, key, session, sdp))

    async def _answer(self, dev: str, key: bytes, session: str, sdp: str) -> None:
        _nomedia.install()
        from ._vendor.aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
        _tune_ice()
        t0 = time.time()
        mine = sorted(((started, pc) for pc, (d, started) in self.peers.items() if d == dev), key=lambda x: x[0])
        for _, old in mine[: max(0, len(mine) - MAX_PEERS + 1)]:
            await self._drop(old)
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(urls=self.stun)] if self.stun else []))
        self.peers[pc] = (dev, t0)

        @pc.on("datachannel")
        def on_channel(ch):
            Channel(self, pc, ch, dev)

        @pc.on("connectionstatechange")
        async def on_state():
            log.info("device %s: %s", dev, pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                await self._drop(pc)

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=_without_mdns(sdp), type="offer"))
            await pc.setLocalDescription(await pc.createAnswer())     # aiortc gathers every candidate here
            body = {"t": "answer", "s": session, "sdp": pc.localDescription.sdp, "ts": int(time.time() * 1000), "api": API, "n": self.name, "d": dev}
            reply = reply_room(session)
            ev = nostr.make_event(nostr.new_secret(), KIND, [["t", reply]], seal(key, body, "answer:" + reply))
            ok = await self.pool.publish(ev) if self.pool else []
            log.info("answered device %s in %.2fs via %s", dev, time.time() - t0, ok)
            d = self.state["devices"].get(dev)
            if d is not None:
                d["seen"] = int(time.time())
                self._save()
        except Exception:  # noqa: BLE001
            log.exception("could not answer device %s", dev)
            await self._drop(pc)


class Channel:
    """One phone's data channel: runs each request against the engine and streams the answer back."""

    def __init__(self, host: Host, pc, ch, dev: str):
        self.host, self.pc, self.ch, self.dev = host, pc, ch, dev
        self.tasks: dict[int, asyncio.Task] = {}
        self.cancelled: dict[int, asyncio.Event] = {}
        self.drained = asyncio.Event()
        self.drained.set()
        ch.bufferedAmountLowThreshold = HIGH_WATER // 4
        ch.on("message", self._on_message)
        ch.on("bufferedamountlow", self.drained.set)
        ch.on("close", self._on_close)

    def _on_close(self) -> None:
        for t in list(self.tasks.values()):
            t.cancel()
        self.host._spawn(self.host._drop(self.pc))

    def _on_message(self, data) -> None:
        if not isinstance(data, str) or len(data) > MAX_BODY + 4096:
            return
        try:
            msg = json.loads(data)
            rid = int(msg["i"])
        except (ValueError, KeyError, TypeError):
            return
        if msg.get("x"):
            ev = self.cancelled.get(rid)
            if ev:
                ev.set()
            t = self.tasks.pop(rid, None)
            if t:
                t.cancel()
            return
        if msg.get("ping"):
            self._send_text({"i": rid, "pong": 1})
            return
        if rid in self.tasks:
            return
        if len(self.tasks) >= MAX_REQUESTS:
            self._send_text({"i": rid, "err": "Too many requests at once"})
            return
        self.cancelled[rid] = asyncio.Event()
        self.tasks[rid] = asyncio.create_task(self._serve(rid, msg))

    def _send_text(self, obj: dict) -> None:
        if self.ch.readyState == "open":
            self.ch.send(json.dumps(obj))

    async def _send_bytes(self, rid: int, data: bytes) -> None:
        prefix = rid.to_bytes(4, "big")
        for i in range(0, len(data), CHUNK):
            while self.ch.bufferedAmount > HIGH_WATER:
                self.drained.clear()
                await self.drained.wait()
            if self.ch.readyState != "open":
                raise ConnectionError("channel closed")
            self.ch.send(prefix + data[i:i + CHUNK])

    async def _serve(self, rid: int, msg: dict) -> None:
        started = False
        try:
            method, path = str(msg.get("m", "GET")).upper(), str(msg.get("p", ""))
            body = msg.get("b")
            body = body.encode() if isinstance(body, str) else b""
            if not path.startswith("/api/") or method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD") or len(body) > MAX_BODY:
                self._send_text({"i": rid, "s": 404, "h": {"content-type": "application/json"}})
                await self._send_bytes(rid, b'{"error":"not found"}')
                self._send_text({"i": rid, "end": 1})
                return
            raw, _, query = path.partition("?")
            headers = [(k.lower().encode("latin-1"), str(v).encode("latin-1", "replace"))
                       for k, v in (msg.get("h") or {}).items() if isinstance(k, str) and k.lower() in REQUEST_HEADERS]
            headers.append((b"host", b"connect.openwave"))
            if body:
                headers.append((b"content-length", str(len(body)).encode()))
            scope = {
                "type": "http", "asgi": {"version": "3.0", "spec_version": "2.3"}, "http_version": "1.1",
                "method": method, "scheme": "http", "path": unquote(raw), "raw_path": raw.encode("latin-1", "replace"),
                "query_string": query.encode("latin-1", "replace"), "root_path": "", "headers": headers,
                "client": ("connect", 0), "server": ("connect.openwave", 80),
                "openwave.connect": self.dev,      # lets endpoints refuse things only the computer may do
            }
            sent_body = False
            gone = self.cancelled[rid]

            async def receive():
                nonlocal sent_body
                if not sent_body:
                    sent_body = True
                    return {"type": "http.request", "body": body, "more_body": False}
                await gone.wait()
                return {"type": "http.disconnect"}

            async def send(message):
                nonlocal started
                if message["type"] == "http.response.start":
                    started = True
                    hdrs = {}
                    for k, v in message.get("headers", []):
                        k = k.decode("latin-1").lower()
                        if k in RESPONSE_HEADERS:
                            hdrs[k] = v.decode("latin-1")
                    self._send_text({"i": rid, "s": message["status"], "h": hdrs})
                elif message["type"] == "http.response.body":
                    if message.get("body"):
                        await self._send_bytes(rid, message["body"])

            await self.host.app(scope, receive, send)
            self._send_text({"i": rid, "end": 1})
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001
            log.warning("request failed: %s", e)
            with contextlib.suppress(Exception):
                if started:
                    self._send_text({"i": rid, "err": str(e)[:200] or type(e).__name__})
                else:
                    self._send_text({"i": rid, "s": 500, "h": {"content-type": "application/json"}})
                    await self._send_bytes(rid, json.dumps({"error": "OpenWave hit a problem with that request"}).encode())
                    self._send_text({"i": rid, "end": 1})
        finally:
            self.tasks.pop(rid, None)
            self.cancelled.pop(rid, None)
