"""Desktop launcher for Windows and Linux: double-click → OpenWave opens in its own app window.

Starts the bundled server on 127.0.0.1, then opens it in a Chromium "app mode" window (Microsoft
Edge ships with every Windows 10/11 PC; Chrome/Chromium/Brave/Edge on Linux). Media keys and the
system media overlay work through the browser. Closing the window quits OpenWave. Without a
Chromium browser it falls back to the default browser and keeps running in the background.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

PREFERRED_PORT = 47878


def _free_port() -> int:
    for port in range(PREFERRED_PORT, PREFERRED_PORT + 20):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return PREFERRED_PORT


def _already_running(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
            return b'"ok":true' in r.read()
    except OSError:
        return False


def find_app_browser() -> list[str] | None:
    """A Chromium-family browser that supports --app windows."""
    candidates: list[str] = []
    if sys.platform == "win32":
        for base in filter(None, (os.getenv("PROGRAMFILES(X86)"), os.getenv("PROGRAMFILES"), os.getenv("LOCALAPPDATA"))):
            candidates += [
                rf"{base}\Microsoft\Edge\Application\msedge.exe",
                rf"{base}\Google\Chrome\Application\chrome.exe",
                rf"{base}\BraveSoftware\Brave-Browser\Application\brave.exe",
            ]
    elif sys.platform == "darwin":
        candidates += [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    for name in ("microsoft-edge", "microsoft-edge-stable", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser"):
        if found := shutil.which(name):
            candidates.append(found)
    for path in candidates:
        if Path(path).is_file():
            return [path]
    return None


def app_window_command(browser: list[str], url: str, profile_dir: Path) -> list[str]:
    return [
        *browser,
        f"--app={url}",
        f"--user-data-dir={profile_dir}",  # own profile: own window, own process, survives browser updates
        "--window-size=1280,820",
        "--no-first-run",
        "--no-default-browser-check",
        "--autoplay-policy=no-user-gesture-required",
    ]


def main() -> None:
    from . import updater

    updater.activate()
    from .config import FROZEN, data_dir

    if sys.stdout is None or sys.stderr is None:
        # Windowed builds (Windows .exe) have no console; logging would crash without somewhere to write.
        log = open(data_dir() / "openwave.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115
        sys.stdout = sys.stdout or log
        sys.stderr = sys.stderr or log

    if "--server-only" in sys.argv:  # headless mode for smoke tests: run the engine in the foreground
        import uvicorn

        from .app import app

        port = int(sys.argv[sys.argv.index("--port") + 1]) if "--port" in sys.argv else PREFERRED_PORT
        uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio", http="h11", ws="none")
        return

    port = _free_port()
    url = f"http://127.0.0.1:{port}/"
    if not _already_running(PREFERRED_PORT):
        import uvicorn

        from .app import app

        if FROZEN:
            updater.start_background()
        config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", loop="asyncio", http="h11", ws="none")
        server = uvicorn.Server(config)
        threading.Thread(target=server.run, name="openwave-server", daemon=True).start()
        for _ in range(200):
            if _already_running(port):
                break
            time.sleep(0.1)
    else:
        url = f"http://127.0.0.1:{PREFERRED_PORT}/"
        server = None

    browser = find_app_browser()
    if browser:
        proc = subprocess.Popen(app_window_command(browser, url, data_dir() / "window"))
        proc.wait()  # the window closed: quit
    else:
        webbrowser.open(url)
        print(f"OpenWave is running at {url} — close this window to quit.")
        try:
            while True:
                time.sleep(3600)
        except KeyboardInterrupt:
            pass
    if server:
        server.should_exit = True


if __name__ == "__main__":
    main()
