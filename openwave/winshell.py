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


class Bridge:
    """What the page can ask of the window (window.pywebview.api in update.js and native.js)."""

    def open(self, url: str) -> bool:
        """Open a web address in the browser: other sites, and update downloads, so nothing gets
        stuck inside OpenWave's window."""
        if not isinstance(url, str) or not url.startswith(("https://", "http://")):
            return False
        import webbrowser

        return webbrowser.open(url)

    def selftest_report(self, text: str) -> None:
        """Only for the Windows build's check (OPENWAVE_SELFTEST): what the page found."""
        if os.getenv("OPENWAVE_SELFTEST") and os.getenv("OPENWAVE_DATA"):
            with open(Path(os.environ["OPENWAVE_DATA"]) / "selftest.txt", "a", encoding="utf-8") as f:
                f.write(f"{text}\n")


def _self_test(window) -> None:
    """Run a script in the page once it has loaded (OPENWAVE_SELFTEST: a file), for the Windows build's check."""
    path = os.getenv("OPENWAVE_SELFTEST")
    if path:
        try:
            window.evaluate_js(Path(path).read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            log.warning("self-test script failed: %s", e)


def open_window(url: str, data: Path) -> bool:
    """Show OpenWave and return when its window is closed: True, or False if WebView2 couldn't start."""
    try:
        import webview
    except Exception as e:  # noqa: BLE001 - not bundled, or its .NET part didn't load
        log.warning("WebView2 window unavailable: %s", e)
        return False
    # Songs start by themselves (the next one in the queue, or a tap on another device), and the
    # keyboard's media keys and Windows' media controls reach OpenWave, as in a browser app window.
    os.environ.setdefault("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                          "--autoplay-policy=no-user-gesture-required --enable-features=HardwareMediaKeyHandling")
    try:
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        width, height = _size(webview)
        window = webview.create_window("OpenWave", url, width=width, height=height, min_size=(400, 560),
                                       background_color="#0A0B14", text_select=True, js_api=Bridge())
        window.events.shown += lambda: _dark_title_bar(window)
        window.events.loaded += lambda: _self_test(window)
        webview.start(gui="edgechromium", private_mode=False, storage_path=str(data / "webview2"))
        return True
    except Exception as e:  # noqa: BLE001 - no WebView2 runtime, or it failed to start
        log.warning("WebView2 window failed: %s", e)
        return False
