"""Catalog layer: search, browse and lyrics via the public YouTube Music web API.

Everything here goes through ytmusicapi without authentication and is
normalised into a small set of shapes the frontend understands:

    track    {type: "song"|"video", videoId, title, artists, album, duration, thumbnail, explicit}
    card     {type: "album"|"playlist"|"artist", id, title, subtitle, thumbnail}
"""

from __future__ import annotations

import asyncio
import os
import re
import threading
import time
from functools import wraps
from typing import Any
from urllib.parse import parse_qs, urlparse

from ytmusicapi import YTMusic

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")

_local = threading.local()


def _yt() -> YTMusic:
    """One client per worker thread; ytmusicapi keeps a requests.Session inside."""
    if not hasattr(_local, "yt"):
        kwargs = {}
        if os.getenv("OPENWAVE_LANGUAGE"):
            kwargs["language"] = os.environ["OPENWAVE_LANGUAGE"]
        if os.getenv("OPENWAVE_LOCATION"):
            kwargs["location"] = os.environ["OPENWAVE_LOCATION"]
        _local.yt = YTMusic(**kwargs)
    return _local.yt


def cached(ttl: int, maxsize: int = 512):
    """TTL cache for async functions keyed on their arguments."""

    def deco(fn):
        store: dict[tuple, tuple[float, Any]] = {}

        @wraps(fn)
        async def wrapper(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            hit = store.get(key)
            if hit and hit[0] > time.monotonic():
                return hit[1]
            value = await fn(*args, **kwargs)
            if len(store) >= maxsize:
                store.pop(next(iter(store)))
            store[key] = (time.monotonic() + ttl, value)
            return value

        return wrapper

    return deco


async def _call(name: str, *args, **kwargs):
    return await asyncio.to_thread(lambda: getattr(_yt(), name)(*args, **kwargs))


# --------------------------------------------------------------------------- normalisers


def thumb(thumbs: list[dict] | None, size: int = 544) -> str | None:
    if not thumbs:
        return None
    url = max(thumbs, key=lambda t: t.get("width") or 0)["url"]
    if "googleusercontent.com" in url or "ggpht.com" in url:
        url = re.sub(r"=w\d+-h\d+", f"=w{size}-h{size}", url)
    return url


def parse_duration(value: Any) -> int | None:
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str) or ":" not in value:
        return None
    seconds = 0
    for part in value.split(":"):
        if not part.isdigit():
            return None
        seconds = seconds * 60 + int(part)
    return seconds


def _artists(item: dict) -> list[dict]:
    out = []
    for a in item.get("artists") or []:
        if a.get("name"):
            out.append({"name": a["name"], "id": a.get("id")})
    if not out and item.get("author"):
        author = item["author"]
        out.append({"name": author["name"], "id": author.get("id")} if isinstance(author, dict) else {"name": author, "id": None})
    return out


def track(item: dict, album: dict | None = None, fallback_thumb: str | None = None) -> dict | None:
    video_id = item.get("videoId")
    if not video_id:
        return None
    alb = item.get("album")
    if isinstance(alb, dict) and alb.get("name"):
        alb = {"name": alb["name"], "id": alb.get("id")}
    elif isinstance(alb, str):
        alb = {"name": alb, "id": (album or {}).get("id")}
    else:
        alb = album
    is_song = item.get("videoType") in (None, "MUSIC_VIDEO_TYPE_ATV") and item.get("resultType") != "video"
    return {
        "type": "song" if is_song else "video",
        "videoId": video_id,
        "title": item.get("title") or "Unknown",
        "artists": _artists(item),
        "album": alb,
        "duration": item.get("duration_seconds") or parse_duration(item.get("duration") or item.get("length")),
        "thumbnail": thumb(item.get("thumbnails") or item.get("thumbnail"))
        or fallback_thumb
        or f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg",
        "explicit": bool(item.get("isExplicit")),
    }


def _strip_vl(browse_id: str) -> str:
    return browse_id[2:] if browse_id.startswith("VL") else browse_id


def card(item: dict) -> dict | None:
    """Album / playlist / artist cards from search results, home shelves and artist pages."""
    rtype = item.get("resultType")
    browse_id = item.get("browseId") or ""
    artists = ", ".join(a["name"] for a in _artists(item))
    if rtype == "album" or browse_id.startswith("MPRE"):
        sub = " • ".join(x for x in (item.get("type"), artists, item.get("year")) if x)
        return {"type": "album", "id": browse_id, "title": item.get("title"), "subtitle": sub, "thumbnail": thumb(item.get("thumbnails"))}
    if rtype == "artist" or (browse_id.startswith("UC") and not item.get("playlistId")):
        name = item.get("artist") or item.get("title") or artists
        sub = item.get("subscribers")
        artist_id = browse_id or next((a["id"] for a in _artists(item) if a["id"]), "")
        return {"type": "artist", "id": artist_id, "title": name, "subtitle": f"{sub} subscribers" if sub else "Artist", "thumbnail": thumb(item.get("thumbnails"))}
    if rtype == "playlist" or item.get("playlistId") or browse_id.startswith("VL"):
        pid = item.get("playlistId") or _strip_vl(browse_id)
        sub = item.get("author") or artists or item.get("description") or "Playlist"
        if isinstance(sub, dict):
            sub = sub.get("name")
        if item.get("itemCount"):
            sub = f"{sub} • {item['itemCount']} songs"
        return {"type": "playlist", "id": pid, "title": item.get("title"), "subtitle": sub, "thumbnail": thumb(item.get("thumbnails"))}
    return None


def _any(item: dict) -> dict | None:
    return track(item) if item.get("videoId") else card(item)


def _compact(items) -> list[dict]:
    return [x for x in items if x]


# --------------------------------------------------------------------------- endpoints


def parse_youtube_url(text: str) -> tuple[str, str] | None:
    """Return ("video", id) or ("playlist", id) when the query is a YouTube link."""
    text = text.strip()
    if not re.match(r"^(https?://)?([\w-]+\.)?(youtube\.com|youtu\.be)/", text):
        return None
    url = urlparse(text if text.startswith("http") else "https://" + text)
    qs = parse_qs(url.query)
    if url.hostname and url.hostname.endswith("youtu.be"):
        vid = url.path.strip("/").split("/")[0]
        if VIDEO_ID_RE.match(vid):
            return ("video", vid)
    if "v" in qs and VIDEO_ID_RE.match(qs["v"][0]):
        return ("video", qs["v"][0])
    m = re.match(r"^/(shorts|live|embed)/([A-Za-z0-9_-]{11})", url.path)
    if m:
        return ("video", m.group(2))
    if "list" in qs:
        return ("playlist", qs["list"][0])
    return None


@cached(ttl=600)
async def search(query: str, kind: str = "all") -> dict:
    link = parse_youtube_url(query)
    if link and link[0] == "video":
        t = await track_info(link[1])
        return {"query": query, "kind": kind, "top": t, "results": [t] if t else []}
    if link and link[0] == "playlist":
        return {"query": query, "kind": kind, "redirect": f"#/playlist/{link[1]}", "results": []}

    if kind == "youtube":
        from . import youtube

        return {"query": query, "kind": kind, "results": await youtube.search_videos(query)}

    filters = {"songs": "songs", "videos": "videos", "albums": "albums", "artists": "artists", "playlists": "playlists"}
    if kind in filters:
        raw = await _call("search", query, filter=filters[kind], limit=40)
        songs_only = []
    else:
        # The unfiltered layout sometimes omits artist names; a songs-only search fills them in.
        raw, songs_only = await asyncio.gather(
            _call("search", query, limit=20),
            _call("search", query, filter="songs", limit=20),
        )
    artists_by_id = {s["videoId"]: s["artists"] for s in _compact(track(x) for x in songs_only) if s["artists"]}
    top = None
    results = []
    for item in raw:
        norm = _any(item)
        if not norm:
            continue
        if norm.get("videoId") and not norm["artists"]:
            norm["artists"] = artists_by_id.get(norm["videoId"], [])
        if item.get("category") == "Top result" and top is None:
            top = norm
            continue
        results.append(norm)
    return {"query": query, "kind": kind, "top": top, "results": results}


@cached(ttl=3600)
async def suggest(query: str) -> list[str]:
    return (await _call("get_search_suggestions", query))[:8]


@cached(ttl=1800)
async def home() -> list[dict]:
    sections = []
    for sec in await _call("get_home", limit=8):
        items = _compact(_any(i) for i in sec.get("contents") or [])
        if items:
            sections.append({"title": sec.get("title"), "items": items})
    return sections


@cached(ttl=3600)
async def album(browse_id: str) -> dict:
    a = await _call("get_album", browse_id)
    art = thumb(a.get("thumbnails"))
    ref = {"name": a.get("title"), "id": browse_id}
    return {
        "type": "album",
        "id": browse_id,
        "title": a.get("title"),
        "kind": a.get("type") or "Album",
        "year": a.get("year"),
        "artists": _artists(a),
        "thumbnail": art,
        "description": a.get("description"),
        "trackCount": a.get("trackCount"),
        "duration": a.get("duration"),
        "playlistId": a.get("audioPlaylistId"),
        "tracks": _compact(track({**t, "videoType": None}, album=ref, fallback_thumb=art) for t in a.get("tracks") or []),
    }


@cached(ttl=1800)
async def playlist(playlist_id: str) -> dict:
    p = await _call("get_playlist", _strip_vl(playlist_id), limit=300)
    author = p.get("author")
    return {
        "type": "playlist",
        "id": p.get("id") or playlist_id,
        "title": p.get("title"),
        "author": author.get("name") if isinstance(author, dict) else author,
        "thumbnail": thumb(p.get("thumbnails")),
        "description": p.get("description"),
        "trackCount": p.get("trackCount"),
        "duration": p.get("duration"),
        "tracks": _compact(track(t) for t in p.get("tracks") or []),
    }


@cached(ttl=3600)
async def artist(channel_id: str) -> dict:
    a = await _call("get_artist", channel_id)

    def section(key):
        return (a.get(key) or {}).get("results") or []

    songs = a.get("songs") or {}
    return {
        "type": "artist",
        "id": channel_id,
        "name": a.get("name"),
        "description": a.get("description"),
        "thumbnail": thumb(a.get("thumbnails"), size=1200),
        "subscribers": a.get("subscribers"),
        "monthlyListeners": a.get("monthlyListeners"),
        "radioId": a.get("radioId"),
        "shuffleId": a.get("shuffleId"),
        "songsPlaylistId": _strip_vl(songs["browseId"]) if songs.get("browseId") else None,
        "songs": _compact(track(t) for t in section("songs")),
        "albums": _compact(card({**x, "resultType": "album"}) for x in section("albums")),
        "singles": _compact(card({**x, "resultType": "album"}) for x in section("singles")),
        "videos": _compact(track({**x, "resultType": "video"}) for x in section("videos")),
        "related": _compact(card({**x, "resultType": "artist"}) for x in section("related")),
    }


@cached(ttl=900)
async def up_next(video_id: str, playlist_id: str | None = None) -> dict:
    w = await _call("get_watch_playlist", videoId=video_id, playlistId=playlist_id, limit=50)
    tracks = _compact(track(t) for t in w.get("tracks") or [])
    return {"tracks": tracks, "lyricsId": w.get("lyrics"), "relatedId": w.get("related")}


@cached(ttl=86400)
async def track_info(video_id: str) -> dict | None:
    data = await up_next(video_id)
    for t in data["tracks"]:
        if t["videoId"] == video_id:
            return t
    return None


@cached(ttl=86400)
async def lyrics(video_id: str) -> dict:
    lyrics_id = (await up_next(video_id)).get("lyricsId")
    if not lyrics_id:
        return {"found": False}
    try:
        data = await _call("get_lyrics", lyrics_id, timestamps=True)
    except Exception:
        data = None
    if not data:
        return {"found": False}
    if data.get("hasTimestamps"):
        lines = [{"text": l.text, "start": l.start_time, "end": l.end_time} for l in data["lyrics"]]
        return {"found": True, "synced": True, "lines": lines, "source": data.get("source")}
    return {"found": True, "synced": False, "text": data.get("lyrics"), "source": data.get("source")}
