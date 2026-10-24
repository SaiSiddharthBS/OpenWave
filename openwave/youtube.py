"""Media layer: resolve playable streams with yt-dlp.

googlevideo URLs are bound to the IP that requested them, so the browser never
talks to YouTube directly. The server resolves a video once, caches the
format list until the URLs expire, and proxies bytes (see app.py).
"""

from __future__ import annotations

import asyncio
import shutil
import time
from urllib.parse import parse_qs, urlparse

import yt_dlp

from .config import bin_dir


def _js_runtimes() -> dict:
    # yt-dlp needs a JavaScript runtime to solve YouTube's player challenges.
    # A packaged app ships its own Deno; otherwise use whatever is on PATH.
    found = {}
    bundled = bin_dir()
    for name in ("deno", "node", "bun"):
        exe = next((bundled / f for f in (name, f"{name}.exe") if bundled and (bundled / f).is_file()), None)
        if exe:
            found[name] = {"path": str(exe)}
        elif shutil.which(name):
            found[name] = {}
    return found


BASE_OPTS = {
    "quiet": True,
    "no_warnings": True,
    "noplaylist": True,
    "skip_download": True,
    "format": "bestaudio/best",
    "js_runtimes": _js_runtimes(),
}

# Preference order of itags per codec and quality. Opus/WebM is preferred wherever the client can
# play it: besides sounding better, WebKit misreads the length of YouTube's AAC files (it reports
# double), which breaks seeking and end-of-track detection in Safari and the macOS app.
AUDIO_QUALITY = {
    "opus": {
        "high": ["251", "250", "140", "249", "139"],
        "normal": ["251", "250", "140", "249", "139"],
        "low": ["249", "250", "139", "251", "140"],
    },
    "aac": {
        "high": ["140", "251", "250", "249", "139"],
        "normal": ["140", "251", "250", "249", "139"],
        "low": ["139", "140", "249", "250", "251"],
    },
}

# The visionOS client hands out URLs that work immediately. yt-dlp's default clients are
# sturdier but their URLs only become valid after the length of a (skipped) pre-roll ad,
# so they're the fallback rather than the first choice.
FAST_CLIENTS = ["visionos"]

_cache: dict[str, dict] = {}
_inflight: dict[tuple[str, bool], asyncio.Task] = {}


class StreamError(Exception):
    pass


def _extract(video_id: str, fast: bool) -> dict:
    opts = {**BASE_OPTS, "extractor_args": {"youtube": {"player_client": FAST_CLIENTS}}} if fast else BASE_OPTS
    with yt_dlp.YoutubeDL(opts) as ydl:
        try:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=False)
        except yt_dlp.utils.DownloadError as e:
            raise StreamError(str(e).removeprefix("ERROR: ")) from e

    formats = {}
    expires = time.time() + 5 * 3600
    for f in info.get("formats") or []:
        if f.get("protocol") != "https" or not f.get("url"):
            continue
        formats[f["format_id"]] = {
            "url": f["url"],
            "headers": f.get("http_headers") or {},
            "available_at": f.get("available_at") or 0,
            "audio": f.get("acodec") not in (None, "none"),
            "video": f.get("vcodec") not in (None, "none"),
            "ext": f.get("ext"),
            "abr": f.get("abr") or 0,
            "height": f.get("height") or 0,
            "size": f.get("filesize") or f.get("filesize_approx"),
        }
        exp = parse_qs(urlparse(f["url"]).query).get("expire")
        if exp:
            expires = min(expires, int(exp[0]))

    if not formats:
        raise StreamError("No playable formats found")
    if fast and not any(f["audio"] for f in formats.values()):
        raise StreamError("Fast client returned no audio")
    return {
        "id": video_id,
        "fast": fast,
        "title": info.get("title"),
        "duration": info.get("duration"),
        "formats": formats,
        "expires": expires - 600,  # refresh ten minutes early
    }


async def _extract_once(video_id: str, fast: bool) -> dict:
    """Concurrent callers (prefetch + play) share a single extraction."""
    key = (video_id, fast)
    task = _inflight.get(key)
    if task is None:
        task = asyncio.create_task(asyncio.to_thread(_extract, video_id, fast))
        _inflight[key] = task
        task.add_done_callback(lambda _: _inflight.pop(key, None))
    return await task


async def resolve(video_id: str, force: bool = False, robust: bool = False) -> dict:
    """Resolve (and cache) stream info. robust=True skips the fast client."""
    hit = _cache.get(video_id)
    if hit and not force and hit["expires"] > time.time() and not (robust and hit["fast"]):
        return hit
    info = None
    if not robust:
        try:
            info = await _extract_once(video_id, fast=True)
        except StreamError:
            info = None
    if info is None:
        info = await _extract_once(video_id, fast=False)
    _cache[video_id] = info
    if len(_cache) > 300:
        for key in sorted(_cache, key=lambda k: _cache[k]["expires"])[:50]:
            _cache.pop(key, None)
    return info


def pick_audio(info: dict, quality: str = "normal", codec: str | None = None) -> dict | None:
    fmts = info["formats"]
    codec = codec if codec in AUDIO_QUALITY else ("opus" if quality == "high" else "aac")  # older clients sent no codec
    table = AUDIO_QUALITY[codec]
    for itag in table.get(quality, table["normal"]):
        if itag in fmts:
            return fmts[itag]
    audio_only = [f for f in fmts.values() if f["audio"] and not f["video"]]
    if audio_only:
        return max(audio_only, key=lambda f: f["abr"])
    muxed = [f for f in fmts.values() if f["audio"]]
    return min(muxed, key=lambda f: f["height"]) if muxed else None
