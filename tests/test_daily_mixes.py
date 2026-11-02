"""Daily Mixes: what listening is read to mean, and how a day's mixes are put together."""

import time

import pytest
from fastapi.testclient import TestClient

from openwave import api_library, app, kv, mixes, music
from openwave.library import Library

NOW = 1_780_000_000.0
DAY = 86400


def T(vid, artist="Arijit", aid=None, duration=200):
    return {"type": "song", "videoId": vid, "title": f"Song {vid}", "artists": [{"name": artist, "id": aid or f"UC{artist}"}],
            "album": None, "duration": duration, "thumbnail": f"https://i.ytimg.com/{vid}.jpg", "explicit": False}


def play(track, at, seconds=200):
    return {"at": at, "seconds": seconds, "track": track}


def sittings(*groups):
    """Plays in order; each group is one sitting, a day apart."""
    plays = []
    start = NOW - DAY * (len(groups) + 1)
    for g, tracks in enumerate(groups):
        for i, t in enumerate(tracks):
            plays.append(play(t, start + g * DAY + i * 240))
    return plays


def songs(artist, n, start=0):
    return [T(f"{artist}{i:02d}".ljust(11, "0"), artist) for i in range(start, start + n)]


def test_a_finished_song_counts_for_more_than_a_half_heard_one():
    full, half = T("full"), T("half")
    taste = mixes.learn([play(full, NOW - DAY), play(half, NOW - DAY, 100)], [], NOW)
    assert taste["score"]["full"] > taste["score"]["half"] > 0


def test_recent_listening_counts_for_more():
    new, old = T("new"), T("old")
    taste = mixes.learn([play(old, NOW - 90 * DAY), play(new, NOW - DAY)], [], NOW)
    assert taste["score"]["new"] > taste["score"]["old"]


def test_a_song_you_keep_skipping_is_left_out():
    skip, good = T("skip"), T("good")
    plays = [play(skip, NOW - 3 * DAY, 8), play(skip, NOW - 2 * DAY, 5), play(good, NOW - DAY)]
    assert "skip" in mixes.learn(plays, [], NOW)["avoid"]


def test_one_skip_of_a_song_you_love_is_forgiven():
    t = T("loved")
    plays = [play(t, NOW - 9 * DAY), play(t, NOW - 8 * DAY), play(t, NOW - DAY, 6)]
    taste = mixes.learn(plays, [], NOW)
    assert "loved" not in taste["avoid"] and taste["score"]["loved"] > 0


def test_a_like_counts():
    assert mixes.learn([], [T("liked")], NOW)["score"]["liked"] == 2


def test_artists_played_together_share_a_mix():
    a, b, c = songs("A", 6), songs("B", 6), songs("C", 6)
    taste = mixes.learn(sittings(a + b, a + b, c), [], NOW)
    made = mixes.groups(taste)
    assert sorted(made[0]) == ["UCA", "UCB"]
    assert made[1] == ["UCC"]


def test_not_enough_listening_makes_no_mixes():
    assert mixes.build(mixes.learn(sittings(songs("A", 7)), [], NOW), "s") == []


def test_mixes_are_named_and_never_repeat_a_song():
    a, b, c, d = songs("A", 8), songs("B", 8), songs("C", 8), songs("D", 8)
    made = mixes.build(mixes.learn(sittings(a, b, c, d), [], NOW), "s")
    assert [m["title"] for m in made] == ["Daily Mix 1", "Daily Mix 2", "Daily Mix 3"]
    assert made[0]["id"] == "1" and made[0]["thumbnail"] and "and more" in made[0]["subtitle"]
    ids = [t["videoId"] for m in made for t in m["tracks"]]
    assert len(ids) == len(set(ids))


def test_a_day_keeps_its_order_and_the_next_day_changes():
    taste = mixes.learn(sittings(songs("A", 14)), [], NOW)
    today = [t["videoId"] for t in mixes.build(taste, "p:1")[0]["tracks"]]
    assert today == [t["videoId"] for t in mixes.build(taste, "p:1")[0]["tracks"]]
    assert today != [t["videoId"] for t in mixes.build(taste, "p:2")[0]["tracks"]]


def test_new_songs_are_really_new_and_kept_in_proportion():
    known = songs("A", 14)
    skipped = T("skipped", "B")
    plays = sittings(known) + [play(skipped, NOW - 2 * DAY, 5), play(skipped, NOW - DAY, 5)]
    radio = [known[0], skipped] + [T(f"n{i:02d}", f"N{i % 8}") for i in range(40)]
    mix = mixes.build(mixes.learn(plays, [], NOW), "s", {0: radio})[0]
    ids = [t["videoId"] for t in mix["tracks"]]
    assert len(ids) == mixes.SONGS and len(ids) == len(set(ids))
    assert "skipped" not in ids
    fresh = [v for v in ids if v.startswith("n")]
    assert len(fresh) == mixes.SONGS - mixes.FAMILIAR
    assert any(v.startswith("n") for v in ids[:4]), "new songs are spread through, not left to the end"


def test_one_artist_cant_fill_a_mix():
    radio = [T(f"n{i:02d}", "Everywhere") for i in range(40)]
    mix = mixes.build(mixes.learn(sittings(songs("A", 14)), [], NOW), "s", {0: radio})[0]
    assert sum(t["artists"][0]["name"] == "Everywhere" for t in mix["tracks"]) == mixes.MOST_NEW_BY_ONE_ARTIST


def test_a_song_with_no_length_or_artist_does_no_harm():
    odd = {"type": "song", "videoId": "odd", "title": "Odd", "artists": [], "duration": None, "thumbnail": ""}
    plays = sittings(songs("A", 9) + [odd])
    assert mixes.build(mixes.learn(plays, [], NOW), "s")[0]["tracks"]


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(kv, "_db", None)
    monkeypatch.setattr("openwave.kv.data_dir", lambda: tmp_path)
    api_library.use_library(Library(tmp_path / "t.db"))
    with TestClient(app.app) as c:
        yield c


def signed_in(c):
    r = c.post("/api/profiles", json={"name": "Sai", "pin": None})
    return {"Authorization": f"Bearer {r.json()['token']}"}


def listen(c, h, tracks, seconds=200):
    now = time.time() * 1000
    r = c.post("/api/me/ops", json={"ops": [{"op": "play", "track": t, "seconds": seconds, "at": now - (i + 1) * 3 * DAY * 1000 / len(tracks)}
                                            for i, t in enumerate(tracks)]}, headers=h)
    assert r.status_code == 200, r.text


def test_home_gets_mixes_at_once_and_new_songs_join_them(client, monkeypatch):
    async def radio(video_id, playlist_id=None):
        return {"tracks": [T(f"n{video_id}{i:02d}", f"N{i}") for i in range(20)]}
    monkeypatch.setattr(music, "up_next", radio)
    h = signed_in(client)
    listen(client, h, songs("A", 12))
    first = client.get("/api/me/daily", headers=h).json()
    assert [m["title"] for m in first["mixes"]] == ["Daily Mix 1"]
    assert all(t["videoId"].startswith("A") for t in first["mixes"][0]["tracks"])
    for _ in range(50):
        later = client.get("/api/me/daily", headers=h).json()
        if any(t["videoId"].startswith("n") for t in later["mixes"][0]["tracks"]):
            break
        time.sleep(0.02)
    assert any(t["videoId"].startswith("n") for t in later["mixes"][0]["tracks"])


def test_mixes_still_work_when_youtube_doesnt(client, monkeypatch):
    async def down(video_id, playlist_id=None):
        raise OSError("no network")
    monkeypatch.setattr(music, "up_next", down)
    h = signed_in(client)
    listen(client, h, songs("A", 12))
    assert client.get("/api/me/daily", headers=h).json()["mixes"][0]["tracks"]
    time.sleep(0.05)
    assert client.get("/api/me/daily", headers=h).json()["mixes"][0]["tracks"]


def test_a_new_listener_has_no_mixes_yet(client):
    h = signed_in(client)
    listen(client, h, songs("A", 3))
    assert client.get("/api/me/daily", headers=h).json()["mixes"] == []


def test_each_profile_has_its_own(client, monkeypatch):
    async def down(video_id, playlist_id=None):
        return {"tracks": []}
    monkeypatch.setattr(music, "up_next", down)
    one, two = signed_in(client), client.post("/api/profiles", json={"name": "Maya", "pin": None}).json()["token"]
    two = {"Authorization": f"Bearer {two}"}
    listen(client, one, songs("A", 12))
    listen(client, two, songs("B", 12))
    assert client.get("/api/me/daily", headers=one).json()["mixes"][0]["tracks"][0]["videoId"].startswith("A")
    assert client.get("/api/me/daily", headers=two).json()["mixes"][0]["tracks"][0]["videoId"].startswith("B")


def test_the_mixes_need_a_profile(client):
    assert client.get("/api/me/daily").status_code in (401, 403)
