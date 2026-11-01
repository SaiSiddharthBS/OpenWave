"""OpenWave Connect: a paired phone reaches this engine from anywhere, with no accounts, no port
forwarding and no VPN.

Pairing: the engine shows a QR code holding a link to the OpenWave web app with this engine's id
and a fresh device key after the "#" (so it never reaches a web server). The phone keeps it.

Finding each other: the phone posts a WebRTC offer to public Nostr relays as a short-lived event
(relays pass it on and don't store it), encrypted and authenticated with the device key; the engine
answers the same way. Only someone holding the device key can start a connection, and the relays
see nothing but random-looking bytes.

Talking: a WebRTC data channel, directly between the two devices (STUN finds a path through home
routers and mobile networks). Each request the phone makes is forwarded to this engine's own HTTP
API, so the phone runs the same web app, with the same profiles, as any browser at home.

Wire format on the channel. Phone -> engine, text: {"i": id, "m": method, "p": path, "h": headers,
"b": body text or null}, or {"i": id, "x": 1} to cancel. Engine -> phone: text {"i": id, "s":
status, "h": headers}, then binary frames (4-byte id + bytes), then text {"i": id, "end": 1} or
{"i": id, "err": message}.
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

import httpx

from . import _nomedia, nostr

log = logging.getLogger("openwave.connect")

KIND = 21078                      # ephemeral: relays forward it to listeners and never store it
WEB_APP = "https://saisiddharthbs.github.io/OpenWave/app/"
STUN = ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"]
MAX_SKEW = 120                    # seconds an offer stays valid
CHUNK = 16 * 1024 - 4             # every browser accepts 16 KB data-channel messages
HIGH_WATER = 1024 * 1024          # pause a response while this much is queued on the channel
PASS_HEADERS = {"content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"}


def _b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


def _unb64(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


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
        return json.loads(AESGCM(key).decrypt(raw[:12], raw[12:], aad.encode()))
    except (InvalidTag, ValueError, TypeError):
        return None


def pair_link(host_pub: str, device_key: bytes, name: str, base: str = WEB_APP) -> str:
    payload = json.dumps({"v": 1, "h": host_pub, "k": _b64(device_key), "n": name[:60]}, separators=(",", ":"))
    return f"{base}#connect={_b64(payload.encode())}"


def _default_source() -> str | None:
    """The address this computer uses to reach the internet (no packet is sent)."""
    with contextlib.suppress(OSError), socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.connect(("1.1.1.1", 53))
        return s.getsockname()[0]
    return None


def _tune_ice() -> None:
    """aioice waits up to 5 s for STUN answers on every network interface, including ones that
    never answer (VPNs such as Tailscale, link-local addresses), and that wait is most of the time
    a connection takes. Use only interfaces that can reach the internet, and wait at most 2 s."""
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


class Host:
    """Listens on the relays for this engine's paired devices and serves their connections."""

    def __init__(self, engine_url: str, state_dir: Path, relays: list[str], name: str = "OpenWave"):
        self.engine_url, self.state_file, self.name = engine_url.rstrip("/"), state_dir / "connect.json", name
        self.state = self._load()
        self.pub = nostr.public_key(self.state["secret"])
        self.room = room_of(self.pub)
        self.pool = nostr.RelayPool(relays, self._on_event, kinds=(KIND,), tag="t")
        self.peers: set = set()
        self.seen: dict[str, float] = {}
        self.http: httpx.AsyncClient | None = None
        self.stats: list[dict] = []

    # ---------------------------------------------------------------- state

    def _load(self) -> dict:
        try:
            st = json.loads(self.state_file.read_text())
            if isinstance(st.get("secret"), str) and isinstance(st.get("devices"), dict):
                return st
        except (OSError, ValueError):
            pass
        st = {"secret": nostr.new_secret(), "devices": {}}
        self._save(st)
        return st

    def _save(self, st: dict | None = None) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(st or self.state))
        os.chmod(tmp, 0o600)
        tmp.replace(self.state_file)

    def add_device(self, label: str = "iPhone") -> str:
        key = os.urandom(32)
        dev = secrets.token_hex(4)
        self.state["devices"][dev] = {"key": _b64(key), "label": label, "added": int(time.time()), "seen": None}
        self._save()
        return pair_link(self.pub, key, self.name)

    # ---------------------------------------------------------------- lifecycle

    async def start(self) -> None:
        self.http = httpx.AsyncClient(base_url=self.engine_url, timeout=httpx.Timeout(60, connect=5))
        await self.pool.set_rooms([self.room])

    async def stop(self) -> None:
        await self.pool.stop()
        for pc in list(self.peers):
            with contextlib.suppress(Exception):
                await pc.close()
        if self.http:
            await self.http.aclose()

    # ---------------------------------------------------------------- signaling

    def _open(self, content: str) -> tuple[str, bytes, dict] | None:
        for dev, d in self.state["devices"].items():
            key = _unb64(d["key"])
            msg = unseal(key, content, "offer:" + self.room)
            if msg is not None:
                return dev, key, msg
        return None

    async def _on_event(self, ev: dict, url: str) -> None:
        if ev.get("kind") != KIND:
            return
        opened = self._open(ev.get("content", ""))
        if not opened:
            return
        dev, key, msg = opened
        session = msg.get("s")
        if msg.get("t") != "offer" or not isinstance(session, str) or not isinstance(msg.get("sdp"), str):
            return
        if abs(time.time() - msg.get("ts", 0) / 1000) > MAX_SKEW or session in self.seen:
            return
        self.seen = {k: v for k, v in self.seen.items() if v > time.time() - 2 * MAX_SKEW}
        self.seen[session] = time.time()
        log.info("offer from device %s via %s", dev, url)
        asyncio.create_task(self._answer(dev, key, session, msg["sdp"]))

    async def _answer(self, dev: str, key: bytes, session: str, sdp: str) -> None:
        _nomedia.install()
        from aiortc import RTCConfiguration, RTCIceServer, RTCPeerConnection, RTCSessionDescription
        _tune_ice()
        t0 = time.time()
        pc = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(urls=STUN)]))
        self.peers.add(pc)

        @pc.on("datachannel")
        def on_channel(ch):
            Channel(self, ch, dev)

        @pc.on("connectionstatechange")
        async def on_state():
            log.info("device %s: %s", dev, pc.connectionState)
            if pc.connectionState in ("failed", "closed"):
                self.peers.discard(pc)
                await pc.close()

        try:
            await pc.setRemoteDescription(RTCSessionDescription(sdp=_without_mdns(sdp), type="offer"))
            await pc.setLocalDescription(await pc.createAnswer())     # aiortc gathers every candidate here
            body = {"t": "answer", "s": session, "sdp": pc.localDescription.sdp, "ts": int(time.time() * 1000)}
            reply = reply_room(session)
            ev = nostr.make_event(nostr.new_secret(), KIND, [["t", reply]], seal(key, body, "answer:" + reply))
            ok = await self.pool.publish(ev)
            log.info("answered device %s in %.2fs via %s", dev, time.time() - t0, ok)
            self.state["devices"][dev]["seen"] = int(time.time())
            self._save()
        except Exception:  # noqa: BLE001
            log.exception("could not answer device %s", dev)
            self.peers.discard(pc)
            await pc.close()


class Channel:
    """One phone's data channel: forwards each request to the engine and streams the answer back."""

    def __init__(self, host: Host, ch, dev: str):
        self.host, self.ch, self.dev = host, ch, dev
        self.tasks: dict[int, asyncio.Task] = {}
        self.drained = asyncio.Event()
        self.drained.set()
        ch.bufferedAmountLowThreshold = HIGH_WATER // 4
        ch.on("message", self._on_message)
        ch.on("bufferedamountlow", self.drained.set)
        ch.on("close", self._on_close)

    def _on_close(self) -> None:
        for t in self.tasks.values():
            t.cancel()

    def _on_message(self, data) -> None:
        if not isinstance(data, str):
            return
        try:
            msg = json.loads(data)
            rid = int(msg["i"])
        except (ValueError, KeyError, TypeError):
            return
        if msg.get("x"):
            t = self.tasks.pop(rid, None)
            if t:
                t.cancel()
            return
        if msg.get("ping"):
            self._send_text({"i": rid, "pong": 1})
            return
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
        method, path = str(msg.get("m", "GET")).upper(), str(msg.get("p", ""))
        try:
            if not path.startswith("/api/") or method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
                self._send_text({"i": rid, "s": 404, "h": {"content-type": "application/json"}})
                await self._send_bytes(rid, b'{"detail":"not found"}')
                self._send_text({"i": rid, "end": 1})
                return
            headers = {k: v for k, v in (msg.get("h") or {}).items() if k.lower() in ("authorization", "content-type", "range", "accept")}
            body = msg.get("b")
            req = self.host.http.build_request(method, path, headers=headers, content=body.encode() if isinstance(body, str) else None)
            resp = await self.host.http.send(req, stream=True)
            try:
                self._send_text({"i": rid, "s": resp.status_code, "h": {k: v for k, v in resp.headers.items() if k.lower() in PASS_HEADERS}})
                async for chunk in resp.aiter_raw():
                    await self._send_bytes(rid, chunk)
            finally:
                await resp.aclose()
            self._send_text({"i": rid, "end": 1})
        except asyncio.CancelledError:
            pass
        except Exception as e:  # noqa: BLE001
            with contextlib.suppress(Exception):
                self._send_text({"i": rid, "err": str(e)[:200] or type(e).__name__})
        finally:
            self.tasks.pop(rid, None)


async def _main() -> None:
    import argparse
    from . import shared
    ap = argparse.ArgumentParser(description="Serve an OpenWave engine to paired phones")
    ap.add_argument("--engine", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--pair", action="store_true", help="print a new pairing link")
    ap.add_argument("--base", default=WEB_APP)
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    host = Host(a.engine, Path(a.state), shared.relays())
    if a.pair:
        link = host.add_device()
        if a.base != WEB_APP:
            link = link.replace(WEB_APP, a.base)
        print("PAIR", link, flush=True)
    await host.start()
    print("READY", host.pub, flush=True)
    await asyncio.Event().wait()


if __name__ == "__main__":
    asyncio.run(_main())
