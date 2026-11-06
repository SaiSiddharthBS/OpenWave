"""The Windows app's own window: OpenWave in WebView2, the Edge engine that Windows 10 and 11 build
in for apps, the way the Mac app uses Apple's. It has its own window, name and taskbar button, with
no browser around it and nothing shared with the browser you use.

Everything is kept in OpenWave's data folder (your profile and settings on this PC survive a
restart). Links to other sites open in your browser. If WebView2 can't start, open_window() says
so and the launcher opens the Edge app window instead, so OpenWave always opens.
"""

from __future__ import annotations

import ctypes
import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

BACKGROUND = 0x00140B0A          # the app's background, #0A0B14, as Windows colours are written (0x00BBGGRR)
USE_DARK_TITLE_BAR = 20         # DWMWA_USE_IMMERSIVE_DARK_MODE (Windows 10 2004 and later)
CAPTION_COLOR = 35              # DWMWA_CAPTION_COLOR (Windows 11)


def _dark_title_bar(window) -> None:
    """A dark title bar in the app's own colour, so the window doesn't wear a light frame around a
    dark app. Each step is optional: an older Windows just keeps its usual title bar."""
    try:
        hwnd = int(window.native.Handle.ToInt64())
        dwm = ctypes.windll.dwmapi
        dwm.DwmSetWindowAttribute(hwnd, USE_DARK_TITLE_BAR, ctypes.byref(ctypes.c_int(1)), ctypes.sizeof(ctypes.c_int))
        dwm.DwmSetWindowAttribute(hwnd, CAPTION_COLOR, ctypes.byref(ctypes.c_uint(BACKGROUND)), ctypes.sizeof(ctypes.c_uint))
    except Exception as e:  # noqa: BLE001
        log.info("title bar left as it is: %s", e)


def _size(webview) -> tuple[int, int]:
    """1280 × 820, or nine tenths of a smaller screen."""
    try:
        screen = webview.screens[0]
        return min(1280, int(screen.width * 0.9)), min(820, int(screen.height * 0.9))
    except Exception:  # noqa: BLE001
        return 1280, 820


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
        width, height = _size(webview)
        window = webview.create_window("OpenWave", url, width=width, height=height, min_size=(400, 560), background_color="#0A0B14", text_select=True)
        window.events.shown += lambda: _dark_title_bar(window)
        webview.start(gui="edgechromium", private_mode=False, storage_path=str(data / "webview2"))
        return True
    except Exception as e:  # noqa: BLE001 - no WebView2 runtime, or it failed to start
        log.warning("WebView2 window failed: %s", e)
        return False
