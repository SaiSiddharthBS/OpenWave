"""Explore: countries' charts, genre pages and today's country (openwave/explore.py)."""

import asyncio
import datetime as dt

import pytest
from fastapi.testclient import TestClient

from openwave import app, explore, music


def run(coro):
    return asyncio.run(coro)


def T(vid, title="Song", kind="MUSIC_VIDEO_TYPE_OMV"):
    return {"type": "video" if kind != "MUSIC_VIDEO_TYPE_ATV" else "song", "videoId": vid, "title": title, "artists": [{"name": "Asake", "id": "UCa"}],
            "album": None, "duration": 200, "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg", "explicit": False}


def test_every_country_is_featured_once_before_any_comes_round_again():
    countries = ["NG", "MX", "TH", "JP", "BR", "KE", "FR"]
    start = dt.date(2026, 11, 1)
    week = [explore.featured(countries, start + dt.timedelta(days=i)) for i in range(7)]
    assert sorted(week) == sorted(countries)
    assert explore.featured(countries, start) == explore.featured(list(reversed(countries)), start)  # same everywhere
    assert explore.featured([], start) is None


def test_chart_titles_lose_video_tags_and_hashtags():
    assert explore._title("Ndewo (Official Video)") == "Ndewo"
    assert explore._title("Wake Up - Dunsin Oyekan #dunsinoyekan #worship") == "Wake Up - Dunsin Oyekan"
    assert explore._title("Calm Down") == "Calm Down"


@pytest.fixture
def charts(monkeypatch):
    lists = {
        "NG": [{"title": "Daily Top Music Videos - Nigeria", "playlistId": "PL4fGSI1pDJn6m", "thumbnails": []},
               {"title": "Trending 20 Nigeria", "playlistId": "OLAK5uy_ng", "thumbnails": [{"url": "https://yt3.googleusercontent.com/x=s192", "width": 192}]}],
        "ZZ": [{"title": "Top 100 Live Performances - Global", "playlistId": "PL4fLive", "thumbnails": []},
               {"title": "Daily Top Music Videos - Global", "playlistId": "PL4fDaily", "thumbnails": []}],
    }
    playlists = {"OLAK5uy_ng": [T("aaaaaaaaaaa", "INFERNO", "MUSIC_VIDEO_TYPE_ATV"), T("bbbbbbbbbbb", "Already Falling (Official Video)")],
                 "PL4fDaily": [T(f"{i:011d}", f"Hit {i}") for i in range(80)]}
    asked = []

    async def call(name, *args, **kwargs):
        asked.append((name, args))
        if name == "get_charts":
            code = args[0]
            return {"countries": {"options": ["ZZ", "NG", "MX", "bad"]}, "videos": lists.get(code, []),
                    "artists": [{"title": "Asake", "browseId": "UCasake", "subscribers": "2.2M", "thumbnails": [], "rank": "1", "trend": "up"},
                                {"title": "No id"}]}
        if name == "get_mood_categories":
            return {"Moods & moments": [{"title": "Chill", "params": "ggMPOchill"}], "Genres": [{"title": "African", "params": "ggMPOafrica"}, {"title": "Bad", "params": "no spaces!"}]}
        raise AssertionError(name)

    async def playlist(pid, limit=300):
        return {"tracks": playlists[pid]}

    monkeypatch.setattr(music, "_call", call)
    monkeypatch.setattr(music, "playlist", playlist)
    return asked


def test_a_country_gets_its_trending_20_its_artists_and_its_other_charts(charts):
    c = run(explore.country.__wrapped__("NG"))
    assert c["playlistId"] == "OLAK5uy_ng" and c["title"] == "Trending 20 Nigeria"
    assert [t["title"] for t in c["tracks"]] == ["INFERNO", "Already Falling"]
    assert c["artists"] == [{"type": "artist", "id": "UCasake", "title": "Asake", "subtitle": "2.2M subscribers", "thumbnail": None, "rank": "1", "trend": "up"}]
    assert [x["id"] for x in c["charts"]] == ["PL4fGSI1pDJn6m"]


def test_the_world_chart_is_todays_top_music_videos_not_live_performances(charts):
    c = run(explore.country.__wrapped__("ZZ"))
    assert c["playlistId"] == "PL4fDaily"
    assert len(c["tracks"]) == 50


def test_explore_lists_countries_genres_moods_and_today(charts, monkeypatch):
    monkeypatch.setattr(explore, "featured", lambda countries, day=None: "NG")
    monkeypatch.setattr(explore, "country", explore.country.__wrapped__)
    w = run(explore.world())
    assert w["countries"] == ["NG", "MX"]
    assert w["genres"] == [{"title": "African", "params": "ggMPOafrica"}]
    assert w["moods"] == [{"title": "Chill", "params": "ggMPOchill"}]
    assert w["today"]["code"] == "NG" and len(w["today"]["tracks"]) == 2
    assert len(w["today"]["covers"]) == 2


def test_square_artwork_leads_the_covers(charts, monkeypatch):
    async def country(code):
        art = ["https://i.ytimg.com/vi/a/hqdefault.jpg", "https://lh3.googleusercontent.com/b=w544-h544"]
        return {"title": "Trending 20", "playlistId": "OLAK5uy_x", "tracks": [{**T(f"{i:011d}"), "thumbnail": u} for i, u in enumerate(art)]}

    monkeypatch.setattr(explore, "featured", lambda countries, day=None: "NG")
    monkeypatch.setattr(explore, "country", country)
    covers = run(explore.world())["today"]["covers"]
    assert covers[0].startswith("https://lh3.googleusercontent.com/")


def test_a_genre_page_keeps_songs_and_cards_and_skips_the_music_video_shelf(monkeypatch):
    import ytmusicapi.parsers.browsing as browsing

    song = {"videoId": "aaaaaaaaaaa", "title": "Calm Down", "artists": [{"name": "Rema", "id": "UCrema"}], "thumbnails": []}
    pl = {"playlistId": "RDCLAK5uy_x", "title": "Owambe", "thumbnails": []}
    shelves = {"songs": [{"title": "Songs", "contents": [song]}], "lists": [{"title": "Featured playlists", "contents": [pl]}]}
    monkeypatch.setattr(browsing, "parse_mixed_content", lambda rows: shelves[rows[0]["kind"]])
    video_row = {"musicCarouselShelfRenderer": {"contents": [{"musicTwoRowItemRenderer": {"navigationEndpoint": {"watchEndpoint": {"videoId": "x"}}}}]}}
    raw = {"contents": {"singleColumnBrowseResultsRenderer": {"tabs": [{"tabRenderer": {"content": {"sectionListRenderer": {"contents": [
        {"kind": "songs"}, video_row, {"kind": "lists"}]}}}}]}}}
    out = explore._sections(raw)
    assert [(s["title"], s["kind"], len(s["items"])) for s in out] == [("Songs", "songs", 1), ("Featured playlists", "cards", 1)]
    assert out[1]["items"][0]["type"] == "playlist"


def test_explore_addresses_are_checked():
    client = TestClient(app.app)
    assert client.get("/api/explore/country/N1").status_code == 400
    assert client.get("/api/explore/country/NGA").status_code == 400
    assert client.get("/api/explore/genre/bad%20params!").status_code == 400


def test_app_files_are_current_by_content_not_date():
    """Android unpacks the app dated 1980: a date must never make an updated file look unchanged."""
    import hashlib

    client = TestClient(app.app)
    first = client.get("/js/explore.js")
    tag = first.headers["etag"]
    assert first.status_code == 200 and tag == f'"{hashlib.md5(first.content).hexdigest()}"'
    assert client.get("/js/explore.js", headers={"if-none-match": tag}).status_code == 304
    stale = client.get("/js/explore.js", headers={"if-none-match": '"an-older-version"', "if-modified-since": "Fri, 01 Jan 2100 00:00:00 GMT"})
    assert stale.status_code == 200 and stale.content == first.content
