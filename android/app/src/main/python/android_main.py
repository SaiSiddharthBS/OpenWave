"""Starts the OpenWave engine inside the Android app (called from Kotlin via Chaquopy)."""

import os
import threading
import time
import urllib.request

_server = None


def _log(message: str) -> None:
    print(f"OpenWave engine: {message}", flush=True)  # Chaquopy sends stdout to logcat (python.stdout)


def start(data_dir: str, port: int = 47878, host: str = "127.0.0.1", device_name: str = "") -> None:
    """Run the HTTP server on a background thread; returns once it answers."""
    global _server
    if _server is not None:
        return
    began = time.time()
    os.environ["OPENWAVE_DATA"] = data_dir
    # Other devices on the Wi-Fi see this phone by its name, and can find it out of the box.
    os.environ["OPENWAVE_DEVICE_NAME"] = device_name or "Android phone"
    os.environ["OPENWAVE_DEVICE_KIND"] = "phone"
    os.environ["OPENWAVE_LINK"] = "1"
    import certifi

    # Python on Android has no system CA bundle: point every HTTP stack at certifi's.
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
    os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

    from openwave import updater

    updater.activate()  # newer yt-dlp / ytmusicapi downloaded earlier take priority
    import uvicorn

    from openwave.app import app

    _log(f"imported in {time.time() - began:.1f}s")
    config = uvicorn.Config(app, host=host, port=port, log_level="warning", loop="asyncio", http="h11", ws="none")
    _server = uvicorn.Server(config)
    threading.Thread(target=_server.run, name="openwave-engine", daemon=True).start()

    # Never let a local health probe go through a proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline = time.time() + 120
    last_error = None
    while time.time() < deadline:
        try:
            with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=2) as r:
                if r.status == 200:
                    _log(f"listening on {host}:{port} after {time.time() - began:.1f}s")
                    break
        except Exception as e:  # noqa: BLE001 - keep polling until the deadline
            last_error = e
            time.sleep(0.25)
    else:
        raise RuntimeError(f"OpenWave engine did not start: {last_error}")
    updater.start_background()  # keep YouTube support current without an app update
