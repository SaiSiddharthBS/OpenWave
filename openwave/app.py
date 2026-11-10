"""HTTP API + static frontend."""

from __future__ import annotations

import asyncio
import hashlib
import logging
import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from starlette.datastructures import Headers
from starlette.staticfiles import NotModifiedResponse

from . import __version__, connect, explore, link, music, releases, updater, youtube
from .api_connect import error_response as connect_error, host as connect_host, router as connect_router
from .api_library import error_response, library, router as library_router, sync as shared_sync
from .config import FROZEN, data_dir
from .library import LibraryError

WEB = Path(__file__).parent / "web"
CHUNK = 4 * 1024 * 1024  # bytes per upstream request; mirrors how YouTube's own players fetch

IMAGE_HOSTS = ("i.ytimg.com", "lh3.googleusercontent.com", "yt3.googleusercontent.com", "yt3.ggpht.com", "music.youtube.com")
PASS_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag")

client = httpx.AsyncClient(timeout=httpx.Timeout(20, read=60), follow_redirects=True)


@asynccontextmanager
async def lifespan(this: FastAPI):
    await link.hub.start()
    await shared_sync().start()
    phones = connect_host(this)
    if phones:
        # Profiles kept on a phone that's no longer paired (e.g. a reset connect.json) open up again.
        library().release_phones(keep=set(phones.state["devices"]))
        try:
            await phones.start()
        except Exception:  # noqa: BLE001 - phones away from home can't connect, everything else works
            logging.getLogger("openwave").exception("OpenWave Connect didn't start")
    yield
    if phones:
        await phones.stop()
    await shared_sync().stop()
    await link.hub.stop()
    await client.aclose()


app = FastAPI(title="OpenWave", version=__version__, docs_url="/api/docs", redoc_url=None, lifespan=lifespan)


app.include_router(library_router)
app.include_router(link.router)
app.include_router(connect_router)
app.add_exception_handler(LibraryError, lambda _req, exc: error_response(exc))
app.add_exception_handler(connect.ConnectError, lambda _req, exc: connect_error(exc))
app.add_exception_handler(link.LinkError, lambda _req, exc: link._error(exc))


@app.exception_handler(youtube.StreamError)
async def _stream_error(_: Request, exc: youtube.StreamError):
    return JSONResponse({"error": str(exc)}, status_code=422)


def _check_id(video_id: str) -> str:
    if not music.VIDEO_ID_RE.match(video_id):
        raise HTTPException(400, "invalid video id")
    return video_id


async def _guard(coro):
    """Upstream failures become a 502 with a readable message instead of a stack trace."""
    try:
        return await coro
    except HTTPException:
        raise
    except youtube.StreamError:
        raise
    except Exception as exc:  # noqa: BLE001 - ytmusicapi raises bare Exceptions
        raise HTTPException(502, f"YouTube request failed: {str(exc)[:160]}") from exc


# --------------------------------------------------------------------------- catalog


@app.get("/api/health")
async def health():
    import yt_dlp.version
    import ytmusicapi

    return {
        "ok": True,
        "version": __version__,
        "api": connect.API,
        "connect": bool(connect_host() and connect_host().started),
        "jsRuntimes": list(youtube.BASE_OPTS["js_runtimes"]),
        "ytDlp": yt_dlp.version.__version__,
        "ytmusicapi": ytmusicapi.__version__,
        "packaged": FROZEN,
        "dataDir": str(data_dir()),
        "extractorUpdates": updater._state().get("pending", {}),
    }


@app.get("/api/app-update")
async def app_update(client_hint: str | None = Query(None, alias="client"), current: str | None = Query(None, max_length=20)):
    """Is a newer OpenWave out, and which file should this device download?"""
    return await releases.check(client, client_hint, current)


@app.get("/api/search")
async def search(q: str = Query(..., min_length=1, max_length=300), type: str = "all"):
    if type not in ("all", "songs", "albums", "artists", "playlists"):
        raise HTTPException(400, "unknown search type")
    return await _guard(music.search(q.strip(), type))


@app.get("/api/suggest")
async def suggest(q: str = Query(..., min_length=1, max_length=200)):
    return await _guard(music.suggest(q.strip()))


@app.get("/api/home")
async def home():
    return await _guard(music.home())


@app.get("/api/album/{browse_id}")
async def album(browse_id: str):
    return await _guard(music.album(browse_id))


@app.get("/api/playlist/{playlist_id}")
async def playlist(playlist_id: str):
    return await _guard(music.playlist(playlist_id))


@app.get("/api/artist/{channel_id}")
async def artist(channel_id: str):
    return await _guard(music.artist(channel_id))


@app.get("/api/next/{video_id}")
async def up_next(video_id: str, playlistId: str | None = None):
    return await _guard(music.up_next(_check_id(video_id), playlistId))


@app.get("/api/audio/{video_id}")
async def audio(video_id: str, title: str = "", artist: str = ""):
    """The audio-track version of a video (OpenWave plays songs, not music videos). Passing the
    video's title and artist, when the app has them, saves a lookup."""
    info = await _guard(music.audio_version(_check_id(video_id), title[:200], artist[:200]))
    if not info:
        raise HTTPException(404, "no audio version")
    return info


@app.get("/api/length/{video_id}")
async def length(video_id: str):
    """How long a song really is, from YouTube's own details for its stream. WebKit (Safari, the Mac
    app) reports twice the length of some AAC files and then plays silence, and some lists leave the
    length out, so the player checks with this. Usually free: playing a song resolves its stream anyway."""
    info = await _guard(youtube.resolve(_check_id(video_id)))
    return {"seconds": info.get("duration") or 0}


@app.get("/api/track/{video_id}")
async def track(video_id: str):
    info = await _guard(music.track_info(_check_id(video_id)))
    if not info:
        raise HTTPException(404, "track not found")
    return info


@app.get("/api/lyrics/{video_id}")
async def lyrics(video_id: str):
    return await _guard(music.lyrics(_check_id(video_id)))


@app.get("/api/explore")
async def explore_world():
    """Countries with charts, genres, moods, and today's featured country."""
    return await _guard(explore.world())


@app.get("/api/explore/country/{code}")
async def explore_country(code: str):
    code = code.upper()
    if not explore.COUNTRY_RE.match(code):
        raise HTTPException(400, "unknown country")
    return await _guard(explore.country(code))


@app.get("/api/explore/genre/{params}")
async def explore_genre(params: str):
    if not explore.PARAMS_RE.match(params):
        raise HTTPException(400, "unknown genre")
    return await _guard(explore.genre(params))


# --------------------------------------------------------------------------- media


@app.post("/api/prefetch/{video_id}")
async def prefetch(video_id: str, mv: bool = False, title: str = "", artist: str = ""):
    """Resolve a stream ahead of time so the next track starts instantly. For a music video (mv=1)
    the song version is looked up first, since that's what the player will actually play."""
    _check_id(video_id)

    async def run():
        try:
            target = video_id
            if mv:
                song = await music.audio_version(video_id, title[:200], artist[:200])
                target = song["videoId"] if song else video_id
            await youtube.resolve(target)
        except Exception:  # noqa: BLE001 - best effort
            pass

    asyncio.create_task(run())
    return {"ok": True}


def _clamp_range(header: str | None, size: int | None) -> str:
    """Turn open-ended range requests into bounded chunks; googlevideo throttles huge ranges."""
    m = re.match(r"bytes=(\d+)-(\d*)$", header or "")
    start = int(m.group(1)) if m else 0
    end = int(m.group(2)) if m and m.group(2) else None
    limit = start + CHUNK - 1
    end = limit if end is None or end > limit else end
    if size:
        end = min(end, size - 1)
    return f"bytes={start}-{end}"


async def _open_upstream(video_id: str, quality: str, range_header: str | None, codec: str | None = None):
    robust = False
    for attempt in range(4):
        info = await youtube.resolve(video_id, force=attempt == 3, robust=robust)
        fmt = youtube.pick_audio(info, quality, codec)
        if not fmt:
            raise youtube.StreamError("No suitable stream for this video")
        wait = fmt["available_at"] - time.time()
        if wait > 0:
            # Some clients hand out URLs that only become valid a few seconds later.
            await asyncio.sleep(min(wait + 0.3, 10))
        headers = {k: v for k, v in fmt["headers"].items() if k.lower() in ("user-agent", "accept-language")}
        headers["Range"] = _clamp_range(range_header, fmt["size"])
        resp = await client.send(client.build_request("GET", fmt["url"], headers=headers), stream=True)
        if resp.status_code < 400:
            return resp
        await resp.aclose()
        if resp.status_code != 403:
            break
        if info["fast"]:
            robust = True  # same itags, same bytes: switching clients mid-song is seamless
        else:
            await asyncio.sleep(0.8)
    raise youtube.StreamError(f"YouTube refused the stream (HTTP {resp.status_code})")


def _relay(resp: httpx.Response, extra: dict | None = None) -> StreamingResponse:
    headers = {k: v for k, v in resp.headers.items() if k.lower() in PASS_HEADERS}
    headers["accept-ranges"] = "bytes"
    headers["cache-control"] = "no-store"
    headers.update(extra or {})
    return StreamingResponse(resp.aiter_raw(), status_code=resp.status_code, headers=headers, background=BackgroundTask(resp.aclose))


@app.get("/api/stream/{video_id}")
async def stream(video_id: str, request: Request, q: str = "normal", codec: str | None = None):
    """Exactly the bytes the player asked for. YouTube is fetched in CHUNK-sized pieces, but the
    answer always covers the whole requested range: WebKit (Safari, the Mac app) treats a shorter
    answer to "bytes=N-" as the end of the song, which cut every song longer than one piece."""
    video_id = _check_id(video_id)
    range_header = request.headers.get("range")
    first = await _open_upstream(video_id, q, range_header, codec)
    total = _total_size(first)
    m = re.match(r"bytes=(\d+)-(\d*)$", range_header or "")
    if first.status_code != 206 or total is None or (range_header and not m):
        return _relay(first)
    start = int(m.group(1)) if m else 0
    end = min(int(m.group(2)), total - 1) if m and m.group(2) else total - 1
    headers = {k: v for k, v in first.headers.items() if k.lower() in ("content-type", "last-modified", "etag")}
    headers.update({"accept-ranges": "bytes", "cache-control": "no-store", "content-length": str(end - start + 1)})
    if range_header:
        headers["content-range"] = f"bytes {start}-{end}/{total}"
    body = _stitched(first, video_id, q, codec, start, end)
    return StreamingResponse(body, status_code=206 if range_header else 200, headers=headers)


async def _stitched(first: httpx.Response, video_id: str, q: str, codec: str | None, start: int, end: int):
    """Bytes start..end (inclusive), continuing piece by piece after `first`. A dropped upstream
    connection (e.g. while the song is paused) resumes from the exact byte rather than ending early."""
    resp, pos, failures = first, start, 0
    try:
        while pos <= end:
            before = pos
            try:
                async for chunk in resp.aiter_raw():
                    chunk = chunk[: end + 1 - pos]
                    pos += len(chunk)
                    yield chunk
                    if pos > end:
                        break
            except httpx.HTTPError:
                failures += 1
                if failures > 3:
                    raise
            finally:
                await resp.aclose()
            if pos > end:
                break
            if pos == before:
                failures += 1
                if failures > 3:
                    raise youtube.StreamError(f"YouTube stopped sending audio at byte {pos}")
            resp = await _open_upstream(video_id, q, f"bytes={pos}-{end}", codec)
    finally:
        await resp.aclose()


def _total_size(resp: httpx.Response) -> int | None:
    m = re.search(r"/(\d+)$", resp.headers.get("content-range", ""))
    return int(m.group(1)) if m else None


@app.get("/api/download/{video_id}")
async def download(video_id: str, q: str = "normal", codec: str | None = None):
    """The whole audio file in one response (fetched upstream chunk by chunk) for offline saving."""
    _check_id(video_id)
    first = await _open_upstream(video_id, q, "bytes=0-", codec)
    total = _total_size(first)
    if total is None:
        return _relay(first)
    return StreamingResponse(
        _stitched(first, video_id, q, codec, 0, total - 1),
        media_type=first.headers.get("content-type", "audio/mp4"),
        headers={"cache-control": "no-store", "content-length": str(total)},
    )


def _allowed(url: str, hosts: tuple[str, ...]) -> bool:
    p = urlparse(url)
    host = p.hostname or ""
    return p.scheme == "https" and any((host.endswith(h) or host == h[1:]) if h.startswith(".") else host == h for h in hosts)


@app.get("/api/img")
async def image(u: str):
    """Same-origin thumbnails: keeps viewers' IPs away from Google and lets the UI sample colours."""
    if not _allowed(u, IMAGE_HOSTS):
        raise HTTPException(400, "host not allowed")
    resp = await client.send(client.build_request("GET", u), stream=True)
    if resp.status_code >= 400:
        await resp.aclose()
        raise HTTPException(resp.status_code, "image unavailable")
    return _relay(resp, {"cache-control": "public, max-age=604800, immutable"})


# --------------------------------------------------------------------------- frontend


@app.get("/sw.js", include_in_schema=False)
async def service_worker():
    return FileResponse(WEB / "sw.js", media_type="text/javascript", headers={"cache-control": "no-cache"})


@app.get("/manifest.webmanifest", include_in_schema=False)
async def manifest():
    return FileResponse(WEB / "manifest.webmanifest", media_type="application/manifest+json")


@app.middleware("http")
async def revalidate_app_files(request: Request, call_next):
    """App files must be re-checked on every load (a cheap 304 when unchanged), or browsers and
    WebViews keep running parts of an old version for hours after OpenWave updates."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("cache-control", "no-cache")
    return response


class AppFiles(StaticFiles):
    """The app's own files, each with an ETag made from what's in it, and only the ETag decides
    whether a browser's copy is still current. The Android app unpacks every file dated 1980, so a
    date can't tell one version from the next, and the Starlette it bundles answered "not modified"
    on the date alone: after an update, the old scripts ran on until the WebView's cache let go."""

    _tags: dict[tuple, str] = {}

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = FileResponse(full_path, status_code=status_code, stat_result=stat_result)
        key = (str(full_path), stat_result.st_mtime, stat_result.st_size, stat_result.st_ino)
        tag = self._tags.get(key)
        if tag is None:
            tag = f'"{hashlib.md5(Path(full_path).read_bytes(), usedforsecurity=False).hexdigest()}"'
            self._tags[key] = tag
        response.headers["etag"] = tag
        asked = Headers(scope=scope).get("if-none-match", "")
        if tag in [t.strip().removeprefix("W/") for t in asked.split(",")]:
            return NotModifiedResponse(response.headers)
        return response


app.mount("/", AppFiles(directory=WEB, html=True), name="web")
