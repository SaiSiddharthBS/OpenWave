"""Where OpenWave keeps its data and bundled helper binaries."""

from __future__ import annotations

import os
import sys
from pathlib import Path


def data_dir() -> Path:
    """Library database, extractor updates, etc. Override with OPENWAVE_DATA."""
    if os.getenv("OPENWAVE_DATA"):
        path = Path(os.environ["OPENWAVE_DATA"]).expanduser()
    elif sys.platform == "darwin":
        path = Path.home() / "Library" / "Application Support" / "OpenWave"
    elif sys.platform == "win32":
        path = Path(os.getenv("APPDATA", Path.home())) / "OpenWave"
    else:
        path = Path(os.getenv("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "openwave"
    path.mkdir(parents=True, exist_ok=True)
    return path


def bin_dir() -> Path | None:
    """Helper binaries shipped with a packaged app (e.g. Deno inside OpenWave.app)."""
    if os.getenv("OPENWAVE_BIN_DIR"):
        return Path(os.environ["OPENWAVE_BIN_DIR"])
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent / "bin"
    return None


FROZEN = bool(getattr(sys, "frozen", False))
