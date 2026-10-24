"""Starts the OpenWave engine inside the Android app (called from Kotlin via Chaquopy)."""

import os
import threading
import time
import urllib.request

_server = None


def start(data_dir: str, port: int = 47878, host: str = "127.0.0.1") -> None:
    """Run the HTTP server on a background thread; returns once it answers."""
    global _server
    if _server is not None:
        return
    os.environ["OPENWAVE_DATA"] = data_dir
    import certifi

    # Python on Android has no system CA bundle: point every HTTP stack at certifi's.
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

    from openwave import updater

    updater.activate()  # newer yt-dlp / ytmusicapi downloaded earlier take priority
    import uvicorn

    from openwave.app import app

    config = uvicorn.Config(app, host=host, port=port, log_level="warning", loop="asyncio", http="h11", ws="none")
    _server = uvicorn.Server(config)
    threading.Thread(target=_server.run, name="openwave-engine", daemon=True).start()
    updater.start_background()  # keep YouTube support current without an app update

    deadline = time.time() + 120
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1) as r:
                if r.status == 200:
                    return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError("OpenWave engine did not start")

