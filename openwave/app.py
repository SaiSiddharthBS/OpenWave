"""HTTP API + static frontend."""

from __future__ import annotations

import asyncio
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

from . import __version__, music, releases, updater, youtube
from .api_library import error_response, router as library_router
from .config import FROZEN, data_dir
from .library import LibraryError

WEB = Path(__file__).parent / "web"
CHUNK = 4 * 1024 * 1024  # bytes per upstream request; mirrors how YouTube's own players fetch

IMAGE_HOSTS = ("i.ytimg.com", "lh3.googleusercontent.com", "yt3.googleusercontent.com", "yt3.ggpht.com", "music.youtube.com")
PASS_HEADERS = ("content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag")

client = httpx.AsyncClient(timeout=httpx.Timeout(20, read=60), follow_redirects=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await client.aclose()


app = FastAPI(title="OpenWave", version=__version__, docs_url="/api/docs", redoc_url=None, lifespan=lifespan)


app.include_router(library_router)
app.add_exception_handler(LibraryError, lambda _req, exc: error_response(exc))


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
        "jsRuntimes": list(youtube.BASE_OPTS["js_runtimes"]),
        "ytDlp": yt_dlp.version.__version__,
        "ytmusicapi": ytmusicapi.__version__,
        "packaged": FROZEN,
        "dataDir": str(data_dir()),
        "extractorUpdates": updater._state().get("pending", {}),
    }


@app.get("/api/app-update")
async def app_update(client_hint: str | None = Query(None, alias="client")):
    """Is a newer OpenWave out, and which file should this device download?"""
    return await releases.check(client, client_hint)


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
async def audio(video_id: str):
    """The audio-track version of a video (OpenWave plays songs, not music videos)."""
    info = await _guard(music.audio_version(_check_id(video_id)))
    if not info:
        raise HTTPException(404, "no audio version")
    return info


@app.get("/api/track/{video_id}")
async def track(video_id: str):
    info = await _guard(music.track_info(_check_id(video_id)))
    if not info:
        raise HTTPException(404, "track not found")
    return info


@app.get("/api/lyrics/{video_id}")
async def lyrics(video_id: str):
    return await _guard(music.lyrics(_check_id(video_id)))


# --------------------------------------------------------------------------- media


@app.post("/api/prefetch/{video_id}")
async def prefetch(video_id: str):
    """Resolve a stream ahead of time so the next track starts instantly."""
    _check_id(video_id)

    async def run():
        try:
            await youtube.resolve(video_id)
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


app.mount("/", StaticFiles(directory=WEB, html=True), name="web")
