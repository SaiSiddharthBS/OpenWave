"""Entry point for the server bundled inside the desktop app (frozen with PyInstaller)."""

from __future__ import annotations

import argparse


def main() -> None:
    # Must run before anything imports yt_dlp / ytmusicapi, so newer downloaded copies win.
    from . import updater

    updater.activate()

    parser = argparse.ArgumentParser(prog="openwave-server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=47878)
    args = parser.parse_args()

    import uvicorn

    from .app import app
    from .config import FROZEN

    if FROZEN:
        updater.start_background()
    # Pure-Python loop/protocol implementations keep the frozen bundle simple and portable.
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning", loop="asyncio", http="h11", ws="none")


if __name__ == "__main__":
    main()
