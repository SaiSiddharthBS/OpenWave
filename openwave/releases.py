"""Checks GitHub for a newer OpenWave release, so the apps can offer a one-tap update.

The engine runs on the same device as the app in every packaged build (Windows, Linux, the Mac
app and Android), so it can pick the right download for that device. Docker and source installs
update their own way and are never offered a download.
"""

from __future__ import annotations

import platform
import sys
import time

import httpx

from . import __version__
from .config import FROZEN

REPO = "SaiSiddharthBS/OpenWave"
CACHE_SECONDS = 6 * 3600
DOWNLOADS = {
    "android": "OpenWave-Android.apk",
    "windows": "OpenWave-Windows-Setup.exe",
    "linux": "OpenWave-Linux-x86_64.AppImage",
    "mac-arm64": "OpenWave-macOS-AppleSilicon.dmg",
    "mac-x86_64": "OpenWave-macOS-Intel.dmg",
}

_cache: dict = {"at": 0.0, "release": None}


def parse_version(v: str) -> tuple[int, ...]:
    parts = []
    for p in v.strip().lstrip("vV").split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def is_newer(candidate: str, current: str) -> bool:
    a, b = parse_version(candidate), parse_version(current)
    width = max(len(a), len(b))
    return a + (0,) * (width - len(a)) > b + (0,) * (width - len(b))


def device(client: str | None = None) -> str | None:
    """Which download fits the device this engine serves, or None when it updates another way."""
    if client == "android":
        return "android"
    if not FROZEN:
        return None
    if sys.platform == "win32":
        return "windows"
    if sys.platform == "darwin":
        return "mac-arm64" if platform.machine() == "arm64" else "mac-x86_64"
    if sys.platform.startswith("linux") and platform.machine() in ("x86_64", "AMD64"):
        return "linux"
    return None


async def latest_release(client: httpx.AsyncClient) -> dict | None:
    """The newest published release (cached for a few hours), or None when GitHub is unreachable."""
    if _cache["release"] is not None and time.time() - _cache["at"] < CACHE_SECONDS:
        return _cache["release"]
    try:
        r = await client.get(
            f"https://api.github.com/repos/{REPO}/releases/latest",
            headers={"Accept": "application/vnd.github+json"},
            timeout=8,
        )
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, ValueError):
        return _cache["release"]
    release = {
        "version": str(data.get("tag_name", "")).lstrip("vV"),
        "page": data.get("html_url") or f"https://github.com/{REPO}/releases/latest",
        "assets": {a["name"]: a["browser_download_url"] for a in data.get("assets", []) if "name" in a},
    }
    _cache.update(at=time.time(), release=release)
    return release


async def check(client: httpx.AsyncClient, client_hint: str | None = None) -> dict:
    release = await latest_release(client)
    target = device(client_hint)
    result = {"current": __version__, "latest": None, "newer": False, "available": False,
              "device": target, "download": None, "page": None}
    if not release or not release["version"]:
        return result
    result.update(latest=release["version"], page=release["page"], newer=is_newer(release["version"], __version__))
    if target and result["newer"]:
        result["download"] = release["assets"].get(DOWNLOADS[target])
        result["available"] = result["download"] is not None
    return result
