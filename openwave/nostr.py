"""Just enough Nostr to sync shared playlists between OpenWaves anywhere on the internet.

Nostr relays are free public servers that store and forward small signed JSON "events"; nobody
needs an account. OpenWave only ever puts *encrypted* playlist data on them (see shared.py), and
only for playlists someone chose to share. Everything here is standard-library Python so it runs
unchanged in the desktop apps, the server and the Android app:

* secp256k1 keys and BIP-340 Schnorr signatures (every event is signed by its author),
* ECDH, to hand a new playlist key to each remaining member privately,
* a small WebSocket client, and a pool that keeps a few relays connected and re-subscribes.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import secrets
import ssl
import struct
import time
from typing import Awaitable, Callable
from urllib.parse import urlparse

# --------------------------------------------------------------------------- secp256k1

P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
G = (0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798,
     0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8)

# Points are Jacobian (X, Y, Z) internally; None is the point at infinity.


def _double(pt):
    if pt is None:
        return None
    x, y, z = pt
    if y == 0:
        return None
    s = 4 * x * y * y % P
    m = 3 * x * x % P
    x2 = (m * m - 2 * s) % P
    return x2, (m * (s - x2) - 8 * pow(y, 4, P)) % P, 2 * y * z % P


def _add(a, b):
    if a is None:
        return b
    if b is None:
        return a
    x1, y1, z1 = a
    x2, y2, z2 = b
    z1s, z2s = z1 * z1 % P, z2 * z2 % P
    u1, u2 = x1 * z2s % P, x2 * z1s % P
    s1, s2 = y1 * z2s * z2 % P, y2 * z1s * z1 % P
    if u1 == u2:
        return _double(a) if s1 == s2 else None
    h, r = (u2 - u1) % P, (s2 - s1) % P
    h2 = h * h % P
    h3 = h * h2 % P
    x3 = (r * r - h3 - 2 * u1 * h2) % P
    return x3, (r * (u1 * h2 - x3) - s1 * h3) % P, h * z1 * z2 % P


def _mul(k: int, pt) -> tuple[int, int] | None:
    """k·pt for an affine point, returned affine."""
    acc, add = None, (pt[0], pt[1], 1)
    while k:
        if k & 1:
            acc = _add(acc, add)
        add = _double(add)
        k >>= 1
    if acc is None:
        return None
    x, y, z = acc
    zi = pow(z, -1, P)
    return x * zi * zi % P, y * zi * zi * zi % P


def _lift_x(x: int) -> tuple[int, int] | None:
    if x >= P:
        return None
    c = (pow(x, 3, P) + 7) % P
    y = pow(c, (P + 1) // 4, P)
    if y * y % P != c:
        return None
    return x, y if y % 2 == 0 else P - y


def _tagged(tag: str, msg: bytes) -> bytes:
    t = hashlib.sha256(tag.encode()).digest()
    return hashlib.sha256(t + t + msg).digest()


def new_secret() -> str:
    while True:
        k = secrets.token_bytes(32)
        if 0 < int.from_bytes(k, "big") < N:
            return k.hex()


def public_key(secret_hex: str) -> str:
    return _mul(int(secret_hex, 16), G)[0].to_bytes(32, "big").hex()


def sign(msg: bytes, secret_hex: str, aux: bytes | None = None) -> str:
    """BIP-340 Schnorr signature of a 32-byte message."""
    d0 = int(secret_hex, 16)
    if not 0 < d0 < N:
        raise ValueError("bad secret key")
    pub = _mul(d0, G)
    d = d0 if pub[1] % 2 == 0 else N - d0
    t = (d ^ int.from_bytes(_tagged("BIP0340/aux", aux if aux is not None else secrets.token_bytes(32)), "big")).to_bytes(32, "big")
    px = pub[0].to_bytes(32, "big")
    k0 = int.from_bytes(_tagged("BIP0340/nonce", t + px + msg), "big") % N
    if k0 == 0:
        raise ValueError("bad nonce")
    r = _mul(k0, G)
    k = k0 if r[1] % 2 == 0 else N - k0
    rx = r[0].to_bytes(32, "big")
    e = int.from_bytes(_tagged("BIP0340/challenge", rx + px + msg), "big") % N
    return (rx + ((k + e * d) % N).to_bytes(32, "big")).hex()


def verify(msg: bytes, pub_hex: str, sig_hex: str) -> bool:
    try:
        pub, sig = bytes.fromhex(pub_hex), bytes.fromhex(sig_hex)
    except ValueError:
        return False
    if len(pub) != 32 or len(sig) != 64:
        return False
    pt = _lift_x(int.from_bytes(pub, "big"))
    r, s = int.from_bytes(sig[:32], "big"), int.from_bytes(sig[32:], "big")
    if pt is None or r >= P or s >= N:
        return False
    e = int.from_bytes(_tagged("BIP0340/challenge", sig[:32] + pub + msg), "big") % N
    sg, ep = _mul(s, G), _mul(N - e, pt) if e else None
    total = _add(sg and (sg[0], sg[1], 1), ep and (ep[0], ep[1], 1))
    if total is None:
        return False
    x, y, z = total
    zi = pow(z, -1, P)
    ax, ay = x * zi * zi % P, y * zi * zi * zi % P
    return ay % 2 == 0 and ax == r


def shared_secret(secret_hex: str, other_pub_hex: str) -> bytes:
    """ECDH: the same 32 bytes for (my secret, your public) and (your secret, my public)."""
    pt = _lift_x(int(other_pub_hex, 16))
    if pt is None:
        raise ValueError("bad public key")
    return hashlib.sha256(b"openwave-ecdh" + _mul(int(secret_hex, 16), pt)[0].to_bytes(32, "big")).digest()


# --------------------------------------------------------------------------- events


def _serialize(pub: str, created_at: int, kind: int, tags: list, content: str) -> bytes:
    return json.dumps([0, pub, created_at, kind, tags, content], separators=(",", ":"), ensure_ascii=False).encode()


def make_event(secret_hex: str, kind: int, tags: list, content: str, created_at: int | None = None) -> dict:
    pub = public_key(secret_hex)
    created_at = int(created_at if created_at is not None else time.time())
    eid = hashlib.sha256(_serialize(pub, created_at, kind, tags, content)).digest()
    return {"id": eid.hex(), "pubkey": pub, "created_at": created_at, "kind": kind, "tags": tags,
            "content": content, "sig": sign(eid, secret_hex)}


def valid_event(ev: dict) -> bool:
    try:
        eid = hashlib.sha256(_serialize(ev["pubkey"], ev["created_at"], ev["kind"], ev["tags"], ev["content"])).hexdigest()
        return eid == ev["id"] and verify(bytes.fromhex(eid), ev["pubkey"], ev["sig"])
    except (KeyError, TypeError, ValueError):
        return False


def tag(ev: dict, name: str) -> str | None:
    for t in ev.get("tags") or []:
        if isinstance(t, list) and len(t) >= 2 and t[0] == name:
            return t[1]
    return None


# --------------------------------------------------------------------------- WebSocket client


class Closed(Exception):
    pass


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi  # bundled with the Android app and the desktop builds
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


class WebSocket:
    """A minimal RFC 6455 client: text messages, ping/pong and close. Enough for Nostr relays."""

    MAX_MESSAGE = 4 * 1024 * 1024

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        self.reader, self.writer = reader, writer
        self._send_lock = asyncio.Lock()

    @classmethod
    async def connect(cls, url: str, timeout: float = 10) -> "WebSocket":
        u = urlparse(url)
        secure = u.scheme == "wss"
        port = u.port or (443 if secure else 80)
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(u.hostname, port, ssl=_ssl_context() if secure else None,
                                    server_hostname=u.hostname if secure else None, limit=cls.MAX_MESSAGE), timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        host = u.hostname + (f":{u.port}" if u.port else "")
        writer.write((f"GET {u.path or '/'}{'?' + u.query if u.query else ''} HTTP/1.1\r\nHost: {host}\r\n"
                      "Upgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: OpenWave\r\n\r\n").encode())
        await writer.drain()
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout)
        lines = head.decode("latin-1").split("\r\n")
        if " 101 " not in lines[0] + " ":
            writer.close()
            raise Closed(f"handshake refused: {lines[0]}")
        headers = {k.strip().lower(): v.strip() for k, _, v in (ln.partition(":") for ln in lines[1:] if ":" in ln)}
        expect = base64.b64encode(hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
        if headers.get("sec-websocket-accept") != expect:
            writer.close()
            raise Closed("bad handshake")
        return cls(reader, writer)

    async def _frame(self, opcode: int, payload: bytes) -> None:
        head = bytes([0x80 | opcode])
        n = len(payload)
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload)) if n < 4096 else _xor_mask(payload, mask)
        async with self._send_lock:
            self.writer.write(head + mask + masked)
            await self.writer.drain()

    async def send(self, text: str) -> None:
        await self._frame(0x1, text.encode())

    async def recv(self) -> str:
        parts: list[bytes] = []
        size = 0
        while True:
            b1, b2 = await self.reader.readexactly(2)
            fin, opcode, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack(">H", await self.reader.readexactly(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", await self.reader.readexactly(8))[0]
            mask = await self.reader.readexactly(4) if b2 & 0x80 else None
            if n > self.MAX_MESSAGE:
                raise Closed("message too large")
            data = await self.reader.readexactly(n)
            if mask:
                data = _xor_mask(data, mask)
            if opcode == 0x8:
                with contextlib.suppress(Exception):
                    await self._frame(0x8, data[:2])
                raise Closed("closed by relay")
            if opcode == 0x9:
                await self._frame(0xA, data)
                continue
            if opcode == 0xA:
                continue
            parts.append(data)
            size += n
            if size > self.MAX_MESSAGE:
                raise Closed("message too large")
            if fin:
                return b"".join(parts).decode("utf-8", errors="replace")

    async def close(self) -> None:
        with contextlib.suppress(Exception):
            await asyncio.wait_for(self._frame(0x8, struct.pack(">H", 1000)), 2)
        with contextlib.suppress(Exception):
            self.writer.close()


def _xor_mask(data: bytes, mask: bytes) -> bytes:
    """Fast masking: XOR as one big integer instead of byte by byte."""
    n = len(data)
    if not n:
        return data
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(data, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


# --------------------------------------------------------------------------- relay pool

OnEvent = Callable[[dict, str], Awaitable[None]]


class Relay:
    """One relay connection that keeps itself connected and subscribed."""

    def __init__(self, url: str, pool: "RelayPool"):
        self.url, self.pool = url, pool
        self.ws: WebSocket | None = None
        self.task: asyncio.Task | None = None
        self.connected = asyncio.Event()
        self.waiting: dict[str, asyncio.Future] = {}   # event id -> OK result
        self.synced = False                             # received EOSE for the current subscription
        self.error = ""
        self.sub_id = ""

    def start(self) -> None:
        if not self.task or self.task.done():
            self.task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.task
        if self.ws:
            await self.ws.close()

    async def subscribe(self) -> None:
        if not self.ws:
            return
        flt = self.pool.filter()
        if self.sub_id:
            with contextlib.suppress(Exception):
                await self.ws.send(json.dumps(["CLOSE", self.sub_id]))
        self.synced = False
        if not flt:
            self.sub_id = ""
            return
        self.sub_id = secrets.token_hex(6)
        await self.ws.send(json.dumps(["REQ", self.sub_id, flt]))

    async def publish(self, ev: dict, timeout: float = 8) -> tuple[bool, str]:
        if not self.ws:
            return False, "not connected"
        fut = asyncio.get_running_loop().create_future()
        self.waiting[ev["id"]] = fut
        try:
            await self.ws.send(json.dumps(["EVENT", ev]))
            return await asyncio.wait_for(fut, timeout)
        except Exception as e:  # noqa: BLE001
            return False, str(e) or type(e).__name__
        finally:
            self.waiting.pop(ev["id"], None)

    async def _run(self) -> None:
        delay = 2.0
        while True:
            try:
                self.ws = await WebSocket.connect(self.url)
                self.error = ""
                delay = 2.0
                self.connected.set()
                await self.subscribe()
                while True:
                    await self._handle(json.loads(await self.ws.recv()))
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - network errors of every kind just mean "retry later"
                self.error = str(e)[:120] or type(e).__name__
            self.connected.clear()
            self.synced = False
            if self.ws:
                await self.ws.close()
                self.ws = None
            for fut in self.waiting.values():
                if not fut.done():
                    fut.set_result((False, "disconnected"))
            await asyncio.sleep(delay + secrets.randbelow(1000) / 1000)
            delay = min(delay * 2, 120)

    async def _handle(self, msg) -> None:
        if not isinstance(msg, list) or not msg:
            return
        kind = msg[0]
        if kind == "EVENT" and len(msg) >= 3 and msg[1] == self.sub_id and isinstance(msg[2], dict):
            await self.pool.received(msg[2], self.url)
        elif kind == "EOSE" and len(msg) >= 2 and msg[1] == self.sub_id:
            self.synced = True
            await self.pool.caught_up(self.url)
        elif kind == "OK" and len(msg) >= 3:
            fut = self.waiting.get(msg[1])
            if fut and not fut.done():
                fut.set_result((bool(msg[2]), str(msg[3]) if len(msg) > 3 else ""))
        elif kind == "CLOSED" and len(msg) >= 2 and msg[1] == self.sub_id:
            self.error = f"subscription closed: {msg[2] if len(msg) > 2 else ''}"[:120]


class RelayPool:
    """Keeps every relay connected while there is something to sync, and none when there isn't."""

    def __init__(self, urls: list[str], on_event: OnEvent, on_caught_up: Callable[[str], Awaitable[None]] | None = None):
        self.relays = {u: Relay(u, self) for u in urls}
        self.on_event, self.on_caught_up = on_event, on_caught_up
        self.rooms: list[str] = []
        self.seen: dict[str, float] = {}
        self._background: set[asyncio.Task] = set()

    def filter(self) -> dict | None:
        return {"kinds": [30078], "#d": sorted(self.rooms)} if self.rooms else None

    async def set_rooms(self, rooms: list[str]) -> None:
        rooms = sorted(set(rooms))
        if rooms == self.rooms:
            return
        self.rooms = rooms
        for r in self.relays.values():
            if rooms:
                r.start()
                with contextlib.suppress(Exception):
                    await r.subscribe()
        if not rooms:
            await self.stop()

    async def stop(self) -> None:
        for r in self.relays.values():
            await r.stop()
            r.task = None

    async def publish(self, ev: dict, wait: float = 6) -> list[str]:
        """Sends to every connected relay and returns as soon as one has stored it (the others
        finish in the background), so one slow relay never delays a change. Returns the relays
        that had stored it by then; empty if none did."""
        live = [r for r in self.relays.values() if r.ws]
        if not live:
            # Give fresh connections a moment (e.g. right after the first share).
            waits = [asyncio.create_task(r.connected.wait()) for r in self.relays.values()]
            await asyncio.wait(waits, timeout=wait, return_when=asyncio.FIRST_COMPLETED)
            for w in waits:
                w.cancel()
            live = [r for r in self.relays.values() if r.ws]
        if not live:
            return []
        tasks = {asyncio.create_task(r.publish(ev)): r for r in live}
        ok: list[str] = []
        pending = set(tasks)
        while pending and not ok:
            done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
            for t in done:
                self._settled(t, tasks[t], ok)
        for t in pending:     # keep slower relays going; just record how they did
            self._background.add(t)
            t.add_done_callback(lambda t, r=tasks[t]: (self._background.discard(t), self._settled(t, r, [])))
        return ok

    @staticmethod
    def _settled(task: asyncio.Task, relay: "Relay", ok: list[str]) -> None:
        if task.cancelled():
            return
        accepted, why = task.result()
        if accepted:
            ok.append(relay.url)
        else:
            relay.error = f"rejected: {why}"[:120]

    async def received(self, ev: dict, url: str) -> None:
        eid = ev.get("id")
        if not isinstance(eid, str) or eid in self.seen:
            return
        if len(self.seen) > 5000:
            cutoff = sorted(self.seen.values())[2500]
            self.seen = {k: v for k, v in self.seen.items() if v > cutoff}
        self.seen[eid] = time.time()
        if valid_event(ev):
            await self.on_event(ev, url)

    async def caught_up(self, url: str) -> None:
        if self.on_caught_up:
            await self.on_caught_up(url)

    def status(self) -> dict:
        return {u: {"connected": bool(r.ws), "synced": r.synced, "error": r.error} for u, r in self.relays.items()}
