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

from . import kv

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
    """TTL cache for async functions keyed on their arguments. A call made while the same lookup
    is already running joins it (a tap right after a prefetch shouldn't start over)."""

    def deco(fn):
        store: dict[tuple, tuple[float, Any]] = {}
        running: dict[tuple, asyncio.Future] = {}

        @wraps(fn)
        async def wrapper(*args, **kwargs):
            key = (args, tuple(sorted(kwargs.items())))
            hit = store.get(key)
            if hit and hit[0] > time.monotonic():
                return hit[1]
            if key in running:
                return await asyncio.shield(running[key])
            task = asyncio.ensure_future(fn(*args, **kwargs))
            running[key] = task
            try:
                value = await asyncio.shield(task)
            finally:
                running.pop(key, None)
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


# --------------------------------------------------------------------------- songs, not videos
#
# OpenWave plays audio tracks ("songs") only. A music video often has film dialogue, intros or
# skits in its soundtrack, so whenever YouTube hands us a video we look up the plain audio track.

_NOISE = re.compile(
    r"\s*[\(\[](?:official|music|lyric|lyrics|audio|video|visuali[sz]er|hd|4k|mv|m/v|full song|full video)[^\)\]]*[\)\]]"
    r"|\s*[\(\[](?:feat|ft|with)\.?[^\)\]]*[\)\]]|\s+(?:feat|ft)\.?\s.*$|\s*\|.*$",
    re.I,
)


def clean_title(title: str) -> str:
    return _NOISE.sub("", title or "").strip(" -–") or (title or "")


def _norm(s: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", clean_title(s).lower()).split())


def similar(a: str, b: str) -> float:
    from difflib import SequenceMatcher
    return SequenceMatcher(None, _norm(a), _norm(b)).ratio()


def match_score(title: str, artist: str, duration: int | None, cand: dict) -> float:
    s = similar(title, cand["title"]) * 0.6
    names = " ".join(a["name"] for a in cand.get("artists") or [])
    s += (similar(artist, names) if artist else 0.5) * 0.3
    if duration and cand.get("duration"):
        diff = abs(duration - cand["duration"])
        s += 0.1 if diff <= 5 else (0.05 if diff <= 15 else -0.15)
    return s


async def match_song(title: str, artist: str = "", duration: int | None = None) -> dict | None:
    """Best audio-track match on YouTube Music for a title/artist, or None."""
    query = f"{artist} {clean_title(title)}".strip()
    try:
        res = await search(query, "songs")
    except Exception:  # noqa: BLE001 - a miss is fine
        return None
    candidates = [r for r in res.get("results", [])[:6] if r.get("videoId") and r["type"] == "song"]
    if not candidates:
        return None
    best = max(candidates, key=lambda c: match_score(title, artist, duration, c))
    return best if match_score(title, artist, duration, best) >= 0.45 else None


@cached(ttl=86400)
async def audio_version(video_id: str, title: str = "", artist: str = "") -> dict | None:
    """The audio-track ("song") version of any YouTube video, or None if there isn't one.
    With the video's title and artist (the app has them from the list) it's one lookup, not two.
    Remembered on disk for a month: it rarely changes, and phones restart the engine often."""
    remembered = kv.get(f"audio:{video_id}")
    if remembered is not kv.MISSING:
        return remembered
    if not title:
        info = await track_info(video_id)
        if not info:
            return None
        if info["type"] == "song":
            kv.put(f"audio:{video_id}", info, 30 * 86400)
            return info
        title, artist = info["title"], info["artists"][0]["name"] if info["artists"] else ""
    # Videos run longer (intros, skits), so don't let duration veto the match.
    song = await match_song(title, artist)
    kv.put(f"audio:{video_id}", song, 30 * 86400)
    return song


@cached(ttl=600)
async def search(query: str, kind: str = "all") -> dict:
    link = parse_youtube_url(query)
    if link and link[0] == "video":
        t = await audio_version(link[1]) or await track_info(link[1])
        return {"query": query, "kind": kind, "top": t, "results": []}
    if link and link[0] == "playlist":
        return {"query": query, "kind": kind, "redirect": f"#/playlist/{link[1]}", "results": []}

    filters = {"songs": "songs", "albums": "albums", "artists": "artists", "playlists": "playlists"}
    if kind in filters:
        raw = await _call("search", query, filter=filters[kind], limit=40)
        songs_only = []
    else:
        # The unfiltered layout sometimes omits artist names; a songs-only search fills them in.
        raw, songs_only = await asyncio.gather(
            _call("search", query, limit=20),
            _call("search", query, filter="songs", limit=20),
        )
    songs = _compact(track(x) for x in songs_only)
    artists_by_id = {s["videoId"]: s["artists"] for s in songs if s["artists"]}
    top = None
    results = []
    for item in raw:
        norm = _any(item)
        if not norm:
            continue
        if norm.get("videoId") and not norm["artists"]:
            norm["artists"] = artists_by_id.get(norm["videoId"], [])
        if item.get("category") == "Top result" and top is None:
            if norm.get("type") == "video":
                # Show the song rather than its music video.
                artist = norm["artists"][0]["name"] if norm["artists"] else ""
                norm = next((s for s in songs if similar(norm["title"], s["title"]) > 0.7), None) or await match_song(norm["title"], artist)
            top = norm
            continue
        if norm.get("type") == "video":
            continue
        results.append(norm)
    if top and top.get("videoId"):
        results = [r for r in results if r.get("videoId") != top["videoId"]]
    return {"query": query, "kind": kind, "top": top, "results": results}


@cached(ttl=3600)
async def suggest(query: str) -> list[str]:
    return (await _call("get_search_suggestions", query))[:8]


@cached(ttl=1800)
async def home() -> list[dict]:
    sections = []
    for sec in await _call("get_home", limit=8):
        items = [i for i in _compact(_any(i) for i in sec.get("contents") or []) if i.get("type") != "video"]
        if items:
            sections.append({"title": sec.get("title"), "items": items})
    return sections


@cached(ttl=3600)
async def album(browse_id: str) -> dict:
    a = await _call("get_album", browse_id)
    art = thumb(a.get("thumbnails"))
    ref = {"name": a.get("title"), "id": browse_id}
    tracks = _compact(track({**t, "videoType": None}, album=ref, fallback_thumb=art) for t in a.get("tracks") or [])
    # Some album entries point at the music video. The album's audio playlist has the plain tracks.
    if a.get("audioPlaylistId") and any(t.get("videoType") not in (None, "MUSIC_VIDEO_TYPE_ATV") for t in a.get("tracks") or []):
        try:
            audio = (await _call("get_playlist", a["audioPlaylistId"], limit=300)).get("tracks") or []
            if len(audio) == len(tracks):
                for t, at in zip(tracks, audio):
                    if at.get("videoId") and similar(t["title"], at.get("title") or "") > 0.6:
                        t["videoId"] = at["videoId"]
                        t["duration"] = at.get("duration_seconds") or t["duration"]
        except Exception:  # noqa: BLE001 - fall back to the album's own ids
            pass
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
        "tracks": tracks,
    }


@cached(ttl=1800)
async def playlist(playlist_id: str, limit: int | None = 300) -> dict:
    """limit=None fetches every song (imports); browsing shows the first 300."""
    p = await _call("get_playlist", _strip_vl(playlist_id), limit=limit)
    author = p.get("author")
    result = {
        "type": "playlist",
        "id": p.get("id") or playlist_id,
        "title": p.get("title"),
        "author": author.get("name") if isinstance(author, dict) else author,
        "thumbnail": thumb(p.get("thumbnails")),
        "description": p.get("description"),
        "trackCount": p.get("trackCount"),
        "duration": p.get("duration"),
        # Video entries stay listed; the player swaps each for its audio track when it plays.
        "tracks": _compact(track(t) for t in p.get("tracks") or []),
    }
    return result


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
        "songs": [t for t in _compact(track(t) for t in section("songs")) if t["type"] == "song"],
        "albums": _compact(card({**x, "resultType": "album"}) for x in section("albums")),
        "singles": _compact(card({**x, "resultType": "album"}) for x in section("singles")),
        "related": _compact(card({**x, "resultType": "artist"}) for x in section("related")),
    }


@cached(ttl=900)
async def _watch(video_id: str, playlist_id: str | None = None) -> dict:
    w = await _call("get_watch_playlist", videoId=video_id, playlistId=playlist_id, limit=50)
    tracks = _compact(track(t) for t in w.get("tracks") or [])
    return {"tracks": tracks, "lyricsId": w.get("lyrics"), "relatedId": w.get("related")}


@cached(ttl=900)
async def up_next(video_id: str, playlist_id: str | None = None) -> dict:
    """Radio for a song. Seeded from the audio track, a radio is (almost) all audio tracks."""
    seed = video_id
    if not playlist_id:
        first = await track_info(video_id)
        if first and first["type"] == "video":
            audio = await audio_version(video_id)
            if audio:
                seed = audio["videoId"]
    data = await _watch(seed, playlist_id)
    songs = [t for t in data["tracks"] if t["type"] == "song"]
    return {**data, "tracks": songs or data["tracks"]}


@cached(ttl=86400)
async def track_info(video_id: str) -> dict | None:
    for t in (await _watch(video_id))["tracks"]:
        if t["videoId"] == video_id:
            return t
    return None


@cached(ttl=86400)
async def lyrics(video_id: str) -> dict:
    lyrics_id = (await _watch(video_id)).get("lyricsId")
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
