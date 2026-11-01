"""Start with Windows (and with Linux): OpenWave opens in the background when you sign in, so a
computer that's always on keeps playing for its phones without anyone opening the app. While it's
on, closing the OpenWave window leaves OpenWave running (openwave/launcher.py). The Mac app has
its own "Open OpenWave when I log in" (macos/), and keeps running in the menu bar anyway.

Windows: the per-user Run entry in the registry, which needs no admin rights and is what Settings →
Apps → Startup in Windows lists and can switch off too. The uninstaller removes it.
Linux: an autostart entry (~/.config/autostart/openwave.desktop) for the AppImage, which GNOME,
KDE, Xfce and the other desktops start when you log in.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from .config import FROZEN

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
NAME = "OpenWave"
BACKGROUND = "--background"


def _appimage() -> str | None:
    """The .AppImage file itself (its contents run from a temporary mount that changes every launch)."""
    path = os.environ.get("APPIMAGE")
    return path if path and os.path.isfile(path) else None


def system() -> str | None:
    """Which kind of start-at-sign-in this copy of OpenWave can set up, if any."""
    if not FROZEN:
        return None
    if sys.platform == "win32":
        return "Windows"
    if sys.platform.startswith("linux") and _appimage():
        return "Linux"
    return None


def available() -> bool:
    return system() is not None


def _autostart_file() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return Path(base) / "autostart" / "openwave.desktop"


def _desktop_quote(arg: str) -> str:
    """An Exec argument, quoted the way the Desktop Entry spec asks: \\ " ` $ escaped inside double
    quotes, % doubled, and then every backslash doubled again for the file's own string escapes."""
    escaped = "".join("\\" + c if c in '"`$\\' else c for c in arg)
    return f'"{escaped}"'.replace("%", "%%").replace("\\", "\\\\")


def _command() -> str:
    return f'"{sys.executable}" {BACKGROUND}'


def enabled() -> bool:
    kind = system()
    if kind == "Linux":
        return _autostart_file().is_file()
    if kind != "Windows":
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            value, _ = winreg.QueryValueEx(key, NAME)
    except OSError:
        return False
    return bool(value)


def set_enabled(on: bool) -> None:
    kind = system()
    if kind == "Linux":
        entry = _autostart_file()
        if on:
            entry.parent.mkdir(parents=True, exist_ok=True)
            tmp = entry.with_suffix(".tmp")
            tmp.write_text("[Desktop Entry]\nType=Application\nName=OpenWave\n"
                           "Comment=Keeps OpenWave ready for your phones\n"
                           f"Exec={_desktop_quote(_appimage() or '')} {BACKGROUND}\n"
                           "Terminal=false\nX-GNOME-Autostart-enabled=true\n", encoding="utf-8")
            tmp.replace(entry)
        else:
            entry.unlink(missing_ok=True)
        return
    if kind != "Windows":
        raise RuntimeError("Only the Windows and Linux apps can start when you sign in.")
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
        if on:
            winreg.SetValueEx(key, NAME, 0, winreg.REG_SZ, _command())
        else:
            try:
                winreg.DeleteValue(key, NAME)
            except FileNotFoundError:
                pass
