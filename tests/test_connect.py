"""OpenWave Connect: pairing, the encrypted offer/answer exchange, and real WebRTC connections.

The end-to-end tests run a phone (aiortc, as a browser would use WebRTC) and an engine in one
process; they only meet through a private relay (tests/fake_relay.py), as they would over the
internet, and talk over a real data channel.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import secrets
import time

import pytest

pytest.importorskip("cryptography")
pytest.importorskip("pylibsrtp")
pytest.importorskip("aioice")

from fastapi.testclient import TestClient  # noqa: E402

from openwave import _nomedia, api_connect, app, connect, nostr, shared  # noqa: E402
from openwave.api_library import use_library  # noqa: E402
from openwave.library import Library  # noqa: E402

try:
    import fake_relay
    import websockets
except ImportError:  # the Android engine's test run has no websockets package
    fake_relay = None
needs_relay = pytest.mark.skipif(fake_relay is None, reason="needs the websockets package")

IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1"


def payload(link: str) -> dict:
    raw = link.split("#connect=", 1)[1]
    return json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))


def test_seal_only_opens_with_the_same_key_and_purpose():
    key = os.urandom(32)
    blob = connect.seal(key, {"t": "offer", "x": 1}, "offer:room")
    assert connect.unseal(key, blob, "offer:room") == {"t": "offer", "x": 1}
    assert connect.unseal(os.urandom(32), blob, "offer:room") is None      # someone else's phone
    assert connect.unseal(key, blob, "answer:room") is None                # replayed as an answer
    raw = bytearray(base64.b64decode(blob))
    raw[20] ^= 1
    assert connect.unseal(key, base64.b64encode(bytes(raw)).decode(), "offer:room") is None
    assert connect.unseal(key, "not base64!", "offer:room") is None


def test_pairing_link_carries_the_engine_key_and_only_unusual_relays(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENWAVE_CONNECT_APP", raising=False)
    h = connect.Host(None, tmp_path / "connect.json", shared.DEFAULT_RELAYS, name="Studio Mac")
    p = h.pair()
    assert p["link"].startswith(connect.WEB_APP + "#connect=")
    body = payload(p["link"])
    assert body["v"] == 1 and body["h"] == h.pub and body["n"] == "Studio Mac" and "r" not in body
    assert len(base64.urlsafe_b64decode(body["k"] + "==")) == 32
    other = connect.Host(None, tmp_path / "other.json", ["wss://relay.example"])
    assert payload(other.pair()["link"])["r"] == ["wss://relay.example"]
    monkeypatch.setenv("OPENWAVE_CONNECT_APP", "https://example.org/app/")
    assert other.pair()["link"].startswith("https://example.org/app/#connect=")


def test_identity_survives_a_restart_and_pairing_codes_expire(tmp_path, monkeypatch):
    h = connect.Host(None, tmp_path / "connect.json", ["wss://r"])
    p = h.pair()
    h2 = connect.Host(None, tmp_path / "connect.json", ["wss://r"])
    assert h2.pub == h.pub
    assert [t["id"] for t in h2.status()["tickets"]] == [p["id"]] and h2.status()["devices"] == []
    now = time.time()
    monkeypatch.setattr(connect.time, "time", lambda: now + connect.PAIR_TTL + 5)
    assert h2.status()["tickets"] == []
    assert json.loads((tmp_path / "connect.json").read_text())["tickets"] == {}


def test_phone_and_engine_agree_on_a_key_they_never_send():
    engine, phone = nostr.new_secret(), nostr.new_secret()
    assert connect.device_key(engine, nostr.public_key(phone)) == hashlib.sha256(
        b"openwave-connect-device" + nostr.shared_secret(phone, nostr.public_key(engine))).digest()


def test_offers_need_a_live_ticket_or_a_paired_key_a_fresh_timestamp_and_a_new_session(tmp_path, monkeypatch):
    h = connect.Host(None, tmp_path / "connect.json", ["wss://r"])
    ticket = base64.urlsafe_b64decode(payload(h.pair()["link"])["k"] + "==")
    answered = []
    h._spawn = lambda coro: (answered.append(coro.cr_frame.f_locals["dev"]), coro.close())
    phone = nostr.new_secret()

    def offer(k=ticket, ts=None, session=None, aad=None, kind="enroll", pub=None):
        body = {"t": kind, "s": session or secrets.token_urlsafe(16), "sdp": "v=0", "ts": ts or int(time.time() * 1000),
                "pub": pub or nostr.public_key(phone), "ua": IPHONE}
        ev = nostr.make_event(nostr.new_secret(), connect.KIND, [["t", h.room]], connect.seal(k, body, aad or "offer:" + h.room))
        asyncio.run(h._on_event(ev, "wss://r"))
        return body["s"]

    first = offer()
    dev = answered[0]
    assert h.state["devices"][dev]["label"] == "iPhone" and h.state["devices"][dev]["pub"] == nostr.public_key(phone)
    offer(k=os.urandom(32))                                   # a stranger
    offer(ts=int((time.time() - 600) * 1000))                 # an old offer someone recorded
    offer(session=first)                                      # the same offer again
    offer(aad="offer:" + "0" * 40)                            # meant for another engine
    offer(kind="offer")                                       # a ticket can only pair
    offer(pub="ab" * 32 if nostr._lift_x(int("ab" * 32, 16)) is None else "00" * 32)   # not a key
    assert answered == [dev]

    mine = connect.device_key(h.state["secret"], nostr.public_key(phone))
    offer(k=mine, kind="offer")                               # the phone's own key works
    offer(k=mine, kind="enroll")                              # but only for connecting
    assert answered == [dev, dev]
    offer()                                                   # pairing again changes nothing
    assert answered == [dev, dev, dev] and len(h.state["devices"]) == 1

    now = time.time()
    monkeypatch.setattr(connect.time, "time", lambda: now + connect.PAIR_TTL + 5)
    later = nostr.new_secret()
    offer(pub=nostr.public_key(later), ts=int((now + connect.PAIR_TTL + 5) * 1000))   # a photo of the QR code, later
    assert answered == [dev, dev, dev]
    offer(k=mine, kind="offer", ts=int((now + connect.PAIR_TTL + 5) * 1000))          # the paired phone still works
    assert answered == [dev, dev, dev, dev]


def test_a_retry_loop_is_cut_off(tmp_path):
    h = connect.Host(None, tmp_path / "connect.json", ["wss://r"])
    ticket = base64.urlsafe_b64decode(payload(h.pair()["link"])["k"] + "==")
    answered = []
    h._spawn = lambda coro: (answered.append(1), coro.close())
    pub = nostr.public_key(nostr.new_secret())
    for _ in range(20):
        body = {"t": "enroll", "s": secrets.token_urlsafe(16), "sdp": "v=0", "ts": int(time.time() * 1000), "pub": pub}
        ev = nostr.make_event(nostr.new_secret(), connect.KIND, [["t", h.room]], connect.seal(ticket, body, "offer:" + h.room))
        asyncio.run(h._on_event(ev, "wss://r"))
    assert len(answered) == 12


def test_one_code_pairs_a_few_phones_at_most(tmp_path):
    h = connect.Host(None, tmp_path / "connect.json", ["wss://r"])
    tid = h.pair()["id"]
    devs = [h._enroll(tid, nostr.public_key(nostr.new_secret()), IPHONE) for _ in range(connect.MAX_PER_TICKET + 2)]
    assert all(devs[:connect.MAX_PER_TICKET]) and devs[connect.MAX_PER_TICKET:] == [None, None]


def test_device_names_come_from_the_phone():
    assert connect.device_label(IPHONE) == "iPhone"
    assert connect.device_label("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)") == "iPad"
    assert connect.device_label("Mozilla/5.0 (Linux; Android 15; Pixel 9)") == "Android phone"
    assert connect.device_label("") == "Phone"


def test_settings_api(tmp_path, monkeypatch):
    use_library(Library(tmp_path / "lib.db"))
    api_connect.use_host(None)
    with TestClient(app.app) as c:
        off = c.get("/api/connect").json()
        assert off["available"] is False and "OPENWAVE_RELAYS" in off["reason"]
        assert c.post("/api/connect/pair").status_code == 409
        h = connect.Host(app.app, tmp_path / "connect.json", ["wss://r"], name="Den PC")
        api_connect.use_host(h)
        p = c.post("/api/connect/pair").json()
        st = c.get("/api/connect").json()
        assert st["available"] and st["name"] == "Den PC" and st["tickets"][0]["id"] == p["id"]
        dev = h._enroll(p["id"], nostr.public_key(nostr.new_secret()), IPHONE)
        assert c.get("/api/connect").json()["devices"][0]["id"] == dev
        assert c.post(f"/api/connect/devices/{dev}/remove").json() == {"ok": True}
        assert c.post(f"/api/connect/devices/{dev}/remove").status_code == 404
        assert c.get("/api/health").json()["api"] == connect.API
    api_connect.use_host(None)


# --------------------------------------------------------------------------- end to end


class Phone:
    """What the web app does (web/js/connect.js), with aiortc instead of a browser."""

    def __init__(self, pc, ch):
        self.pc, self.ch = pc, ch
        self.seq = 0
        self.pending: dict[int, dict] = {}
        self.closed = asyncio.Event()
        ch.on("message", self._message)
        ch.on("close", self.closed.set)

    @classmethod
    async def pair(cls, link: str, relay: str, secret: str | None = None, ua: str = IPHONE, timeout: float = 20):
        """Pair with the link's ticket (no `secret` yet), or connect with this phone's own key."""
        _nomedia.install()
        from openwave._vendor.aiortc import RTCPeerConnection, RTCSessionDescription
        p = payload(link)
        enroll = secret is None
        secret = secret or nostr.new_secret()
        key = base64.urlsafe_b64decode(p["k"] + "==") if enroll else hashlib.sha256(
            b"openwave-connect-device" + nostr.shared_secret(secret, p["h"])).digest()
        pc = RTCPeerConnection()
        ch = pc.createDataChannel("openwave")
        opened = asyncio.Event()
        ch.on("open", opened.set)
        await pc.setLocalDescription(await pc.createOffer())
        session = secrets.token_urlsafe(16)
        room, reply = connect.room_of(p["h"]), connect.reply_room(session)
        body = {"t": "enroll" if enroll else "offer", "s": session, "sdp": pc.localDescription.sdp, "ts": int(time.time() * 1000), "ua": ua}
        if enroll:
            body["pub"] = nostr.public_key(secret)
        ev = nostr.make_event(nostr.new_secret(), connect.KIND, [["t", room]], connect.seal(key, body, "offer:" + room))

        async def exchange():
            async with websockets.connect(relay) as ws:
                await ws.send(json.dumps(["REQ", "a", {"kinds": [connect.KIND], "#t": [reply]}]))
                await ws.send(json.dumps(["EVENT", ev]))
                while True:
                    msg = json.loads(await ws.recv())
                    if msg[0] == "EVENT":
                        a = connect.unseal(key, msg[2]["content"], "answer:" + reply)
                        if a and a.get("t") == "answer" and a.get("s") == session:
                            return a

        answer = await asyncio.wait_for(exchange(), timeout)
        assert answer["api"] == connect.API
        await pc.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type="answer"))
        await asyncio.wait_for(opened.wait(), timeout)
        phone = cls(pc, ch)
        phone.secret, phone.device = secret, answer["d"]
        return phone

    def _message(self, data) -> None:
        if isinstance(data, str):
            m = json.loads(data)
            r = self.pending.get(m["i"])
            if r is None:
                return
            if "s" in m:
                r.update(status=m["s"], headers=m["h"])
            elif m.get("end") or m.get("pong"):
                r["done"].set()
            elif "err" in m:
                r.update(error=m["err"])
                r["done"].set()
        else:
            r = self.pending.get(int.from_bytes(data[:4], "big"))
            if r is not None:
                r["body"] += data[4:]

    async def request(self, path: str, method: str = "GET", headers: dict | None = None, body=None, timeout: float = 20) -> dict:
        self.seq += 1
        r = self.pending[self.seq] = {"done": asyncio.Event(), "body": b"", "status": None}
        self.ch.send(json.dumps({"i": self.seq, "m": method, "p": path, "h": headers or {}, "b": None if body is None else json.dumps(body)}))
        await asyncio.wait_for(r["done"].wait(), timeout)
        return r

    async def close(self) -> None:
        await self.pc.close()


def big_app(size: int):
    """A tiny ASGI app that streams `size` known bytes in uneven pieces."""
    data = bytes((i * 7 + 3) % 251 for i in range(size))

    async def asgi(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [(b"content-type", b"audio/mp4"), (b"x-secret", b"1")]})
        for i in range(0, size, 50_000):
            await send({"type": "http.response.body", "body": data[i:i + 50_000], "more_body": True})
        await send({"type": "http.response.body", "body": b""})
    return asgi, data


@needs_relay
def test_a_paired_phone_uses_the_engine_through_a_relay(tmp_path):
    async def scenario():
        relay = await fake_relay.FakeRelay().start()
        use_library(Library(tmp_path / "lib.db"))
        h = connect.Host(app.app, tmp_path / "connect.json", [relay.url], name="Home Mac", stun=[])
        await h.start()
        try:
            link = h.pair()["link"]
            phone = await Phone.pair(link, relay.url)
            st = h.status()["devices"][0]
            assert st["label"] == "iPhone" and st["online"] and st["id"] == phone.device

            health = await phone.request("/api/health")
            assert health["status"] == 200 and json.loads(health["body"])["api"] == connect.API

            made = await phone.request("/api/profiles", "POST", {"content-type": "application/json", "user-agent": IPHONE}, {"name": "Maya"})
            assert made["status"] == 200, made
            token = json.loads(made["body"])["token"]
            ops = [{"op": "like", "track": {"videoId": "dQw4w9WgXcQ", "title": "Song", "artists": [{"name": "A"}]}}]
            saved = await phone.request("/api/me/ops", "POST", {"authorization": f"Bearer {token}", "content-type": "application/json"}, {"ops": ops})
            assert saved["status"] == 200, saved
            lib = await phone.request("/api/me/library", headers={"authorization": f"Bearer {token}"})
            assert [t["videoId"] for t in json.loads(lib["body"])["liked"]] == ["dQw4w9WgXcQ"]
            assert (await phone.request("/api/me/library"))["status"] == 401            # same rules as at home

            refused = await phone.request("/api/connect/pair", "POST")
            assert refused["status"] == 403                                         # phones can't pair more phones
            assert (await phone.request("/index.html"))["status"] == 404            # only the API

            # Later connections use the phone's own key, not the pairing code.
            again = await Phone.pair(link, relay.url, secret=phone.secret)
            assert again.device == phone.device and len(h.status()["devices"]) == 1
            assert (await again.request("/api/health"))["status"] == 200
            await phone.close()
            await again.close()
        finally:
            await h.stop()
            await relay.stop()

    asyncio.run(scenario())


@needs_relay
def test_large_answers_arrive_intact_and_removal_disconnects(tmp_path):
    async def scenario():
        relay = await fake_relay.FakeRelay().start()
        asgi, data = big_app(3_000_000)
        h = connect.Host(asgi, tmp_path / "connect.json", [relay.url], stun=[])
        await h.start()
        try:
            p = h.pair()
            phone = await Phone.pair(p["link"], relay.url)
            got = await asyncio.gather(*(phone.request("/api/download/x") for _ in range(3)))
            for r in got:
                assert r["status"] == 200 and r["body"] == data
                assert r["headers"] == {"content-type": "audio/mp4"}                # nothing else leaks through

            await h.remove(phone.device)
            await asyncio.wait_for(phone.closed.wait(), 10)
            with pytest.raises((asyncio.TimeoutError, TimeoutError)):
                await Phone.pair(p["link"], relay.url, secret=phone.secret, timeout=3)   # its key no longer works
        finally:
            await h.stop()
            await relay.stop()

    asyncio.run(scenario())


@needs_relay
def test_an_unused_pairing_code_stops_working(tmp_path, monkeypatch):
    async def scenario():
        relay = await fake_relay.FakeRelay().start()
        asgi, _ = big_app(10)
        h = connect.Host(asgi, tmp_path / "connect.json", [relay.url], stun=[])
        await h.start()
        try:
            link = h.pair()["link"]
            h.state["tickets"][next(iter(h.state["tickets"]))]["created"] -= connect.PAIR_TTL + 1
            with pytest.raises((asyncio.TimeoutError, TimeoutError)):
                await Phone.pair(link, relay.url, timeout=3)
        finally:
            await h.stop()
            await relay.stop()

    asyncio.run(scenario())
