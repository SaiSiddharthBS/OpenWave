"""Profiles, library sync, listening insights, smart radio and playlist import."""

from __future__ import annotations

import random

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from . import importer, music
from .config import data_dir
from .library import Library, LibraryError

router = APIRouter(prefix="/api")
_library: Library | None = None


def library() -> Library:
    global _library
    if _library is None:
        _library = Library(data_dir() / "openwave.db")
    return _library


def use_library(lib: Library) -> None:
    """Swap the backing store (tests)."""
    global _library
    _library = lib


def error_response(exc: LibraryError) -> JSONResponse:
    return JSONResponse({"error": str(exc)}, status_code=exc.status)


def _token(authorization: str | None = Header(default=None)) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def me(token: str | None = Depends(_token)) -> str:
    return library().authenticate(token)


def _device(request: Request) -> str:
    return request.headers.get("user-agent", "")[:120]


# --------------------------------------------------------------------------- profiles


class NewProfile(BaseModel):
    name: str
    color: str | None = None
    pin: str | None = None


class Login(BaseModel):
    pin: str | None = None


class ProfilePatch(BaseModel):
    name: str | None = None
    color: str | None = None
    pin: str | None = None
    removePin: bool = False


@router.get("/profiles")
def list_profiles():
    return library().profiles()


@router.post("/profiles")
def create_profile(body: NewProfile, request: Request):
    return library().create_profile(body.name, body.color, body.pin or None, _device(request))


@router.post("/profiles/{profile_id}/login")
def login(profile_id: str, body: Login, request: Request):
    return library().login(profile_id, body.pin or None, _device(request))


@router.post("/me/logout")
def logout(token: str | None = Depends(_token)):
    if token:
        library().logout(token)
    return {"ok": True}


@router.patch("/me")
def update_me(body: ProfilePatch, pid: str = Depends(me)):
    return library().update_profile(pid, body.name, body.color, body.pin or None, body.removePin)


@router.delete("/me")
def delete_me(pid: str = Depends(me)):
    library().delete_profile(pid)
    return {"ok": True}


# --------------------------------------------------------------------------- library sync


@router.get("/me/library")
def snapshot(pid: str = Depends(me)):
    return library().snapshot(pid)


@router.get("/me/version")
def version(pid: str = Depends(me)):
    return {"version": library().version(pid)}


@router.post("/me/ops")
async def ops(request: Request, pid: str = Depends(me)):
    body = await request.json()
    return {"version": library().apply_ops(pid, body.get("ops") if isinstance(body, dict) else body)}


@router.get("/me/stats")
def stats(days: int = 30, tz: int = 0, pid: str = Depends(me)):
    return library().stats(pid, max(1, min(days, 3650)), tz)


# --------------------------------------------------------------------------- smart radio


@router.get("/me/radio/{video_id}")
async def smart_radio(video_id: str, pid: str = Depends(me)):
    """Up-next tracks that skip what you've played recently, so autoplay keeps feeling fresh."""
    if not music.VIDEO_ID_RE.match(video_id):
        raise HTTPException(400, "invalid video id")
    recent = set(library().recent_video_ids(pid, 150))
    data = await music.up_next(video_id)
    fresh = [t for t in data["tracks"] if t["videoId"] not in recent and t["videoId"] != video_id]
    if len(fresh) < 8:
        # Seed a second radio from a liked song for variety.
        liked = library().snapshot(pid)["liked"][:25]
        if liked:
            extra = await music.up_next(random.choice(liked)["videoId"])
            have = {t["videoId"] for t in fresh} | recent
            fresh += [t for t in extra["tracks"] if t["videoId"] not in have]
    return {"tracks": fresh or data["tracks"][1:]}


@router.get("/me/mixes")
async def mixes(pid: str = Depends(me)):
    """Seeds for personal mixes, built from what you actually listen to."""
    lib = library()
    top = lib.stats(pid, 90)
    liked = lib.snapshot(pid)["liked"]
    seeds, used = [], set()
    for t in top["topTracks"]:
        artist = (t.get("artists") or [{}])[0].get("name")
        if t["videoId"] in used or artist in used:
            continue
        used |= {t["videoId"], artist}
        seeds.append({"seed": t, "title": f"{artist or t['title']} Mix", "subtitle": f"{t['title']} and more like it"})
        if len(seeds) == 6:
            break
    for t in liked:
        if len(seeds) >= 6:
            break
        if t["videoId"] not in used:
            used.add(t["videoId"])
            seeds.append({"seed": t, "title": f"Because you liked {t['title']}", "subtitle": "A mix inspired by a song you love"})
    return {"mixes": seeds, "topArtists": top["topArtists"][:8]}


# --------------------------------------------------------------------------- import


@router.post("/import/parse")
async def import_parse(request: Request, _: str = Depends(me)):
    try:
        return await importer.parse(await request.json())
    except importer.ImportError_ as e:
        raise HTTPException(422, str(e)) from e


@router.post("/import/match")
async def import_match(request: Request, _: str = Depends(me)):
    body = await request.json()
    items = body.get("items") if isinstance(body, dict) else None
    if not isinstance(items, list):
        raise HTTPException(400, "items required")
    return {"matches": await importer.match(items[:100])}
