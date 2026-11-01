"""Settings → Phones → Start with Windows (or Linux), against a stand-in registry and a throwaway
autostart folder (never the real ones)."""

from __future__ import annotations

import sys
import types

import pytest
from fastapi.testclient import TestClient

from openwave import app, startup


@pytest.fixture
def registry(monkeypatch):
    """A `winreg` that keeps HKEY_CURRENT_USER's Run entries in a dict, as the Windows app sees it."""
    values: dict[str, str] = {}

    class Key:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def open_key(root, path):
        assert path == startup.RUN_KEY
        return Key()

    def query(key, name):
        if name not in values:
            raise FileNotFoundError(name)
        return values[name], 1

    def delete(key, name):
        if name not in values:
            raise FileNotFoundError(name)
        del values[name]

    fake = types.SimpleNamespace(HKEY_CURRENT_USER=object(), REG_SZ=1, OpenKey=open_key, CreateKey=open_key,
                                 QueryValueEx=query, DeleteValue=delete,
                                 SetValueEx=lambda key, name, _r, _t, value: values.__setitem__(name, value))
    monkeypatch.setitem(sys.modules, "winreg", fake)
    monkeypatch.setattr(startup, "system", lambda: "Windows")
    monkeypatch.setattr(sys, "executable", r"C:\Users\me\AppData\Local\Programs\OpenWave\OpenWave.exe")
    return values


def test_turns_on_and_off(registry):
    assert not startup.enabled()
    startup.set_enabled(True)
    assert registry == {"OpenWave": r'"C:\Users\me\AppData\Local\Programs\OpenWave\OpenWave.exe" --background'}
    assert startup.enabled()
    startup.set_enabled(False)
    startup.set_enabled(False)   # already off: nothing to remove, no error
    assert registry == {} and not startup.enabled()


def test_settings(registry):
    with TestClient(app.app) as c:
        assert c.get("/api/connect/startup").json() == {"available": True, "on": False, "system": "Windows"}
        assert c.post("/api/connect/startup", json={"on": True}).json() == {"available": True, "on": True, "system": "Windows"}
        assert "OpenWave" in registry
        assert c.post("/api/connect/startup", json={"on": False}).json()["on"] is False


def test_only_the_windows_and_linux_apps(monkeypatch):
    monkeypatch.setattr(startup, "system", lambda: None)
    assert not startup.available() and not startup.enabled()
    with TestClient(app.app) as c:
        assert c.get("/api/connect/startup").json() == {"available": False, "on": False, "system": None}
        assert c.post("/api/connect/startup", json={"on": True}).status_code == 409


def test_which_system():
    """Running from source (tests, Docker, pip) never sets anything up."""
    assert startup.system() is None


@pytest.fixture
def linux(tmp_path, monkeypatch):
    image = tmp_path / "Apps" / "My \"Music\" $HOME 100%" / "OpenWave-Linux-x86_64.AppImage"
    image.parent.mkdir(parents=True)
    image.write_text("")
    monkeypatch.setenv("APPIMAGE", str(image))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setattr(startup, "FROZEN", True)
    monkeypatch.setattr(sys, "platform", "linux")
    return tmp_path / "config" / "autostart" / "openwave.desktop", image


def test_linux_autostart(linux):
    entry, image = linux
    assert startup.system() == "Linux" and not startup.enabled()
    startup.set_enabled(True)
    text = entry.read_text()
    assert "[Desktop Entry]" in text and "Type=Application" in text
    exec_line = next(line for line in text.splitlines() if line.startswith("Exec="))
    # The Desktop Entry spec: " and $ escaped inside the quotes, % doubled, then each backslash
    # doubled for the file's own escapes, so My "Music" $HOME 100% is My \\\\"Music\\\\" \\\\$HOME 100%%.
    assert exec_line == 'Exec="' + str(image).replace('"', '\\\\"').replace("$", "\\\\$").replace("%", "%%") + '" --background'
    assert '\\\\"Music\\\\"' in exec_line
    assert startup.enabled()
    startup.set_enabled(False)
    startup.set_enabled(False)
    assert not entry.exists() and not startup.enabled()


def test_linux_needs_the_appimage(linux, monkeypatch):
    monkeypatch.delenv("APPIMAGE")
    assert startup.system() is None

