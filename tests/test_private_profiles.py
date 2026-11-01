"""Settings → Profile → Only on this phone: a profile kept on one paired phone isn't listed on, and
can't be opened from, anything else, and is never locked away when that phone goes."""

from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from openwave import api_connect, app, connect, nostr
from openwave.api_library import use_library
from openwave.library import RELEASED, Library, LibraryError

IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1"


@pytest.fixture
def lib(tmp_path):
    lib = Library(tmp_path / "lib.db")
    use_library(lib)
    return lib


def as_phone(dev: str):
    """The engine as a request over a paired phone's own connection sees it (connect.py sets this)."""
    async def asgi(scope, receive, send):
        await app.app({**scope, "openwave.connect": dev}, receive, send)
    return TestClient(asgi)


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def names(rows) -> list[str]:
    return [p["name"] for p in rows]


def test_only_its_phone_lists_and_opens_it(lib):
    lib.create_profile("Dad")
    mom = lib.create_profile("Mom", viewer="phone1", private=True)
    assert mom["profile"]["private"] is True
    assert names(lib.profiles()) == ["Dad"]                      # the computer, home Wi-Fi, Tailscale
    assert names(lib.profiles("phone2")) == ["Dad"]              # someone else's phone
    assert names(lib.profiles("phone1")) == ["Dad", "Mom"]
    pid = mom["profile"]["id"]
    for viewer in (None, "phone2"):
        with pytest.raises(LibraryError) as e:
            lib.login(pid, viewer=viewer)
        assert e.value.status == 404
    assert lib.authenticate(lib.login(pid, viewer="phone1")["token"], "phone1") == pid


def test_a_copied_sign_in_is_useless_elsewhere(lib):
    token = lib.create_profile("Mom", viewer="phone1", private=True)["token"]
    for viewer in (None, "phone2"):
        with pytest.raises(LibraryError) as e:
            lib.authenticate(token, viewer)
        assert e.value.status == 401
    with pytest.raises(LibraryError):                            # and it's gone now, not just refused
        lib.authenticate(token, "phone1")


def test_keeping_it_signs_out_everywhere_else(lib):
    at_pc = lib.create_profile("Mom")
    pid = at_pc["profile"]["id"]
    on_phone = lib.login(pid, viewer="phone1")["token"]
    on_other = lib.login(pid, viewer="phone2")["token"]
    assert lib.update_profile(pid, private=True, viewer="phone1", token=on_phone)["private"] is True
    assert lib.snapshot(pid)["profile"]["private"] is True        # what the phone's Settings shows after a sync
    assert lib.authenticate(on_phone, "phone1") == pid
    for token, viewer in ((at_pc["token"], None), (on_other, "phone2")):
        with pytest.raises(LibraryError):
            lib.authenticate(token, viewer)
    # Renaming it still works (it isn't in the computer's list, but it's still a profile).
    assert lib.update_profile(pid, name="Amma", viewer="phone1", token=on_phone)["name"] == "Amma"
    # Its phone opens it to everyone again.
    assert lib.update_profile(pid, private=False, viewer="phone1", token=on_phone)["private"] is False
    assert names(lib.profiles()) == ["Amma"]


def test_only_a_paired_phone_can_keep_one(lib):
    with pytest.raises(LibraryError):
        lib.create_profile("Mom", private=True)
    made = lib.create_profile("Mom")
    with pytest.raises(LibraryError):
        lib.update_profile(made["profile"]["id"], private=True, token=made["token"])
    assert names(lib.profiles()) == ["Mom"]


def test_never_locked_away(lib):
    mom = lib.create_profile("Mom", viewer="phone1", private=True)["profile"]["id"]
    lib.create_profile("Sis", viewer="phone2", private=True)
    assert lib.private_devices() == {"phone1": ["Mom"], "phone2": ["Sis"]}
    assert lib.release_phones("phone1") == ["Mom"]               # removed in Settings → Phones, or Forget
    assert names(lib.profiles()) == ["Mom"]
    token = lib.login(mom)["token"]
    assert lib.snapshot(mom)["notices"] == [RELEASED]            # and Mom is told why
    assert lib.authenticate(token) == mom
    assert lib.release_phones(keep={"phone9"}) == ["Sis"]        # a phone the engine no longer knows
    assert lib.private_devices() == {}
    assert lib.release_phones(keep=set()) == []


def test_deleting_it_leaves_nothing_behind(lib):
    made = lib.create_profile("Mom", viewer="phone1", private=True)
    lib.delete_profile(made["profile"]["id"])
    assert lib.private_devices() == {} and lib.profiles("phone1") == []


def test_api(lib):
    with TestClient(app.app) as pc:
        phone, other = as_phone("phone1"), as_phone("phone2")
        assert pc.post("/api/profiles", json={"name": "Mom", "private": True}).status_code == 400
        made = phone.post("/api/profiles", json={"name": "Mom", "private": True}).json()
        pid, token = made["profile"]["id"], made["token"]
        assert made["profile"]["private"] is True
        assert pc.get("/api/profiles").json() == [] and other.get("/api/profiles").json() == []
        assert names(phone.get("/api/profiles").json()) == ["Mom"]
        assert pc.post(f"/api/profiles/{pid}/login", json={}).status_code == 404
        assert other.post(f"/api/profiles/{pid}/login", json={}).status_code == 404
        assert pc.get("/api/me/library", headers=bearer(token)).status_code == 401
        assert phone.get("/api/me/library", headers=bearer(token)).status_code == 401   # that copy was revoked
        token = phone.post(f"/api/profiles/{pid}/login", json={}).json()["token"]
        assert phone.get("/api/me/library", headers=bearer(token)).status_code == 200
        assert phone.patch("/api/me", json={"private": False}, headers=bearer(token)).json()["private"] is False
        assert names(pc.get("/api/profiles").json()) == ["Mom"]
        pc_token = pc.post(f"/api/profiles/{pid}/login", json={}).json()["token"]
        assert pc.patch("/api/me", json={"private": True}, headers=bearer(pc_token)).status_code == 400
        assert phone.patch("/api/me", json={"private": True}, headers=bearer(token)).json()["private"] is True
        assert pc.get("/api/me/library", headers=bearer(pc_token)).status_code == 401


def test_the_computer_sees_whose_profile_a_phone_keeps_and_removing_it_opens_it(lib, tmp_path):
    api_connect.use_host(None)
    try:
        with TestClient(app.app) as pc:
            h = connect.Host(app.app, tmp_path / "connect.json", ["wss://r"], name="Den PC")
            api_connect.use_host(h)
            dev = h._enroll(h.pair()["id"], nostr.public_key(nostr.new_secret()), IPHONE)
            made = as_phone(dev).post("/api/profiles", json={"name": "Mom", "private": True}).json()
            assert pc.get("/api/connect").json()["devices"][0]["profiles"] == ["Mom"]
            seen_by_phone = as_phone(dev).get("/api/connect").json()
            assert seen_by_phone == {"available": True, "via": True, "name": "Den PC"}   # not the other phones
            assert pc.post(f"/api/connect/devices/{dev}/remove").json() == {"ok": True}
            assert names(pc.get("/api/profiles").json()) == ["Mom"]
            assert lib.snapshot(made["profile"]["id"])["notices"] == [RELEASED]
    finally:
        api_connect.use_host(None)


def test_a_reset_pairing_file_opens_them_at_start(lib, tmp_path, monkeypatch):
    lib.create_profile("Mom", viewer="gone-phone", private=True)
    h = connect.Host(app.app, tmp_path / "connect.json", ["wss://r"])
    monkeypatch.setattr(h, "start", lambda: asyncio.sleep(0))
    api_connect.use_host(h)
    try:
        with TestClient(app.app) as pc:
            assert names(pc.get("/api/profiles").json()) == ["Mom"]
    finally:
        api_connect.use_host(None)


def test_over_a_real_phone_connection(tmp_path):
    """The same rules through WebRTC, where the engine itself tags each request with the phone."""
    tc = pytest.importorskip("test_connect")
    if tc.fake_relay is None:
        pytest.skip("needs the websockets package")
    fake_relay, Phone = tc.fake_relay, tc.Phone

    async def scenario():
        relay = await fake_relay.FakeRelay().start()
        lib = Library(tmp_path / "lib.db")
        use_library(lib)
        h = connect.Host(app.app, tmp_path / "connect.json", [relay.url], name="Home PC", stun=[])
        await h.start()
        try:
            link = h.pair()["link"]
            mom, sis = await Phone.pair(link, relay.url), await Phone.pair(link, relay.url)
            js = {"content-type": "application/json"}
            made = await mom.request("/api/profiles", "POST", js, {"name": "Mom", "private": True})
            assert made["status"] == 200, made
            assert json.loads((await sis.request("/api/profiles"))["body"]) == []
            assert names(json.loads((await mom.request("/api/profiles"))["body"])) == ["Mom"]
            stolen = {"authorization": f"Bearer {json.loads(made['body'])['token']}"}
            assert (await sis.request("/api/me/library", headers=stolen))["status"] == 401
            assert lib.profiles() == []
            await mom.close()
            await sis.close()
        finally:
            await h.stop()
            await relay.stop()

    asyncio.run(scenario())
