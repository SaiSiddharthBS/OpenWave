"""Settings → Phones → Start with Windows, against a stand-in registry (never the real one)."""

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
    monkeypatch.setattr(startup, "available", lambda: True)
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
        assert c.get("/api/connect/startup").json() == {"available": True, "on": False}
        assert c.post("/api/connect/startup", json={"on": True}).json() == {"available": True, "on": True}
        assert "OpenWave" in registry
        assert c.post("/api/connect/startup", json={"on": False}).json()["on"] is False


def test_only_the_windows_app(monkeypatch):
    monkeypatch.setattr(startup, "available", lambda: False)
    assert not startup.enabled()
    with TestClient(app.app) as c:
        assert c.get("/api/connect/startup").json() == {"available": False, "on": False}
        assert c.post("/api/connect/startup", json={"on": True}).status_code == 409

