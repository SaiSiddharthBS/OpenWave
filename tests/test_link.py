"""Devices on the same Wi-Fi (openwave/link.py): players, commands, state, sessions and allowing devices."""

import asyncio

import pytest
from fastapi.testclient import TestClient

from openwave import app, link


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENWAVE_DATA", str(tmp_path))
    monkeypatch.delenv("OPENWAVE_LINK", raising=False)
    hub = link.Hub()

    async def no_network(*_a, **_k):
        pass

    hub.scan = no_network  # don't find whatever else is running on this network
    monkeypatch.setattr(link, "hub", hub)
    with TestClient(app.app) as c:
        yield c


def hello(c, pid, name="", kind="computer"):
    r = c.post("/api/link/hello", json={"player": pid, "name": name, "kind": kind})
    assert r.status_code == 200, r.text
    return r.json()


def test_players_on_one_engine_see_and_control_each_other(client):
    me = hello(client, "phone-player-1", "Chrome on Android", "phone")
    hello(client, "laptop-player-1", "Firefox on Linux")
    assert me["visible"] is False  # hidden unless the app or the user turns it on

    devices = client.get("/api/link/devices", params={"player": "phone-player-1"}).json()["devices"]
    assert [d["name"] for d in devices] == ["Firefox on Linux"]
    key = devices[0]["key"]

    cursor = client.get("/api/link/poll", params={"player": "laptop-player-1"}).json()["cursor"]
    r = client.post("/api/link/send", json={"player": "phone-player-1", "target": key, "cmd": {"cmd": "seek", "t": 42}})
    assert r.status_code == 200
    events = client.get("/api/link/poll", params={"player": "laptop-player-1", "cursor": cursor}).json()["events"]
    assert events == [{"type": "command", "cmd": {"cmd": "seek", "t": 42}, "from": {"name": "Chrome on Android", "key": f"{me['engine']}/phone-player-1"}}]

    bad = client.post("/api/link/send", json={"player": "phone-player-1", "target": key, "cmd": {"cmd": "rm -rf"}})
    assert bad.status_code == 400


def test_state_is_shared_with_how_old_it_is(client):
    me = hello(client, "phone-player-1")
    hello(client, "laptop-player-1")
    key = f"{me['engine']}/laptop-player-1"
    client.post("/api/link/state", json={"player": "laptop-player-1", "state": {"position": 12.5, "playing": True}})
    w = client.get("/api/link/watch", params={"player": "phone-player-1", "target": key}).json()
    assert w["state"] == {"position": 12.5, "playing": True}
    assert 0 <= w["age"] < 5 and w["version"] == 1


def test_listening_session(client):
    me = hello(client, "guest-player-1", "Guest")
    hello(client, "host-player-1", "Host")
    key = f"{me['engine']}/host-player-1"

    assert client.post("/api/link/join", json={"player": "guest-player-1", "target": key}).status_code == 404  # not hosting yet
    assert client.post("/api/link/host", json={"player": "host-player-1", "on": True}).json()["hosting"] is True
    assert link.hub.visible  # a host has to be findable

    cursor = client.get("/api/link/poll", params={"player": "host-player-1"}).json()["cursor"]
    assert client.post("/api/link/join", json={"player": "guest-player-1", "target": key}).status_code == 200
    events = client.get("/api/link/poll", params={"player": "host-player-1", "cursor": cursor}).json()["events"]
    assert events[0]["joined"] == "Guest" and events[0]["members"] == ["Guest"]

    w = client.get("/api/link/watch", params={"player": "guest-player-1", "target": key, "follow": True}).json()
    assert w["hosting"] is True
    client.post("/api/link/host", json={"player": "host-player-1", "on": False})
    w = client.get("/api/link/watch", params={"player": "guest-player-1", "target": key, "follow": True, "version": w["version"]}).json()
    assert w == {"ended": True}


def test_a_device_must_be_allowed_before_it_can_control(client):
    hello(client, "mac-player-1", "Mac")
    hub = link.hub
    cursor = client.get("/api/link/poll", params={"player": "mac-player-1"}).json()["cursor"]

    rid = hub.pair_request("otherEngine1", "Rahul’s Pixel")["request"]
    events = client.get("/api/link/poll", params={"player": "mac-player-1", "cursor": cursor}).json()["events"]
    assert events == [{"type": "pair", "request": rid, "name": "Rahul’s Pixel"}]
    with pytest.raises(link.LinkError):
        hub.pair_request("otherEngine1", "again")  # one question at a time

    client.post("/api/link/answer", json={"request": rid, "allow": True})
    status = asyncio.run(hub.pair_status(rid, "otherEngine1"))
    assert status["status"] == "allowed" and status["token"]
    assert asyncio.run(hub.pair_status(rid, "otherEngine1")) == {"status": "unknown"}  # the token is handed out once

    lan = TestClient(link.lan_app)
    command = {"player": "mac-player-1", "from": {"name": "Rahul’s Pixel"}, "cmd": {"cmd": "pause"}}
    assert lan.post("/link/command", json=command).status_code == 401
    wrong = {"x-openwave-engine": "otherEngine1", "authorization": "Bearer nope"}
    assert lan.post("/link/command", json=command, headers=wrong).status_code == 401
    right = {"x-openwave-engine": "otherEngine1", "authorization": f"Bearer {status['token']}"}
    assert lan.post("/link/command", json=command, headers=right).status_code == 200

    names = [a["name"] for a in client.get("/api/link/settings", params={"player": "mac-player-1"}).json()["allowed"]]
    assert names == ["Rahul’s Pixel"]
    client.post("/api/link/settings", json={"player": "mac-player-1", "forget": "otherEngine1"})
    assert lan.post("/link/command", json=command, headers=right).status_code == 401


def test_other_devices_only_reach_the_link_routes(client):
    lan = TestClient(link.lan_app)
    assert lan.get("/api/health").status_code == 404
    assert lan.get("/api/me/library").status_code == 404
    assert lan.get("/").status_code == 404
    assert lan.get("/link/info").json()["app"] == "openwave"
    assert lan.post("/link/pair", content=b"x" * 10, headers={"content-length": "2000000"}).status_code == 413


def test_no_open_app_means_no_prompt(client):
    with pytest.raises(link.LinkError) as e:
        link.hub.pair_request("otherEngine1", "Phone")
    assert e.value.status == 409
