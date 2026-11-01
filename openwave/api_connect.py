"""Settings → Phones: pair phones with this engine through OpenWave Connect (see connect.py)."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from . import connect, shared
from .config import data_dir

router = APIRouter(prefix="/api/connect")
_host: connect.Host | None = None


def host(app=None) -> connect.Host | None:
    """The engine's Connect host, or None where Connect can't run (see connect.unavailable)."""
    global _host
    if _host is None and app is not None and connect.unavailable() is None:
        _host = connect.Host(app, data_dir() / "connect.json", shared.relays())
    return _host


def use_host(h: connect.Host | None) -> None:
    """Swap the host (tests)."""
    global _host
    _host = h


def error_response(exc: connect.ConnectError) -> JSONResponse:
    return JSONResponse({"error": str(exc)}, status_code=exc.status)


def _from_this_computer(request: Request) -> None:
    """A paired phone can use OpenWave, but only the computer itself (or a browser at home) adds
    and removes phones, so a lost phone can't keep itself paired."""
    if request.scope.get("openwave.connect"):
        raise HTTPException(403, "Manage phones from the computer running OpenWave.")


@router.get("")
async def status(request: Request):
    h = host()
    if h is None:
        return {"available": False, "reason": connect.unavailable() or "Starting…", "via": bool(request.scope.get("openwave.connect"))}
    return {"available": True, "via": bool(request.scope.get("openwave.connect")), **h.status()}


@router.post("/pair")
async def pair(request: Request):
    _from_this_computer(request)
    h = host()
    if h is None:
        raise HTTPException(409, connect.unavailable() or "OpenWave Connect is still starting.")
    return h.pair()


@router.post("/devices/{device}/remove")
async def remove(device: str, request: Request):
    _from_this_computer(request)
    h = host()
    if h is None:
        raise HTTPException(409, connect.unavailable() or "OpenWave Connect is still starting.")
    await h.remove(device)
    return {"ok": True}


@router.post("/me/remove")
async def forget_me(request: Request):
    """A phone unpairing itself ("Forget this computer" on the phone)."""
    dev = request.scope.get("openwave.connect")
    h = host()
    if not dev or h is None:
        raise HTTPException(400, "Only a paired phone can do this.")
    h.state["devices"].pop(dev, None)
    h._save()
    return {"ok": True}
