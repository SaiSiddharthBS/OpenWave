"""Keeps YouTube support working in packaged apps, which can't `pip install -U`.

YouTube changes often, and fixes ship as new yt-dlp / ytmusicapi releases. In a frozen build
(the macOS app) we periodically download the newest pure-Python wheels from PyPI into the data
directory, and on the next launch a meta-path finder loads them instead of the bundled copies.
"""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import json
import shutil
import sys
import threading
import time
import urllib.request
import zipfile
from pathlib import Path

from .config import data_dir

PACKAGES = {"yt-dlp": "yt_dlp", "yt-dlp-ejs": "yt_dlp_ejs", "ytmusicapi": "ytmusicapi"}
ROOT = data_dir() / "extractors"
CURRENT = ROOT / "current"
STATE = ROOT / "state.json"
CHECK_EVERY = 12 * 3600


class _UpdatedFirst(importlib.abc.MetaPathFinder):
    """Resolve the updated packages from CURRENT before any bundled/frozen copy."""

    def __init__(self, path: Path, names: set[str]):
        self.path, self.names = str(path), names

    def find_spec(self, fullname, path=None, target=None):
        top = fullname.split(".")[0]
        if top not in self.names:
            return None
        search = [self.path] if path is None else path
        return importlib.machinery.PathFinder.find_spec(fullname, search)


def _state() -> dict:
    try:
        return json.loads(STATE.read_text())
    except (OSError, ValueError):
        return {}


def activate() -> dict:
    """Call before importing yt_dlp / ytmusicapi."""
    state = _state()
    installed = {n for n in PACKAGES.values() if (CURRENT / n).is_dir()}
    if installed:
        sys.meta_path.insert(0, _UpdatedFirst(CURRENT, installed))
    return state.get("installed", {})


def _bundled_version(module: str) -> str | None:
    try:
        if module == "yt_dlp":
            from yt_dlp.version import __version__
        elif module == "ytmusicapi":
            from ytmusicapi import __version__
        else:
            from importlib.metadata import version
            return version("yt-dlp-ejs")
        return __version__
    except Exception:  # noqa: BLE001
        return None


def _newer(a: str, b: str | None) -> bool:
    def key(v):
        return tuple(int(x) if x.isdigit() else 0 for x in v.replace("-", ".").split("."))
    return b is None or key(a) > key(b)


def check_now() -> dict:
    """Download newer wheels (if any) into a staging dir, then swap it in for the next launch."""
    state = _state()
    have = state.get("installed", {})
    staging = ROOT / "staging"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    changed = {}
    for dist, module in PACKAGES.items():
        with urllib.request.urlopen(f"https://pypi.org/pypi/{dist}/json", timeout=20) as r:
            info = json.load(r)
        latest = info["info"]["version"]
        current = have.get(module) or _bundled_version(module)
        if not _newer(latest, current):
            if (CURRENT / module).is_dir():
                shutil.copytree(CURRENT / module, staging / module)
            continue
        wheel = next(f for f in info["urls"] if f["filename"].endswith("py3-none-any.whl"))
        with urllib.request.urlopen(wheel["url"], timeout=120) as r, zipfile.ZipFile(_spool(r)) as z:
            members = [m for m in z.namelist() if m.startswith(module + "/")]
            z.extractall(staging, members)
        changed[module] = latest
    if changed:
        old = ROOT / "previous"
        shutil.rmtree(old, ignore_errors=True)
        if CURRENT.exists():
            CURRENT.rename(old)
        staging.rename(CURRENT)
        have.update(changed)
    else:
        shutil.rmtree(staging, ignore_errors=True)
    state.update({"installed": have, "checked": time.time(), "pending": changed or state.get("pending", {})})
    STATE.write_text(json.dumps(state))
    return changed


def _spool(resp):
    import io
    return io.BytesIO(resp.read())


def start_background() -> None:
    def loop():
        while True:
            if time.time() - _state().get("checked", 0) > CHECK_EVERY:
                try:
                    check_now()
                except Exception as e:  # noqa: BLE001 - offline, PyPI down, …
                    print(f"extractor update check failed: {e}", file=sys.stderr)
            time.sleep(3600)

    threading.Thread(target=loop, name="extractor-updates", daemon=True).start()
