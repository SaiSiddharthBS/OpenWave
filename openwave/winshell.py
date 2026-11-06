"""The Windows app's own window: OpenWave in WebView2, the Edge engine that Windows 10 and 11 build
in for apps, the way the Mac app uses Apple's. It has its own window, name and taskbar button, with
no browser around it and nothing shared with the browser you use.

Everything is kept in OpenWave's data folder (your profile and settings on this PC survive a
restart). Links to other sites open in your browser. If WebView2 can't start, open_window() says
so and the launcher opens the Edge app window instead, so OpenWave always opens.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)


def open_window(url: str, data: Path) -> bool:
    """Show OpenWave and return when its window is closed: True, or False if WebView2 couldn't start."""
    try:
        import webview
    except Exception as e:  # noqa: BLE001 - not bundled, or its .NET part didn't load
        log.warning("WebView2 window unavailable: %s", e)
        return False
    # Songs start by themselves (the next one in the queue, or a tap on another device), as in a browser
    # app window.
    os.environ.setdefault("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--autoplay-policy=no-user-gesture-required")
    try:
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        webview.create_window("OpenWave", url, width=1280, height=820, min_size=(400, 560), background_color="#0A0B14", text_select=True)
        webview.start(gui="edgechromium", private_mode=False, storage_path=str(data / "webview2"))
        return True
    except Exception as e:  # noqa: BLE001 - no WebView2 runtime, or it failed to start
        log.warning("WebView2 window failed: %s", e)
        return False
