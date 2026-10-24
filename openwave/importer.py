"""Bring playlists in from other music services and their export files.

Links: Spotify, YouTube / YouTube Music, Deezer, Apple Music and JioSaavn, read from what each
service shows publicly (Deezer's open API, public pages). Files: Exportify, TuneMyMusic and
Soundiiz CSVs (which cover Amazon Music, Tidal, SoundCloud and others), Spotify's own data
download, the Apple Music app's "Export Playlist" (text or XML), Google Takeout for YouTube
Music, and plain "Artist - Title" lists.

Parsing produces playlists of generic items ({title, artist, album, duration} or {videoId});
`match` finds each item on YouTube Music.
"""

from __future__ import annotations

import asyncio
import csv
import io
import json
import plistlib
import re
from collections import OrderedDict

import httpx

from . import music

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/130.0 Safari/537.36", "Accept-Language": "en"}
SPOTIFY_RE = re.compile(r"open\.spotify\.com/(?:intl-[a-z]+/)?(?:embed/)?(playlist|album)/([A-Za-z0-9]{10,40})")
DEEZER_RE = re.compile(r"deezer\.com/(?:[a-z]{2}/)?(playlist|album)/(\d+)")
APPLE_RE = re.compile(r"music\.apple\.com/[a-z]{2}/(playlist|album)/")
SAAVN_RE = re.compile(r"jiosaavn\.com/(featured|s/playlist|album)/")
SHORT_LINKS = ("link.deezer.com", "deezer.page.link", "spotify.link")

SUPPORTED = "Spotify, YouTube Music, Apple Music, Deezer or JioSaavn"


class ImportError_(Exception):
    pass


def playlist(name: str, items: list[dict], source: str, note: str | None = None, tracks: list | None = None) -> dict:
    return {"name": (name or "Imported playlist").strip()[:120], "items": items, "tracks": tracks or [], "source": source, "note": note}


def _secs(value) -> int | None:
    """Seconds from milliseconds, seconds, "PT3M28S" or "3:28"."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return round(value / 1000) if value > 10_000 else round(value)
    s = str(value).strip()
    if s.isdigit():
        return _secs(int(s))
    m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", s)
    if m and any(m.groups()):
        h, mi, se = (int(x or 0) for x in m.groups())
        return h * 3600 + mi * 60 + se
    return music.parse_duration(s)


def _item(title, artist="", album="", duration=None) -> dict | None:
    def clean(v):
        return re.sub(r"\s+", " ", str(v or "")).strip()

    title = clean(title)
    return {"title": title, "artist": clean(artist), "album": clean(album), "duration": _secs(duration)} if title else None


# --------------------------------------------------------------------------- links


async def _get(client: httpx.AsyncClient, url: str) -> httpx.Response:
    try:
        r = await client.get(url)
    except httpx.HTTPError as e:
        raise ImportError_("Couldn't reach that service. Check your connection and try again.") from e
    if r.status_code == 404:
        raise ImportError_("That playlist wasn't found. Make sure it's public and the link is complete.")
    if r.status_code >= 400:
        raise ImportError_(f"The service refused the request (HTTP {r.status_code}). Try again in a moment.")
    return r


async def parse_spotify(client: httpx.AsyncClient, url: str) -> dict:
    m = SPOTIFY_RE.search(url)
    if not m:
        raise ImportError_("That doesn't look like a Spotify playlist or album link")
    kind, sid = m.groups()
    r = await _get(client, f"https://open.spotify.com/embed/{kind}/{sid}")
    blob = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', r.text, re.S)
    try:
        entity = json.loads(blob.group(1))["props"]["pageProps"]["state"]["data"]["entity"]
    except (AttributeError, KeyError, TypeError, json.JSONDecodeError) as e:
        raise ImportError_("Spotify didn't share that playlist. Make sure it's public, or import an Exportify file instead.") from e
    items = [i for t in entity.get("trackList") or [] if (i := _item(t.get("title"), t.get("subtitle"), "", t.get("duration")))]
    note = None
    if len(items) >= 100:
        note = ("Spotify only shares the first 100 songs of a link. To bring every song, export the playlist with "
                "exportify.app (or Spotify → Account → Privacy → Download your data) and import that file.")
    return playlist(entity.get("name") or "From Spotify", items, "spotify", note)


async def parse_deezer(client: httpx.AsyncClient, url: str) -> dict:
    m = DEEZER_RE.search(url)
    if not m:
        raise ImportError_("That doesn't look like a Deezer playlist or album link")
    kind, did = m.groups()
    info = (await _get(client, f"https://api.deezer.com/{kind}/{did}")).json()
    if info.get("error"):
        raise ImportError_("Deezer didn't share that playlist. Make sure it's public.")
    items, index = [], 0
    while True:
        page = (await _get(client, f"https://api.deezer.com/{kind}/{did}/tracks?limit=100&index={index}")).json()
        data = page.get("data") or []
        for t in data:
            album = (t.get("album") or {}).get("title") or (info.get("title") if kind == "album" else "")
            if i := _item(t.get("title"), (t.get("artist") or {}).get("name"), album, t.get("duration")):
                items.append(i)
        index += len(data)
        if not data or not page.get("next") or index >= (page.get("total") or 0):
            break
    return playlist(info.get("title") or "From Deezer", items, "deezer")


def _ld_json(html: str) -> dict:
    for blob in re.findall(r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>', html, re.S):
        try:
            data = json.loads(blob)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("@type") in ("MusicPlaylist", "MusicAlbum"):
            return data
    return {}


def _walk(node, found: list):
    if isinstance(node, dict):
        found.append(node)
        for v in node.values():
            _walk(v, found)
    elif isinstance(node, list):
        for v in node:
            _walk(v, found)
    return found


async def parse_apple(client: httpx.AsyncClient, url: str) -> dict:
    r = await _get(client, url)
    ld = _ld_json(r.text)
    name = ld.get("name") or "From Apple Music"
    items, total = [], None
    blob = re.search(r'id="serialized-server-data">(.*?)</script>', r.text, re.S)
    if blob:
        try:
            nodes = _walk(json.loads(blob.group(1)), [])
        except json.JSONDecodeError:
            nodes = []
        total = next((n["trackCount"] for n in nodes if isinstance(n.get("trackCount"), int)), None)
        for n in nodes:
            if isinstance(n.get("title"), str) and isinstance(n.get("artistName"), str) and "duration" in n:
                album = next((link.get("title") for link in n.get("tertiaryLinks") or [] if isinstance(link, dict)), "")
                if i := _item(n["title"], n["artistName"], album, n.get("duration")):
                    items.append(i)
    if not items:  # albums: the structured data is enough
        artist = (ld.get("byArtist") or [{}])
        artist = (artist[0] if isinstance(artist, list) and artist else artist or {}).get("name", "")
        items = [i for t in ld.get("track") or [] if (i := _item(t.get("name"), artist, name, t.get("duration")))]
    if not items:
        raise ImportError_("Apple Music didn't share that playlist. Make sure it's public (Share → Copy Link).")
    note = None
    if total and total > len(items):
        note = (f"Apple Music's page showed {len(items)} of {total} songs. For the rest, export the playlist from the "
                "Music app (File → Library → Export Playlist) and import that file.")
    return playlist(name, items, "apple", note)


async def parse_saavn(client: httpx.AsyncClient, url: str) -> dict:
    r = await _get(client, url)
    m = re.search(r"window\.__INITIAL_DATA__\s*=\s*(\{.*?\})\s*;?\s*</script>", r.text, re.S)
    try:
        raw = re.sub(r'new Date\(("[^"]*")\)', r"\1", m.group(1)).replace(":undefined", ":null")
        nodes = _walk(json.loads(raw), [])
    except (AttributeError, json.JSONDecodeError) as e:
        raise ImportError_("JioSaavn didn't share that playlist. Make sure the link is a public playlist or album.") from e
    holder = next((n for n in nodes if isinstance(n.get("list"), list) and n.get("list") and isinstance(n["list"][0], dict)
                   and n["list"][0].get("type") == "song"), None)
    if not holder:
        raise ImportError_("That JioSaavn page has no songs to import")

    def text(v):
        return v.get("text", "") if isinstance(v, dict) else (v or "")

    items = []
    for s in holder["list"]:
        artists = [a.get("name") for a in s.get("artists") or [] if a.get("role") in ("singer", "primary_artists")]
        if i := _item(text(s.get("title")), ", ".join(a for a in artists if a), text(s.get("album")), s.get("duration")):
            items.append(i)
    total = holder.get("list_count")
    note = f"JioSaavn's page showed {len(items)} of {total} songs." if isinstance(total, int) and total > len(items) else None
    return playlist(text(holder.get("title")) or "From JioSaavn", items, "jiosaavn", note)


async def parse_link(url: str) -> list[dict]:
    if not re.match(r"https?://", url):
        url = "https://" + url
    async with httpx.AsyncClient(timeout=25, headers=UA, follow_redirects=True) as client:
        if any(host in url for host in SHORT_LINKS):
            url = str((await _get(client, url)).url)
        if "spotify.com" in url:
            return [await parse_spotify(client, url)]
        if DEEZER_RE.search(url):
            return [await parse_deezer(client, url)]
        if APPLE_RE.search(url):
            return [await parse_apple(client, url)]
        if SAAVN_RE.search(url):
            return [await parse_saavn(client, url)]
    link = music.parse_youtube_url(url)
    if link and link[0] == "playlist":
        p = await music.playlist(link[1], limit=None)
        return [playlist(p["title"] or "From YouTube", [], "youtube", tracks=p["tracks"])]
    if "amazon." in url:
        raise ImportError_("Amazon Music doesn't share playlists publicly. Export it with tunemymusic.com "
                           "(free: Amazon Music → Export to file) and import the CSV on the File tab.")
    raise ImportError_(f"Paste a playlist link from {SUPPORTED}")


# --------------------------------------------------------------------------- files


def _stem(filename: str) -> str:
    stem = re.sub(r"\.[a-z0-9]+$", "", (filename or "").rsplit("/", 1)[-1], flags=re.I)
    return re.sub(r"-videos$", "", stem).strip() or "Imported playlist"


def parse_csv(text: str, filename: str = "") -> list[dict]:
    text = text.lstrip("\ufeff")
    # Older Google Takeout files start with a block of playlist details before the "Video Id" table.
    takeout = re.search(r"^video id,", text, re.I | re.M)
    if takeout and takeout.start() > 0:
        text = text[takeout.start():]
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise ImportError_("The CSV file is empty")
    keys = {k.lower().strip(): k for k in rows[0] if k}

    def col(*names):
        return next((keys[n] for n in names if n in keys), None)

    video = col("video id", "video_id", "videoid")
    title = col("track name", "title", "song name", "name", "song", "track")
    artist = col("artist name(s)", "artist name", "artist", "artists", "artist(s)", "artist names")
    album, dur = col("album name", "album"), col("duration (ms)", "duration_ms", "track duration (ms)", "duration")
    group = col("playlist name", "playlist")
    if not (title or video):
        raise ImportError_("Couldn't find a song title column. Exportify, TuneMyMusic, Soundiiz and Google Takeout files work.")
    lists: OrderedDict[str, list[dict]] = OrderedDict()
    for r in rows:
        if video and (vid := (r.get(video) or "").strip()) and re.fullmatch(r"[\w-]{11}", vid):
            item = {"videoId": vid, "title": vid}
        else:
            first_artist = ((r.get(artist) or "") if artist else "").split(",")[0]
            item = _item(r.get(title) if title else "", first_artist, r.get(album) if album else "", r.get(dur) if dur else None)
        if item:
            lists.setdefault(((r.get(group) or "").strip() if group else "") or _stem(filename), []).append(item)
    return [playlist(name, items, "csv") for name, items in lists.items()]


def parse_spotify_export(data) -> list[dict]:
    """Spotify → Account → Privacy → "Download your data": Playlist1.json and YourLibrary.json."""
    out = []
    for p in data.get("playlists") or []:
        items = []
        for entry in p.get("items") or []:
            t = entry.get("track") or {}
            if i := _item(t.get("trackName"), t.get("artistName"), t.get("albumName")):
                items.append(i)
        if items:
            out.append(playlist(p.get("name") or "From Spotify", items, "spotify"))
    if data.get("tracks"):
        items = [i for t in data["tracks"] if (i := _item(t.get("track"), t.get("artist"), t.get("album")))]
        if items:
            out.append(playlist("Liked Songs (Spotify)", items, "spotify"))
    return out


def parse_apple_xml(raw: bytes) -> list[dict]:
    """Music app → File → Library → Export Playlist… (XML)."""
    try:
        lib = plistlib.loads(raw)
    except Exception as e:  # noqa: BLE001 - plistlib raises several types
        raise ImportError_("That XML file isn't an Apple Music playlist export") from e
    tracks = lib.get("Tracks") or {}
    out = []
    for p in lib.get("Playlists") or []:
        if p.get("Master") or p.get("Distinguished Kind") or p.get("Visible") is False:
            continue
        items = []
        for entry in p.get("Playlist Items") or []:
            t = tracks.get(str(entry.get("Track ID"))) or {}
            if i := _item(t.get("Name"), t.get("Artist"), t.get("Album"), t.get("Total Time")):
                items.append(i)
        if items:
            out.append(playlist(p.get("Name") or "From Apple Music", items, "apple"))
    return out


def parse_apple_txt(text: str, filename: str) -> list[dict]:
    """Music app → File → Library → Export Playlist… (Unicode text, tab-separated)."""
    rows = list(csv.DictReader(io.StringIO(text.lstrip("\ufeff")), delimiter="\t"))
    items = [i for r in rows if (i := _item(r.get("Name"), r.get("Artist"), r.get("Album"), _secs(r.get("Time"))))]
    return [playlist(_stem(filename), items, "apple")] if items else []


def parse_text(text: str, name: str = "Imported playlist") -> list[dict]:
    items = []
    for line in text.splitlines():
        line = re.sub(r"^\s*\d+[.)]\s*", "", line).strip()
        if not line:
            continue
        artist, sep, title = line.partition(" - ")
        items.append(_item(title, artist) if sep else _item(line))
    items = [i for i in items if i]
    if not items:
        raise ImportError_("Paste one song per line, like “Artist - Title”")
    return [playlist(name, items, "text")]


def parse_file(text: str, filename: str = "") -> list[dict]:
    head = text.lstrip("\ufeff").lstrip()
    if head.startswith("<?xml") or head.startswith("<plist"):
        out = parse_apple_xml(head.encode("utf-8"))
    elif head.startswith("{") or head.startswith("["):
        try:
            data = json.loads(head)
        except json.JSONDecodeError as e:
            raise ImportError_("That JSON file couldn't be read") from e
        out = parse_spotify_export(data) if isinstance(data, dict) else []
        if not out:
            raise ImportError_("That JSON file isn't a Spotify data download or an OpenWave backup")
    elif "\t" in head.split("\n", 1)[0] and "Name" in head.split("\n", 1)[0]:
        out = parse_apple_txt(text, filename)
    elif "," in head.split("\n", 1)[0]:
        out = parse_csv(text, filename)
    else:
        out = parse_text(text, _stem(filename))
    out = [p for p in out if p["items"] or p["tracks"]]
    if not out:
        raise ImportError_("No songs found in that file")
    return out


async def parse(payload: dict) -> dict:
    if payload.get("url"):
        playlists = await parse_link(payload["url"].strip())
    elif payload.get("file") or payload.get("csv"):
        playlists = parse_file(payload.get("file") or payload["csv"], payload.get("filename") or "")
    elif payload.get("text"):
        playlists = parse_text(payload["text"])
    else:
        raise ImportError_("Nothing to import")
    if not any(p["items"] or p["tracks"] for p in playlists):
        raise ImportError_("That playlist is empty")
    return {"playlists": playlists}


# --------------------------------------------------------------------------- matching


async def match_one(item: dict) -> dict | None:
    if item.get("videoId"):
        return await music.track_info(item["videoId"])
    return await music.match_song(item["title"], item.get("artist") or "", item.get("duration"))


async def match(items: list[dict]) -> list[dict | None]:
    sem = asyncio.Semaphore(5)

    async def one(item):
        if not isinstance(item, dict) or not (item.get("title") or item.get("videoId")):
            return None
        async with sem:
            try:
                return await match_one(item)
            except Exception:  # noqa: BLE001 - one bad song shouldn't fail the batch
                return None

    return await asyncio.gather(*(one(i) for i in items))  # one answer per item, in order
