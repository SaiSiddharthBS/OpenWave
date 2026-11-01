"""Start with Windows: OpenWave opens in the background when you sign in, so a computer that's always
on keeps playing for its phones without anyone opening the app. While it's on, closing the OpenWave
window leaves OpenWave running (openwave/launcher.py).

It's the per-user Run entry in the registry, which needs no admin rights and is what Settings →
Apps → Startup in Windows lists and can switch off too. The uninstaller removes it.
"""

from __future__ import annotations

import sys

from .config import FROZEN

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
NAME = "OpenWave"
BACKGROUND = "--background"


def available() -> bool:
    """Only the installed Windows app has an OpenWave.exe for Windows to start."""
    return sys.platform == "win32" and FROZEN


def _command() -> str:
    return f'"{sys.executable}" {BACKGROUND}'


def enabled() -> bool:
    if not available():
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, NAME)
    except OSError:
        return False
    return bool(value)


def set_enabled(on: bool) -> None:
    if not available():
        raise RuntimeError("Only the Windows app can start with Windows.")
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        if on:
            winreg.SetValueEx(key, NAME, 0, winreg.REG_SZ, _command())
        else:
            try:
                winreg.DeleteValue(key, NAME)
            except FileNotFoundError:
                pass
