"""Bring playlists in from elsewhere: Spotify links, Exportify CSV files, or plain "Artist - Title" lists.

Parsing produces generic items ({title, artist, album, duration}); `match` finds each one on YouTube Music.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import re

import httpx

from . import music

SPOTIFY_RE = re.compile(r"open\.spotify\.com/(?:intl-[a-z]+/)?(playlist|album)/([A-Za-z0-9]{10,40})")


class ImportError_(Exception):
    pass


async def parse_spotify(url: str) -> dict:
    m = SPOTIFY_RE.search(url)
    if not m:
        raise ImportError_("That doesn't look like a Spotify playlist or album link")
    kind, sid = m.groups()
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": "Mozilla/5.0"}) as client:
        r = await client.get(f"https://open.spotify.com/embed/{kind}/{sid}")
    blob = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', r.text, re.S)
    if r.status_code != 200 or not blob:
        raise ImportError_("Spotify didn't return that playlist. Make sure it's public, or import an Exportify CSV instead.")
    try:
        entity = json.loads(blob.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (KeyError, TypeError, json.JSONDecodeError) as e:
        raise ImportError_("Spotify changed its page format; please import an Exportify CSV instead") from e
    items = [
        {"title": t.get("title"), "artist": t.get("subtitle"), "duration": round((t.get("duration") or 0) / 1000) or None}
        for t in entity.get("trackList") or [] if t.get("title")
    ]
    return {"name": entity.get("name") or "Imported from Spotify", "items": items, "source": "spotify",
            "note": "Spotify only shares the first 100 songs of a link. For bigger playlists, use an Exportify CSV." if len(items) >= 100 else None}


def parse_csv(text: str) -> dict:
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise ImportError_("The CSV file is empty")
    keys = {k.lower().strip(): k for k in rows[0]}

    def col(*names):
        return next((keys[n] for n in names if n in keys), None)

    title, artist = col("track name", "title", "name", "song"), col("artist name(s)", "artist name", "artist", "artists")
    album, dur = col("album name", "album"), col("duration (ms)", "duration_ms", "track duration (ms)")
    if not title:
        raise ImportError_("Couldn't find a track name column (expected e.g. 'Track Name' from Exportify)")
    items = []
    for r in rows:
        if not (r.get(title) or "").strip():
            continue
        d = r.get(dur) if dur else None
        items.append({
            "title": r[title].strip(),
            "artist": (r.get(artist) or "").split(",")[0].strip() if artist else "",
            "album": (r.get(album) or "").strip() if album else "",
            "duration": round(int(d) / 1000) if d and str(d).isdigit() else None,
        })
    return {"name": "Imported playlist", "items": items, "source": "csv"}


def parse_text(text: str) -> dict:
    items = []
    for line in text.splitlines():
        line = re.sub(r"^\s*\d+[.)]\s*", "", line).strip()
        if not line:
            continue
        artist, sep, title = line.partition(" - ")
        items.append({"title": title.strip(), "artist": artist.strip()} if sep else {"title": line, "artist": ""})
    if not items:
        raise ImportError_("Paste one song per line, like “Artist - Title”")
    return {"name": "Imported playlist", "items": items, "source": "text"}


async def parse(payload: dict) -> dict:
    if payload.get("url"):
        url = payload["url"].strip()
        if "spotify.com" in url:
            return await parse_spotify(url)
        link = music.parse_youtube_url(url)
        if link and link[0] == "playlist":
            p = await music.playlist(link[1])
            return {"name": p["title"], "tracks": p["tracks"], "items": [], "source": "youtube"}
        raise ImportError_("Paste a Spotify or YouTube playlist link")
    if payload.get("csv"):
        return parse_csv(payload["csv"])
    if payload.get("text"):
        return parse_text(payload["text"])
    raise ImportError_("Nothing to import")


def _score(item: dict, cand: dict) -> float:
    return music.match_score(item["title"], item.get("artist") or "", item.get("duration"), cand)


async def match_one(item: dict) -> dict | None:
    return await music.match_song(item["title"], item.get("artist") or "", item.get("duration"))


async def match(items: list[dict]) -> list[dict | None]:
    sem = asyncio.Semaphore(4)

    async def one(item):
        async with sem:
            return await match_one(item)

    return await asyncio.gather(*(one(i) for i in items[:100] if i.get("title")))
