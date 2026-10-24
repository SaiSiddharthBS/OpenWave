"""Profiles, sync ops, snapshots and insights against a throwaway database."""

import pytest
from fastapi.testclient import TestClient

from openwave import api_library, app
from openwave.library import Library


def T(vid, title="Song", artist="Artist", aid="UC1"):
    return {"type": "song", "videoId": vid, "title": title, "artists": [{"name": artist, "id": aid}],
            "album": None, "duration": 200, "thumbnail": "https://i.ytimg.com/x.jpg", "explicit": False}


@pytest.fixture
def client(tmp_path):
    api_library.use_library(Library(tmp_path / "t.db"))
    with TestClient(app.app) as c:
        yield c


def new_profile(c, name="Sai", pin=None):
    r = c.post("/api/profiles", json={"name": name, "pin": pin})
    assert r.status_code == 200, r.text
    return r.json()["token"], {"Authorization": f"Bearer {r.json()['token']}"}


def ops(c, h, *items):
    r = c.post("/api/me/ops", json={"ops": list(items)}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()["version"]


def test_requires_profile(client):
    assert client.get("/api/me/library").status_code == 401
    assert client.get("/api/me/library", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_likes_playlists_saves_round_trip(client):
    _, h = new_profile(client)
    v1 = ops(client, h, {"op": "like", "track": T("aaaaaaaaaaa", "One")}, {"op": "like", "track": T("bbbbbbbbbbb", "Two")})
    v2 = ops(client, h,
             {"op": "playlist.create", "id": "pl1", "name": "Road trip", "tracks": [T("aaaaaaaaaaa"), T("ccccccccccc")]},
             {"op": "playlist.add", "id": "pl1", "tracks": [T("aaaaaaaaaaa"), T("ddddddddddd")]},  # duplicate skipped
             {"op": "save", "kind": "album", "card": {"id": "MPRE1", "title": "Alb", "thumbnail": None}},
             {"op": "unlike", "videoId": "bbbbbbbbbbb"},
             {"op": "search", "q": "coldplay"},
             {"op": "settings", "patch": {"quality": "high"}})
    assert v2 == v1 + 1
    lib = client.get("/api/me/library", headers=h).json()
    assert [t["videoId"] for t in lib["liked"]] == ["aaaaaaaaaaa"]
    assert [t["videoId"] for t in lib["playlists"][0]["tracks"]] == ["aaaaaaaaaaa", "ccccccccccc", "ddddddddddd"]
    assert lib["albums"][0]["id"] == "MPRE1" and lib["albums"][0]["type"] == "album"
    assert lib["searches"] == ["coldplay"] and lib["settings"] == {"quality": "high"}

    ops(client, h, {"op": "playlist.reorder", "id": "pl1", "videoIds": ["ddddddddddd", "aaaaaaaaaaa"]},
        {"op": "playlist.remove", "id": "pl1", "videoId": "aaaaaaaaaaa"},
        {"op": "playlist.update", "id": "pl1", "name": "Renamed"})
    pl = client.get("/api/me/library", headers=h).json()["playlists"][0]
    assert pl["name"] == "Renamed"
    assert [t["videoId"] for t in pl["tracks"]] == ["ddddddddddd", "ccccccccccc"]  # reorder never drops tracks


def test_profiles_are_isolated(client):
    _, a = new_profile(client, "A")
    _, b = new_profile(client, "B")
    ops(client, a, {"op": "playlist.create", "id": "mine", "name": "A's"}, {"op": "like", "track": T("aaaaaaaaaaa")})
    assert client.get("/api/me/library", headers=b).json()["liked"] == []
    r = client.post("/api/me/ops", json={"ops": [{"op": "playlist.delete", "id": "mine"}]}, headers=b)
    assert r.status_code == 403


def test_bad_ops_roll_back(client):
    _, h = new_profile(client)
    r = client.post("/api/me/ops", json={"ops": [{"op": "like", "track": T("aaaaaaaaaaa")}, {"op": "like"}]}, headers=h)
    assert r.status_code == 400
    assert client.get("/api/me/library", headers=h).json()["liked"] == []


def test_pin_login(client):
    new_profile(client, "Locked", pin="1234")
    prof = client.get("/api/profiles").json()[0]
    assert prof["hasPin"] is True
    assert client.post(f"/api/profiles/{prof['id']}/login", json={"pin": "9999"}).status_code == 401
    r = client.post(f"/api/profiles/{prof['id']}/login", json={"pin": "1234"})
    assert r.status_code == 200 and r.json()["token"]
    assert client.post("/api/profiles", json={"name": "x", "pin": "12"}).status_code == 400


def test_history_and_stats(client):
    _, h = new_profile(client)
    ops(client, h,
        {"op": "play", "track": T("aaaaaaaaaaa", "Hit", "Star", "UC9"), "seconds": 180},
        {"op": "play", "track": T("aaaaaaaaaaa", "Hit", "Star", "UC9"), "seconds": 150},
        {"op": "play", "track": T("bbbbbbbbbbb", "Other", "Band", "UC8"), "seconds": 200},
        {"op": "play", "track": T("ccccccccccc", "Skipped", "Band", "UC8"), "seconds": 5})  # under 30s: history only
    lib = client.get("/api/me/library", headers=h).json()
    assert {t["videoId"] for t in lib["history"]} == {"aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc"}
    s = client.get("/api/me/stats?days=7", headers=h).json()
    assert s["plays"] == 3 and s["minutes"] == round(530 / 60)
    assert s["topTracks"][0]["videoId"] == "aaaaaaaaaaa" and s["topTracks"][0]["plays"] == 2
    assert s["topArtists"][0]["name"] == "Star"
    ops(client, h, {"op": "history.clear"})
    assert client.get("/api/me/library", headers=h).json()["history"] == []


def test_version_bumps_for_other_devices(client):
    token, h = new_profile(client)
    prof = client.get("/api/profiles").json()[0]
    h2 = {"Authorization": "Bearer " + client.post(f"/api/profiles/{prof['id']}/login", json={}).json()["token"]}
    before = client.get("/api/me/version", headers=h2).json()["version"]
    ops(client, h, {"op": "like", "track": T("aaaaaaaaaaa")})
    assert client.get("/api/me/version", headers=h2).json()["version"] == before + 1


def test_import_parsers():
    from openwave import importer, music
    csv_text = 'Track Name,Artist Name(s),Album Name,Duration (ms)\n"Yellow","Coldplay, Other",Parachutes,266773\n'
    [parsed] = importer.parse_csv(csv_text)
    assert parsed["items"] == [{"title": "Yellow", "artist": "Coldplay", "album": "Parachutes", "duration": 267}]
    [listed] = importer.parse_text("1. Coldplay - Yellow\nJust A Title")
    assert [(i["artist"], i["title"]) for i in listed["items"]] == [("Coldplay", "Yellow"), ("", "Just A Title")]
    good = {"title": "Yellow", "artists": [{"name": "Coldplay"}], "duration": 266}
    bad = {"title": "Yellow Submarine", "artists": [{"name": "The Beatles"}], "duration": 158}
    assert music.match_score("Yellow", "Coldplay", 267, good) > music.match_score("Yellow", "Coldplay", 267, bad)


def test_on_repeat_and_rediscover(tmp_path):
    import time as _t

    from openwave.library import Library
    lib = Library(tmp_path / "lib.db")
    p = lib.create_profile("A", "#fff", None, "test")["profile"]["id"]
    song = lambda v: {"videoId": v, "title": v, "artists": [{"name": "X"}], "duration": 200, "type": "song"}  # noqa: E731
    now = _t.time()
    plays = [("onrepeat001", now - 86400 * d) for d in (1, 2, 3)] + [("rediscover1", now - 86400 * d) for d in (100, 120, 150)] + [("playedonce1", now - 86400)]
    lib.apply_ops(p, [{"op": "play", "track": song(vid), "seconds": 120, "at": at * 1000} for vid, at in plays])
    lists = lib.smart_lists(p, now)
    assert [t["videoId"] for t in lists["onRepeat"]] == ["onrepeat001"]
    assert [t["videoId"] for t in lists["rediscover"]] == ["rediscover1"]
