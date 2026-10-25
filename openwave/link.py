"""Your other devices on the same Wi-Fi: play music on one of them from another (like a remote), or
listen together, with every device playing the same song at the same moment.

Every OpenWave app runs its own engine, and a device's player (the web page) only ever talks to
that engine, under /api/link. Engines find each other with a UDP broadcast and talk over a second,
small HTTP listener that serves nothing but the /link routes, so the library and everything else
stay private to the device. A device has to be allowed once (a prompt on its screen) before another
one can control it or join its listening session.

Audio never travels between devices: each one streams the song itself, and only "what's playing,
where, and is it paused" is passed around. Positions travel as "position + how long ago", so the
devices' clocks never need to agree.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import httpx
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

from . import __version__
from .config import data_dir

LAN_PORTS = range(47880, 47890)  # HTTP for other devices (only /link/*): the first free one
DISCOVERY_PORT = 47880  # UDP
LONG_POLL = 25  # seconds a poll or watch waits for something to happen
ONLINE = 60  # a player that hasn't polled for this long has closed
MAX_BODY = 1_000_000
COMMANDS = {
    "toggle", "play", "pause", "next", "prev", "seek", "jump", "removeAt", "move", "playList", "playRadio",
    "playPlaylistRadio", "playNext", "addToQueue", "volume", "mute", "shuffle", "repeat", "take",
}
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")


class LinkError(Exception):
    status = 400

    def __init__(self, message: str, status: int | None = None, **extra: Any):
        super().__init__(message)
        if status:
            self.status = status
        self.extra = extra


def lan_ip() -> str | None:
    """This device's address on the local network (no packet is actually sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return None


def _hostname() -> str:
    name = socket.gethostname().split(".")[0].replace("-", " ").strip()
    return name or {"darwin": "Mac", "win32": "Windows PC"}.get(sys.platform, "Computer")


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> float:
    return time.monotonic()


def _text(value: Any, limit: int = 60) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]


@dataclass
class Player:
    """One open OpenWave page using this engine (usually just the app's own)."""

    id: str
    name: str
    kind: str
    seen: float = field(default_factory=_now)
    state: dict | None = None
    stamp: float = field(default_factory=_now)  # when `state` was recorded
    version: int = 0
    hosting: bool = False
    members: dict = field(default_factory=dict)  # "engine/player" -> {"name", "seen"}

    @property
    def online(self) -> bool:
        return _now() - self.seen < ONLINE

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "kind": self.kind, "hosting": self.hosting}


class _Responder(asyncio.DatagramProtocol):
    """Answers "any OpenWave here?" broadcasts from devices looking for this one."""

    def __init__(self, hub: Hub):
        self.hub = hub
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport):
        self.transport = transport

    def datagram_received(self, data, addr):
        try:
            msg = json.loads(data[:4096])
        except ValueError:
            return
        if isinstance(msg, dict) and msg.get("app") == "openwave" and msg.get("q") and msg.get("engine") != self.hub.engine:
            with contextlib.suppress(OSError):
                self.transport.sendto(json.dumps(self.hub.announcement()).encode(), addr)


class _Collector(asyncio.DatagramProtocol):
    def __init__(self, hub: Hub, found: dict):
        self.hub = hub
        self.found = found

    def datagram_received(self, data, addr):
        try:
            msg = json.loads(data[:65536])
        except ValueError:
            return
        if not isinstance(msg, dict) or msg.get("app") != "openwave" or msg.get("q"):
            return
        engine = msg.get("engine")
        if isinstance(engine, str) and ID_RE.match(engine) and engine != self.hub.engine:
            self.found[engine] = {**msg, "host": addr[0], "at": _now()}


class Hub:
    def __init__(self):
        self._conf: dict | None = None
        self.players: dict[str, Player] = {}
        self.events: list[tuple[int, str | None, dict]] = []
        self.seq = 0
        self.found: dict[str, dict] = {}  # engine -> its latest discovery answer
        self.pairs: dict[str, dict] = {}  # requests from other devices waiting for an answer here
        self.rtt: dict[str, float] = {}
        self._pulse: asyncio.Event | None = None
        self._scan: asyncio.Task | None = None
        self._scanned = 0.0
        self._lan = None
        self._lan_task: asyncio.Task | None = None
        self._udp: asyncio.DatagramTransport | None = None
        self._janitor: asyncio.Task | None = None
        self.port: int | None = None
        self.client = httpx.AsyncClient(timeout=httpx.Timeout(8, read=40), trust_env=False)  # never via a proxy

    # ------------------------------------------------------------------ settings on disk
    @property
    def path(self):
        return data_dir() / "link.json"

    @property
    def conf(self) -> dict:
        if self._conf is None:
            try:
                conf = json.loads(self.path.read_text())
            except (OSError, ValueError):
                conf = {}
            conf = conf if isinstance(conf, dict) else {}
            conf.setdefault("engine", secrets.token_urlsafe(12))
            for key in ("peers", "allowed", "names"):
                conf.setdefault(key, {})
            conf.setdefault("addresses", [])
            self._conf = conf
            self._save()
        return self._conf

    def _save(self):
        with contextlib.suppress(OSError):
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(self._conf, indent=1))
            os.replace(tmp, self.path)

    @property
    def engine(self) -> str:
        return self.conf["engine"]

    @property
    def visible(self) -> bool:
        v = self.conf.get("visible")
        return os.getenv("OPENWAVE_LINK", "") == "1" if v is None else bool(v)

    @property
    def device_name(self) -> str:
        return _text(self.conf.get("name") or os.getenv("OPENWAVE_DEVICE_NAME") or _hostname())

    @property
    def device_kind(self) -> str:
        return os.getenv("OPENWAVE_DEVICE_KIND") or ("phone" if hasattr(sys, "getandroidapilevel") else "computer")

    # ------------------------------------------------------------------ lifecycle
    async def start(self):
        self._pulse = None  # belongs to the event loop that's now running
        if self.client.is_closed:
            self.client = httpx.AsyncClient(timeout=httpx.Timeout(8, read=40), trust_env=False)
        self._janitor = asyncio.create_task(self._tidy())
        if self.visible:
            await self._open()

    async def stop(self):
        if self._janitor:
            self._janitor.cancel()
        await self._close()
        await self.client.aclose()

    async def set_visible(self, on: bool):
        self.conf["visible"] = on
        self._save()
        await (self._open() if on else self._close())

    async def _open(self):
        """Start answering other devices: the discovery responder and the /link listener."""
        loop = asyncio.get_running_loop()
        if self._udp is None:
            for reuse in (True, False):  # several engines on one computer can share the port (not on Windows)
                try:
                    self._udp, _ = await loop.create_datagram_endpoint(
                        lambda: _Responder(self), local_addr=("0.0.0.0", DISCOVERY_PORT), allow_broadcast=True, reuse_port=reuse or None)
                    break
                except (OSError, ValueError):
                    continue
        if self._lan is None:
            import uvicorn

            sock = next((s for s in map(_bind, LAN_PORTS) if s), None)
            if sock is None:
                return
            config = uvicorn.Config(lan_app, log_level="warning", log_config=None, access_log=False, lifespan="off", http="h11", ws="none")
            self._lan = uvicorn.Server(config)
            self.port = sock.getsockname()[1]
            self._lan_task = asyncio.create_task(self._serve(self._lan, sock))

    @staticmethod
    async def _serve(server, sock: socket.socket):
        # Whatever goes wrong here (uvicorn even calls sys.exit), the engine itself must keep running.
        try:
            await server.serve(sockets=[sock])
        except (Exception, SystemExit) as e:  # noqa: BLE001
            print(f"OpenWave: the devices listener stopped: {e!r}", flush=True)
        finally:
            sock.close()

    async def _close(self):
        if self._udp:
            self._udp.close()
            self._udp = None
        if self._lan:
            self._lan.should_exit = True
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._lan_task, 5)
            self._lan = self._lan_task = self.port = None

    async def _tidy(self):
        while True:
            await asyncio.sleep(10)
            now = _now()
            for p in list(self.players.values()):
                if now - p.seen > ONLINE * 2:
                    del self.players[p.id]
                for key, m in list(p.members.items()):
                    if now - m["seen"] > ONLINE:
                        del p.members[key]
                        self.emit({"type": "members", "left": m["name"], "members": self._members(p)}, to=p.id)
            for rid, r in list(self.pairs.items()):
                if now - r["at"] > 180:
                    del self.pairs[rid]
            for engine, f in list(self.found.items()):
                if now - f["at"] > 120:
                    del self.found[engine]
            self._wake()

    # ------------------------------------------------------------------ waiting for changes
    def _wake(self):
        if self._pulse:
            self._pulse.set()
        self._pulse = asyncio.Event()

    async def _wait(self, timeout: float):
        if self._pulse is None:
            self._pulse = asyncio.Event()
        with contextlib.suppress(asyncio.TimeoutError):
            await asyncio.wait_for(self._pulse.wait(), max(0.01, timeout))

    def emit(self, event: dict, to: str | None = None):
        self.seq += 1
        self.events.append((self.seq, to, event))
        del self.events[:-200]
        self._wake()

    # ------------------------------------------------------------------ this engine's players
    def hello(self, pid: str, name: str, kind: str) -> dict:
        if not ID_RE.match(pid):
            raise LinkError("bad player id")
        name = _text(self.conf["names"].get(pid) or name or self.device_name)
        p = self.players.get(pid)
        if p:
            p.name, p.kind, p.seen = name, kind or p.kind, _now()
        else:
            self.players[pid] = Player(pid, name, (kind or self.device_kind)[:20])
        return self.settings(pid)

    def player(self, pid: str) -> Player:
        p = self.players.get(pid)
        if not p:
            raise LinkError("unknown player", 404)
        p.seen = _now()
        return p

    def settings(self, pid: str) -> dict:
        p = self.player(pid)
        return {
            "engine": self.engine, "player": pid, "name": p.name, "visible": self.visible, "address": lan_ip(),
            "hosting": p.hosting, "members": self._members(p),
            "allowed": [{"engine": e, "name": a["name"]} for e, a in self.conf["allowed"].items()],
            "paired": [{"engine": e, "name": a["name"]} for e, a in self.conf["peers"].items()],
        }

    def rename(self, pid: str, name: str):
        p = self.player(pid)
        name = _text(name)
        if not name:
            raise LinkError("Give this device a name")
        p.name = self.conf["names"][pid] = name
        self._save()

    async def poll(self, pid: str, cursor: int) -> dict:
        deadline = _now() + LONG_POLL
        if cursor < 0 or cursor > self.seq:
            self.player(pid)
            return {"cursor": self.seq, "events": []}
        while True:
            self.player(pid)
            out = [e for s, to, e in self.events if s > cursor and to in (None, pid)]
            if out or _now() >= deadline:
                return {"cursor": self.seq, "events": out}
            await self._wait(deadline - _now())

    def publish(self, pid: str, state: dict | None):
        p = self.player(pid)
        p.state = state if isinstance(state, dict) else None
        p.stamp = _now()
        p.version += 1
        self._wake()

    def _members(self, p: Player) -> list[str]:
        return [m["name"] for m in p.members.values()]

    def host(self, pid: str, on: bool) -> dict:
        p = self.player(pid)
        p.hosting = on
        if not on:
            p.members.clear()
        p.version += 1
        self._wake()
        return {"hosting": on, "members": self._members(p)}

    def members(self, pid: str) -> list[str]:
        return self._members(self.player(pid))

    # ------------------------------------------------------------------ what other devices see
    def announcement(self) -> dict:
        return {
            "app": "openwave", "v": 1, "engine": self.engine, "name": self.device_name, "version": __version__,
            "port": self.port, "players": [p.public() for p in self.players.values() if p.online],
        }

    def _snapshot(self, p: Player) -> dict:
        return {"version": p.version, "state": p.state, "age": _now() - p.stamp, "hosting": p.hosting, "name": p.name}

    async def watch_here(self, pid: str, version: int, member: str | None = None, name: str = "", follow: bool = False) -> dict:
        """The player's state as soon as it differs from `version` (or after LONG_POLL anyway)."""
        deadline = _now() + LONG_POLL
        while True:
            p = self.players.get(pid)
            if not p or not p.online:
                return {"gone": True}
            if follow:
                if not p.hosting or (member and member not in p.members):
                    return {"ended": True}
                p.members[member]["seen"] = _now()
            if p.version != version or _now() >= deadline:
                return self._snapshot(p)
            await self._wait(deadline - _now())

    def join_here(self, pid: str, member: str, name: str):
        p = self.players.get(pid)
        if not p or not p.online:
            raise LinkError("That device closed OpenWave", 404)
        if not p.hosting:
            raise LinkError("That device isn’t hosting a listening session any more", 404)
        fresh = member not in p.members
        p.members[member] = {"name": _text(name) or "Someone", "seen": _now()}
        if fresh:
            self.emit({"type": "members", "joined": p.members[member]["name"], "members": self._members(p)}, to=pid)

    def leave_here(self, pid: str, member: str):
        p = self.players.get(pid)
        m = p and p.members.pop(member, None)
        if m:
            self.emit({"type": "members", "left": m["name"], "members": self._members(p)}, to=pid)
            self._wake()

    def deliver(self, pid: str, cmd: dict, sender: dict):
        p = self.players.get(pid)
        if not p or not p.online:
            raise LinkError("That device closed OpenWave", 404)
        if not isinstance(cmd, dict) or cmd.get("cmd") not in COMMANDS:
            raise LinkError("unknown command")
        self.emit({"type": "command", "cmd": cmd, "from": {"name": _text(sender.get("name")), "key": sender.get("key", "")}}, to=pid)

    # ------------------------------------------------------------------ finding devices
    def _targets(self) -> set[str]:
        out = {"255.255.255.255", "127.0.0.1"}
        ip = lan_ip()
        if ip:
            out.add(ip.rsplit(".", 1)[0] + ".255")  # most home networks are /24
        out.update(a["addr"] for a in self.conf["peers"].values() if a.get("addr"))
        out.update(self.conf["addresses"])
        return out

    async def scan(self, wait: float = 0.7):
        """Ask the network who's there. Concurrent callers share one scan; results last a moment."""
        if _now() - self._scanned < 2 and not self._scan:
            return
        if not self._scan:
            self._scan = asyncio.create_task(self._do_scan(wait))
        try:
            await asyncio.shield(self._scan)
        finally:
            if self._scan and self._scan.done():
                self._scan = None

    async def _do_scan(self, wait: float):
        found: dict[str, dict] = {}
        loop = asyncio.get_running_loop()
        try:
            transport, _ = await loop.create_datagram_endpoint(lambda: _Collector(self, found), local_addr=("0.0.0.0", 0), allow_broadcast=True)
        except OSError:
            return
        query = json.dumps({"app": "openwave", "q": 1, "engine": self.engine}).encode()
        try:
            for _ in range(2):  # UDP can drop a packet; asking twice costs nothing
                for target in self._targets():
                    with contextlib.suppress(OSError):
                        transport.sendto(query, (target, DISCOVERY_PORT))
                await asyncio.sleep(wait / 2)
        finally:
            transport.close()
        self.found.update(found)
        self._scanned = _now()
        for engine, f in found.items():
            peer = self.conf["peers"].get(engine)
            if peer and (peer.get("addr"), peer.get("port")) != (f["host"], f.get("port")):
                peer.update(addr=f["host"], port=f.get("port"), name=_text(f.get("name")))
                self._save()

    async def add_address(self, address: str) -> dict:
        """For networks where broadcasts don't get through: ask one address directly."""
        address = address.strip().removeprefix("http://").split("/")[0].split(":")[0]
        try:
            socket.inet_aton(address)
        except OSError:
            raise LinkError("Enter an address like 192.168.1.20") from None
        if address not in self.conf["addresses"]:
            self.conf["addresses"] = [*self.conf["addresses"], address][-10:]
            self._save()
        self._scanned = 0
        await self.scan(wait=1.2)
        if not any(f["host"] == address for f in self.found.values()):
            raise LinkError(f"No OpenWave found at {address}. Is it open there, with “Show this device on Wi-Fi” on?", 404)
        return {"ok": True}

    async def devices(self, pid: str) -> dict:
        me = self.player(pid)
        await self.scan()
        out = [
            {"key": f"{self.engine}/{p.id}", "name": p.name, "kind": p.kind, "hosting": p.hosting, "paired": True}
            for p in self.players.values() if p.id != me.id and p.online
        ]
        for engine, f in self.found.items():
            for p in f.get("players") or []:
                if isinstance(p, dict) and ID_RE.match(str(p.get("id", ""))):
                    out.append({
                        "key": f"{engine}/{p['id']}", "name": _text(p.get("name")) or _text(f.get("name")),
                        "kind": _text(p.get("kind"), 20), "hosting": bool(p.get("hosting")), "paired": engine in self.conf["peers"],
                    })
        return {"devices": out, "visible": self.visible, "address": lan_ip()}

    # ------------------------------------------------------------------ talking to other engines
    def _split(self, key: str) -> tuple[str, str]:
        engine, _, pid = str(key).partition("/")
        if not ID_RE.match(engine) or not ID_RE.match(pid):
            raise LinkError("unknown device")
        return engine, pid

    def _where(self, engine: str) -> tuple[str, int]:
        f = self.found.get(engine)
        if f and f.get("port"):
            return f["host"], int(f["port"])
        peer = self.conf["peers"].get(engine)
        if peer and peer.get("addr") and peer.get("port"):
            return peer["addr"], int(peer["port"])
        raise LinkError("That device isn’t on your Wi-Fi right now", 504)

    def _name_of(self, engine: str) -> str:
        return _text((self.found.get(engine) or {}).get("name") or (self.conf["peers"].get(engine) or {}).get("name")) or "that device"

    async def _call(self, engine: str, method: str, path: str, *, auth: bool = True, timeout: float = 8, retry: bool = True, **kw) -> dict:
        host, port = self._where(engine)
        headers = {"x-openwave-engine": self.engine}
        if auth:
            peer = self.conf["peers"].get(engine)
            if not peer or not peer.get("token"):
                raise LinkError("pair", 409, pair=True)
            headers["authorization"] = f"Bearer {peer['token']}"
        began = _now()
        try:
            r = await self.client.request(method, f"http://{host}:{port}{path}", headers=headers, timeout=timeout, **kw)
        except httpx.HTTPError:
            if retry:  # it may have moved to another address or port: look again once
                self.found.pop(engine, None)
                self._scanned = 0
                await self.scan()
                return await self._call(engine, method, path, auth=auth, timeout=timeout, retry=False, **kw)
            raise LinkError(f"Couldn’t reach {self._name_of(engine)}. Is it on the same Wi-Fi, with OpenWave open?", 504) from None
        if timeout <= 8:
            self.rtt[engine] = _now() - began if engine not in self.rtt else 0.7 * self.rtt[engine] + 0.3 * (_now() - began)
        try:
            body = r.json()
        except ValueError:
            body = {}
        if r.status_code == 401 and auth:
            self.conf["peers"].pop(engine, None)  # it no longer accepts this device: ask again
            self._save()
            raise LinkError("pair", 409, pair=True)
        if r.status_code >= 400:
            raise LinkError(_text(body.get("error"), 200) or f"{self._name_of(engine)} said no ({r.status_code})", r.status_code)
        return body

    def _from(self, pid: str) -> dict:
        p = self.player(pid)
        return {"name": p.name, "key": f"{self.engine}/{p.id}"}

    async def send(self, pid: str, target: str, cmd: dict):
        engine, other = self._split(target)
        if engine == self.engine:
            return self.deliver(other, cmd, self._from(pid))
        await self._call(engine, "POST", "/link/command", json={"player": other, "from": self._from(pid), "cmd": cmd})

    async def watch(self, pid: str, target: str, version: int, follow: bool) -> dict:
        me = self.player(pid)
        engine, other = self._split(target)
        member = f"{self.engine}/{me.id}"
        if engine == self.engine:
            return await self.watch_here(other, version, member, me.name, follow)
        r = await self._call(engine, "GET", "/link/watch", timeout=LONG_POLL + 10,
                             params={"player": other, "version": version, "follow": int(follow), "member": member, "name": me.name})
        me.seen = _now()
        if "age" in r:
            r["age"] = float(r["age"]) + self.rtt.get(engine, 0.02) / 2  # it took about half a round trip to get here
        return r

    async def join(self, pid: str, target: str):
        me = self.player(pid)
        engine, other = self._split(target)
        member = f"{self.engine}/{me.id}"
        if engine == self.engine:
            return self.join_here(other, member, me.name)
        await self._call(engine, "POST", "/link/join", json={"player": other, "member": member, "name": me.name})

    async def leave(self, pid: str, target: str):
        engine, other = self._split(target)
        member = f"{self.engine}/{pid}"
        if engine == self.engine:
            return self.leave_here(other, member)
        with contextlib.suppress(LinkError):
            await self._call(engine, "POST", "/link/leave", json={"player": other, "member": member}, retry=False)

    # ------------------------------------------------------------------ allowing devices
    async def pair(self, pid: str, target: str) -> dict:
        """Ask another device to let this one connect, and wait for someone to answer there."""
        me = self.player(pid)
        engine, _ = self._split(target)
        r = await self._call(engine, "POST", "/link/pair", auth=False, json={"engine": self.engine, "name": me.name})
        rid = r.get("request")
        deadline = _now() + 90
        while _now() < deadline:
            me.seen = _now()
            r = await self._call(engine, "GET", f"/link/pair/{rid}", auth=False, timeout=LONG_POLL + 10, params={"engine": self.engine})
            if r.get("status") == "allowed" and r.get("token"):
                host, port = self._where(engine)
                self.conf["peers"][engine] = {"name": self._name_of(engine), "token": r["token"], "addr": host, "port": port}
                self._save()
                return {"ok": True}
            if r.get("status") == "denied":
                raise LinkError(f"{self._name_of(engine)} didn’t allow this device", 403)
            if r.get("status") != "pending":
                break
        raise LinkError(f"No answer from {self._name_of(engine)}. Open OpenWave there and try again.", 408)

    def pair_request(self, engine: str, name: str) -> dict:
        if not ID_RE.match(str(engine)):
            raise LinkError("bad request")
        if not any(p.online for p in self.players.values()):
            raise LinkError("OpenWave isn’t open on that device", 409)
        pending = [r for r in self.pairs.values() if r["status"] == "pending"]
        if len(pending) >= 3 or any(r["engine"] == engine for r in pending):
            raise LinkError("Already waiting for an answer", 429)
        rid = secrets.token_urlsafe(16)
        self.pairs[rid] = {"engine": engine, "name": _text(name) or "A device", "status": "pending", "at": _now()}
        self.emit({"type": "pair", "request": rid, "name": self.pairs[rid]["name"]})
        return {"request": rid}

    async def pair_status(self, rid: str, engine: str) -> dict:
        deadline = _now() + LONG_POLL
        while True:
            r = self.pairs.get(rid)
            if not r or r["engine"] != engine:
                return {"status": "unknown"}
            if r["status"] != "pending" or _now() >= deadline:
                out = {"status": r["status"]}
                if r["status"] == "allowed":
                    out["token"] = r.pop("token", None)
                    del self.pairs[rid]
                return out
            await self._wait(deadline - _now())

    def answer(self, rid: str, allow: bool):
        r = self.pairs.get(rid)
        if not r or r["status"] != "pending":
            return
        if allow:
            token = secrets.token_urlsafe(24)
            r.update(status="allowed", token=token)
            self.conf["allowed"][r["engine"]] = {"name": r["name"], "hash": _hash(token), "since": int(time.time())}
            self._save()
        else:
            r["status"] = "denied"
        self.emit({"type": "pair-done", "request": rid, "allowed": allow})

    def forget(self, engine: str):
        self.conf["allowed"].pop(engine, None)
        self.conf["peers"].pop(engine, None)
        self._save()
        for p in self.players.values():  # it can't listen in any more either
            for key in [k for k in p.members if k.startswith(f"{engine}/")]:
                p.members.pop(key)
        self._wake()

    def check(self, request: Request) -> str:
        """The engine id of an allowed device making this request, or a 401."""
        engine = request.headers.get("x-openwave-engine", "")
        token = request.headers.get("authorization", "").removeprefix("Bearer ").strip()
        allowed = self.conf["allowed"].get(engine)
        if not allowed or not token or not hmac.compare_digest(allowed["hash"], _hash(token)):
            raise LinkError("This device isn’t allowed to connect", 401)
        return engine


def _bind(port: int) -> socket.socket | None:
    """A listening socket on every interface, or None if the port is taken."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if sys.platform != "win32":
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("0.0.0.0", port))
        s.listen(64)
        return s
    except OSError:
        s.close()
        return None


hub = Hub()


def _error(exc: LinkError) -> JSONResponse:
    return JSONResponse({"error": str(exc), **exc.extra}, status_code=exc.status)


async def _body(request: Request) -> dict:
    try:
        body = await request.json()
    except ValueError:
        body = None
    if not isinstance(body, dict):
        raise LinkError("expected a JSON object")
    return body


# ---------------------------------------------------------------------------- this device's pages
router = APIRouter(prefix="/api/link")


@router.post("/hello")
async def api_hello(request: Request):
    b = await _body(request)
    return hub.hello(str(b.get("player", "")), _text(b.get("name")), _text(b.get("kind"), 20))


@router.get("/settings")
async def api_settings(player: str):
    return hub.settings(player)


@router.post("/settings")
async def api_set(request: Request):
    b = await _body(request)
    pid = str(b.get("player", ""))
    if "name" in b:
        hub.rename(pid, b["name"])
    if "visible" in b:
        await hub.set_visible(bool(b["visible"]))
    if "forget" in b:
        hub.forget(str(b["forget"]))
    if "address" in b:
        await hub.add_address(str(b["address"]))
    return hub.settings(pid)


@router.get("/poll")
async def api_poll(player: str, cursor: int = -1):
    return await hub.poll(player, cursor)


@router.post("/state")
async def api_state(request: Request):
    b = await _body(request)
    hub.publish(str(b.get("player", "")), b.get("state"))
    return {"ok": True}


@router.get("/devices")
async def api_devices(player: str):
    return await hub.devices(player)


@router.post("/send")
async def api_send(request: Request):
    b = await _body(request)
    await hub.send(str(b.get("player", "")), str(b.get("target", "")), b.get("cmd"))
    return {"ok": True}


@router.get("/watch")
async def api_watch(player: str, target: str, version: int = -1, follow: bool = False):
    return await hub.watch(player, target, version, follow)


@router.post("/pair")
async def api_pair(request: Request):
    b = await _body(request)
    return await hub.pair(str(b.get("player", "")), str(b.get("target", "")))


@router.post("/answer")
async def api_answer(request: Request):
    b = await _body(request)
    hub.answer(str(b.get("request", "")), bool(b.get("allow")))
    return {"ok": True}


@router.post("/host")
async def api_host(request: Request):
    b = await _body(request)
    pid = str(b.get("player", ""))
    on = bool(b.get("on"))
    if on and not hub.visible:
        await hub.set_visible(True)  # guests have to be able to find this device
    return hub.host(pid, on)


@router.get("/members")
async def api_members(player: str):
    return {"members": hub.members(player)}


@router.post("/join")
async def api_join(request: Request):
    b = await _body(request)
    await hub.join(str(b.get("player", "")), str(b.get("target", "")))
    return {"ok": True}


@router.post("/leave")
async def api_leave(request: Request):
    b = await _body(request)
    await hub.leave(str(b.get("player", "")), str(b.get("target", "")))
    return {"ok": True}


# ---------------------------------------------------------------------------- other devices (LAN)
lan = APIRouter(prefix="/link")


@lan.get("/info")
async def lan_info():
    return hub.announcement()


@lan.post("/pair")
async def lan_pair(request: Request):
    b = await _body(request)
    return hub.pair_request(str(b.get("engine", "")), _text(b.get("name")))


@lan.get("/pair/{rid}")
async def lan_pair_status(rid: str, engine: str):
    return await hub.pair_status(rid, engine)


@lan.post("/command")
async def lan_command(request: Request):
    hub.check(request)
    b = await _body(request)
    sender = b.get("from") if isinstance(b.get("from"), dict) else {}
    hub.deliver(str(b.get("player", "")), b.get("cmd"), sender)
    return {"ok": True}


@lan.get("/watch")
async def lan_watch(request: Request, player: str, version: int = -1, follow: bool = False, member: str = "", name: str = ""):
    engine = hub.check(request)
    if follow and not member.startswith(f"{engine}/"):
        raise LinkError("bad member")
    return await hub.watch_here(player, version, member or None, name, follow)


@lan.post("/join")
async def lan_join(request: Request):
    engine = hub.check(request)
    b = await _body(request)
    member = str(b.get("member", ""))
    if not member.startswith(f"{engine}/"):
        raise LinkError("bad member")
    hub.join_here(str(b.get("player", "")), member, _text(b.get("name")))
    return {"ok": True}


@lan.post("/leave")
async def lan_leave(request: Request):
    engine = hub.check(request)
    b = await _body(request)
    member = str(b.get("member", ""))
    if member.startswith(f"{engine}/"):
        hub.leave_here(str(b.get("player", "")), member)
    return {"ok": True}


_lan_app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
_lan_app.include_router(lan)
_lan_app.add_exception_handler(LinkError, lambda _req, exc: _error(exc))


async def lan_app(scope, receive, send):
    """What other devices can reach: only /link/*, and only small requests."""
    if scope["type"] == "http":
        headers = dict(scope.get("headers") or [])
        length = headers.get(b"content-length", b"0")
        too_big = b"transfer-encoding" in headers or not length.isdigit() or int(length) > MAX_BODY
        if not scope["path"].startswith("/link/") or too_big:
            status = 413 if too_big else 404
            await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"not here"})
            return
    await _lan_app(scope, receive, send)
