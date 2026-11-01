"""aiortc imports PyAV (FFmpeg, ~60 MB) at load time for audio and video calls. OpenWave Connect
only uses data channels, so when PyAV isn't installed this stands in for it: every `av` module
and name resolves to an inert placeholder that is never called."""

from __future__ import annotations

import importlib.abc
import importlib.machinery
import importlib.util
import sys
import types


class _Placeholder:
    def __init__(self, *args, **kwargs):
        raise RuntimeError("audio and video calls aren't available in OpenWave")

    def __class_getitem__(cls, item):
        return cls


class _Module(types.ModuleType):
    def __getattr__(self, name: str):
        if name.startswith("__"):
            raise AttributeError(name)
        return _Placeholder


class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    def find_spec(self, fullname, path=None, target=None):
        if fullname == "av" or fullname.startswith("av."):
            return importlib.machinery.ModuleSpec(fullname, self, is_package=True)
        return None

    def create_module(self, spec):
        mod = _Module(spec.name)
        mod.__path__ = []
        return mod

    def exec_module(self, module):
        pass


def install() -> None:
    """Use the placeholder only when the real PyAV is missing."""
    if "av" in sys.modules or any(isinstance(f, _Finder) for f in sys.meta_path):
        return
    if importlib.util.find_spec("av") is None:
        sys.meta_path.append(_Finder())
