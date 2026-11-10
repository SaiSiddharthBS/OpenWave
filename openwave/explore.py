"""Explore: what the world is playing.

YouTube Music keeps a chart for each of about 70 countries (its "Trending 20", its top artists and
its music video charts) and a page for each genre and mood. This turns them into the shapes the app
already shows (music.track, music.card), and picks one country a day to feature.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import random
import re

from . import music
from .music import cached

COUNTRY_RE = re.compile(r"^[A-Z]{2}$")
PARAMS_RE = re.compile(r"^[A-Za-z0-9_-]{6,120}$")
GLOBAL = "ZZ"

_TAG = re.compile(r"\s+#[\w-]+")


def _title(title: str) -> str:
    """Chart entries are often music videos: "Song (Official Video) #hashtag" reads as "Song"."""
    return _TAG.sub("", music.clean_title(title or "")).strip() or title


def _tidy(tracks: list[dict]) -> list[dict]:
    # Copies: music.playlist's answers are cached and shared with the playlist page.
    return [{**t, "title": _title(t["title"])} for t in tracks]


@cached(ttl=6 * 3600)
async def _world() -> dict:
    charts, categories = await asyncio.gather(music._call("get_charts", GLOBAL), music._call("get_mood_categories"))
    options = (charts.get("countries") or {}).get("options") or []
    countries = [c for c in options if isinstance(c, str) and COUNTRY_RE.match(c) and c != GLOBAL]
    # Sections are named in the catalogue's language ("Moods & moments", "Genres"); moods come first.
    sections = list(categories.items())
    genres = next((v for k, v in sections if "genre" in k.lower()), sections[1][1] if len(sections) > 1 else [])
    moods = next((v for k, v in sections if v is not genres), [])
    pick = lambda items: [{"title": x["title"], "params": x["params"]} for x in items if x.get("params") and PARAMS_RE.match(x["params"])]  # noqa: E731
    return {"countries": countries, "genres": pick(genres), "moods": pick(moods)}


def featured(countries: list[str], day: dt.date | None = None) -> str | None:
    """Today's country: every country once, in a mixed-up order, before any comes round again."""
    if not countries:
        return None
    day = day or dt.datetime.now(dt.timezone.utc).date()
    order = sorted(countries)
    random.Random(len(order)).shuffle(order)   # the same order everywhere, every day
    return order[day.toordinal() % len(order)]


async def world() -> dict:
    w = await _world()
    code = featured(w["countries"])
    today = None
    if code:
        try:
            c = await country(code)
            # Square artwork first: the covers fan out on cards.
            art = sorted((t["thumbnail"] for t in c["tracks"] if t.get("thumbnail")), key=lambda u: "i.ytimg.com" in u)
            today = {"code": code, "title": c["title"], "playlistId": c["playlistId"], "covers": art[:5], "tracks": c["tracks"][:12]}
        except Exception:  # noqa: BLE001 - Explore still opens without today's country
            today = {"code": code, "title": None, "playlistId": None, "covers": [], "tracks": []}
    return {**w, "today": today}


@cached(ttl=3600)
async def country(code: str) -> dict:
    """A country's chart: its Trending 20 (or, for the world, today's top music videos), its top
    artists and its other charts."""
    ch = await music._call("get_charts", code)
    lists = [v for v in ch.get("videos") or [] if v.get("playlistId")]
    # "Trending 20 <country>" is an auto-made playlist (OLAK5uy_...). The world chart has none, so
    # it gets today's top music videos; live performances are a last resort.
    main = next((v for v in lists if v["playlistId"].startswith("OLAK5uy")), None) \
        or next((v for v in lists if "live" not in (v.get("title") or "").lower()), None) \
        or (lists[0] if lists else None)
    tracks: list[dict] = []
    if main:
        tracks = _tidy((await music.playlist(main["playlistId"]))["tracks"][:50])
    artists = []
    for a in ch.get("artists") or []:
        if not a.get("browseId"):
            continue
        artists.append({
            "type": "artist", "id": a["browseId"], "title": a.get("title"),
            "subtitle": f"{a['subscribers']} subscribers" if a.get("subscribers") else "Artist",
            "thumbnail": music.thumb(a.get("thumbnails")), "rank": a.get("rank"), "trend": a.get("trend"),
        })
    charts = [{"type": "playlist", "id": v["playlistId"], "title": v.get("title"), "subtitle": "Chart", "thumbnail": music.thumb(v.get("thumbnails"))}
              for v in lists if v is not main]
    return {
        "code": code,
        "title": main.get("title") if main else None,
        "playlistId": main["playlistId"] if main else None,
        "thumbnail": music.thumb(main.get("thumbnails")) if main else None,
        "tracks": tracks,
        "artists": artists[:24],
        "charts": charts,
    }


def _videos(row: dict) -> bool:
    """A shelf of music video tiles (rather than a list of songs)."""
    shelf = row.get("musicCarouselShelfRenderer") or {}
    tiles = [x.get("musicTwoRowItemRenderer") for x in shelf.get("contents") or []]
    return bool(tiles) and all(t and "watchEndpoint" in (t.get("navigationEndpoint") or {}) for t in tiles)


def _sections(raw: dict) -> list[dict]:
    from ytmusicapi.parsers.browsing import parse_mixed_content

    tabs = raw["contents"]["singleColumnBrowseResultsRenderer"]["tabs"]
    rows = tabs[0]["tabRenderer"]["content"]["sectionListRenderer"]["contents"]
    out = []
    for row in rows:
        if _videos(row):
            continue  # the "Music videos" shelf repeats the songs as videos; OpenWave plays the songs
        try:
            parsed = parse_mixed_content([row])
        except Exception:  # noqa: BLE001 - YouTube adds kinds of shelves now and then; skip what we can't read
            continue
        for sec in parsed:
            items = [x for x in (music._any(i) for i in sec.get("contents") or [] if i) if x]
            songs = [x for x in items if x.get("videoId") and x["type"] == "song"]
            cards = [x for x in items if not x.get("videoId")]
            if len(songs) >= len(cards) and songs:
                out.append({"title": sec.get("title"), "kind": "songs", "items": _tidy(songs)})
            elif cards:
                out.append({"title": sec.get("title"), "kind": "cards", "items": cards})
    return out


@cached(ttl=6 * 3600)
async def genre(params: str) -> dict:
    """A genre or mood page: its songs, playlists and albums."""
    raw = await music._call("_send_request", "browse", {"browseId": "FEmusic_moods_and_genres_category", "params": params})
    header = raw.get("header") or {}
    title = None
    for h in header.values():
        runs = (h.get("title") or {}).get("runs") or []
        title = runs[0].get("text") if runs else None
    return {"params": params, "title": title, "sections": _sections(raw)}
