"""Per-profile music library in SQLite: likes, playlists, saves, plays, searches, settings.

Clients send *operations* (see `apply_ops`) and read the whole library back with `snapshot`.
Every batch bumps the profile's `version`, which other devices poll to know when to re-sync.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import secrets
import sqlite3
import threading
import time
from collections import Counter, defaultdict
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, pin_hash TEXT,
  version INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  device TEXT, created_at REAL NOT NULL, last_seen REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS tracks (video_id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS likes (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, video_id TEXT NOT NULL, liked_at REAL NOT NULL,
  PRIMARY KEY (profile_id, video_id)
);
CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE, position INTEGER NOT NULL,
  video_id TEXT NOT NULL, added_at REAL NOT NULL, PRIMARY KEY (playlist_id, position)
);
CREATE TABLE IF NOT EXISTS saved (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, kind TEXT NOT NULL, item_id TEXT NOT NULL,
  data TEXT NOT NULL, saved_at REAL NOT NULL, PRIMARY KEY (profile_id, kind, item_id)
);
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT, profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  video_id TEXT NOT NULL, played_at REAL NOT NULL, seconds REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS plays_by_time ON plays (profile_id, played_at);
CREATE TABLE IF NOT EXISTS searches (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE, query TEXT NOT NULL, at REAL NOT NULL,
  PRIMARY KEY (profile_id, query)
);
CREATE TABLE IF NOT EXISTS settings (
  profile_id TEXT PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE, data TEXT NOT NULL
);
"""

TRACK_FIELDS = ("type", "videoId", "title", "artists", "album", "duration", "thumbnail", "explicit")
CARD_FIELDS = ("type", "id", "title", "subtitle", "thumbnail")
SAVED_KINDS = ("album", "artist", "playlist")
COLORS = ("#7b7bff", "#2fc8ff", "#c45cff", "#ff6fae", "#ffb648", "#3ddc97", "#ff6b6b", "#8f7cff")
PLAY_COUNTS_AFTER = 30  # seconds listened before a play counts toward stats, like most services


class LibraryError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _clean_track(t: dict) -> dict:
    if not isinstance(t, dict) or not isinstance(t.get("videoId"), str) or len(t["videoId"]) != 11:
        raise LibraryError("invalid track")
    out = {k: t.get(k) for k in TRACK_FIELDS}
    out["title"] = str(out["title"] or "Unknown")[:300]
    out["artists"] = [{"name": str(a.get("name", ""))[:200], "id": a.get("id")} for a in (out["artists"] or []) if isinstance(a, dict)][:10]
    if not isinstance(out["album"], dict):
        out["album"] = None
    return out


def _clean_card(c: dict, kind: str) -> dict:
    if not isinstance(c, dict) or not c.get("id"):
        raise LibraryError("invalid item")
    out = {k: c.get(k) for k in CARD_FIELDS}
    out["type"] = kind
    return out


def _hash_pin(pin: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", pin.encode(), salt, 200_000)
    return f"{salt.hex()}${digest.hex()}"


def _check_pin(pin: str, stored: str) -> bool:
    salt, _, digest = stored.partition("$")
    return hmac.compare_digest(_hash_pin(pin, bytes.fromhex(salt)).partition("$")[2], digest)


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Library:
    def __init__(self, path: Path | str):
        self.db = sqlite3.connect(str(path), check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.failed_pins: dict[str, list[float]] = defaultdict(list)
        with self.lock:
            self.db.execute("PRAGMA journal_mode=WAL")
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.executescript(SCHEMA)

    # ------------------------------------------------------------------ helpers
    def _q(self, sql: str, args=()):
        return self.db.execute(sql, args)

    def _put_track(self, t: dict, now: float) -> str:
        t = _clean_track(t)
        self._q("INSERT INTO tracks (video_id, data, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(video_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
                (t["videoId"], json.dumps(t), now))
        return t["videoId"]

    def _tracks(self, rows) -> list[dict]:
        return [json.loads(r["data"]) for r in rows]

    def _own_playlist(self, profile_id: str, playlist_id: str) -> None:
        row = self._q("SELECT profile_id FROM playlists WHERE id = ?", (playlist_id,)).fetchone()
        if not row:
            raise LibraryError("playlist not found", 404)
        if row["profile_id"] != profile_id:
            raise LibraryError("not your playlist", 403)

    # ------------------------------------------------------------------ profiles & sessions
    def profiles(self) -> list[dict]:
        with self.lock:
            rows = self._q("SELECT id, name, color, pin_hash IS NOT NULL AS has_pin FROM profiles ORDER BY created_at").fetchall()
        return [{"id": r["id"], "name": r["name"], "color": r["color"], "hasPin": bool(r["has_pin"])} for r in rows]

    def create_profile(self, name: str, color: str | None = None, pin: str | None = None, device: str = "") -> dict:
        name = (name or "").strip()[:40]
        if not name:
            raise LibraryError("name required")
        if pin is not None and not (pin.isdigit() and 4 <= len(pin) <= 8):
            raise LibraryError("PIN must be 4–8 digits")
        with self.lock:
            count = self._q("SELECT COUNT(*) FROM profiles").fetchone()[0]
            if count >= 50:
                raise LibraryError("too many profiles on this server")
            pid = secrets.token_urlsafe(8)
            color = color if color in COLORS else COLORS[count % len(COLORS)]
            self._q("INSERT INTO profiles (id, name, color, pin_hash, created_at) VALUES (?, ?, ?, ?, ?)",
                    (pid, name, color, _hash_pin(pin) if pin else None, time.time()))
            return {"profile": {"id": pid, "name": name, "color": color, "hasPin": bool(pin)}, "token": self._new_session(pid, device)}

    def _new_session(self, profile_id: str, device: str) -> str:
        token = secrets.token_urlsafe(32)
        now = time.time()
        self._q("INSERT INTO sessions (token_hash, profile_id, device, created_at, last_seen) VALUES (?, ?, ?, ?, ?)",
                (_token_hash(token), profile_id, device[:120], now, now))
        return token

    def login(self, profile_id: str, pin: str | None = None, device: str = "") -> dict:
        with self.lock:
            row = self._q("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
            if not row:
                raise LibraryError("profile not found", 404)
            if row["pin_hash"]:
                recent = [t for t in self.failed_pins[profile_id] if t > time.time() - 600]
                self.failed_pins[profile_id] = recent
                if len(recent) >= 10:
                    raise LibraryError("too many wrong PINs, try again in 10 minutes", 429)
                if not pin or not _check_pin(pin, row["pin_hash"]):
                    recent.append(time.time())
                    raise LibraryError("wrong PIN", 401)
            profile = {"id": row["id"], "name": row["name"], "color": row["color"], "hasPin": bool(row["pin_hash"])}
            return {"profile": profile, "token": self._new_session(profile_id, device)}

    def authenticate(self, token: str | None) -> str:
        if not token:
            raise LibraryError("sign in to a profile first", 401)
        with self.lock:
            row = self._q("SELECT profile_id FROM sessions WHERE token_hash = ?", (_token_hash(token),)).fetchone()
            if not row:
                raise LibraryError("session expired, pick your profile again", 401)
            self._q("UPDATE sessions SET last_seen = ? WHERE token_hash = ?", (time.time(), _token_hash(token)))
            return row["profile_id"]

    def logout(self, token: str) -> None:
        with self.lock:
            self._q("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(token),))

    def update_profile(self, profile_id: str, name: str | None = None, color: str | None = None, pin: str | None = None, remove_pin: bool = False) -> dict:
        with self.lock:
            if name is not None and name.strip():
                self._q("UPDATE profiles SET name = ? WHERE id = ?", (name.strip()[:40], profile_id))
            if color in COLORS:
                self._q("UPDATE profiles SET color = ? WHERE id = ?", (color, profile_id))
            if pin is not None:
                if not (pin.isdigit() and 4 <= len(pin) <= 8):
                    raise LibraryError("PIN must be 4–8 digits")
                self._q("UPDATE profiles SET pin_hash = ? WHERE id = ?", (_hash_pin(pin), profile_id))
            elif remove_pin:
                self._q("UPDATE profiles SET pin_hash = NULL WHERE id = ?", (profile_id,))
        return next(p for p in self.profiles() if p["id"] == profile_id)

    def delete_profile(self, profile_id: str) -> None:
        with self.lock:
            self._q("DELETE FROM profiles WHERE id = ?", (profile_id,))

    # ------------------------------------------------------------------ reading
    def version(self, profile_id: str) -> int:
        with self.lock:
            return self._q("SELECT version FROM profiles WHERE id = ?", (profile_id,)).fetchone()["version"]

    def snapshot(self, profile_id: str) -> dict:
        with self.lock:
            prof = self._q("SELECT * FROM profiles WHERE id = ?", (profile_id,)).fetchone()
            liked = self._tracks(self._q(
                "SELECT t.data FROM likes l JOIN tracks t ON t.video_id = l.video_id WHERE l.profile_id = ? ORDER BY l.liked_at DESC",
                (profile_id,)))
            playlists = []
            for p in self._q("SELECT * FROM playlists WHERE profile_id = ? ORDER BY updated_at DESC", (profile_id,)).fetchall():
                tracks = self._tracks(self._q(
                    "SELECT t.data FROM playlist_tracks pt JOIN tracks t ON t.video_id = pt.video_id WHERE pt.playlist_id = ? ORDER BY pt.position",
                    (p["id"],)))
                playlists.append({"id": p["id"], "name": p["name"], "description": p["description"], "tracks": tracks,
                                  "created": p["created_at"] * 1000, "updated": p["updated_at"] * 1000})
            saved = {k: [] for k in SAVED_KINDS}
            for r in self._q("SELECT kind, data FROM saved WHERE profile_id = ? ORDER BY saved_at DESC", (profile_id,)):
                saved.setdefault(r["kind"], []).append(json.loads(r["data"]))
            history = self._tracks(self._q(
                "SELECT t.data FROM (SELECT video_id, MAX(played_at) AS last FROM plays WHERE profile_id = ? GROUP BY video_id "
                "ORDER BY last DESC LIMIT 200) h JOIN tracks t ON t.video_id = h.video_id ORDER BY h.last DESC",
                (profile_id,)))
            searches = [r["query"] for r in self._q("SELECT query FROM searches WHERE profile_id = ? ORDER BY at DESC LIMIT 12", (profile_id,))]
            srow = self._q("SELECT data FROM settings WHERE profile_id = ?", (profile_id,)).fetchone()
        return {
            "profile": {"id": prof["id"], "name": prof["name"], "color": prof["color"], "hasPin": bool(prof["pin_hash"])},
            "version": prof["version"],
            "liked": liked,
            "playlists": playlists,
            "albums": saved["album"],
            "artists": saved["artist"],
            "ytPlaylists": saved["playlist"],
            "history": history,
            "searches": searches,
            "settings": json.loads(srow["data"]) if srow else {},
        }

    # ------------------------------------------------------------------ writing
    def apply_ops(self, profile_id: str, ops: list[dict]) -> int:
        if not isinstance(ops, list) or len(ops) > 2000:
            raise LibraryError("ops must be a list of at most 2000 operations")
        with self.lock:
            self._q("BEGIN")
            try:
                for op in ops:
                    try:
                        self._apply(profile_id, op)
                    except (KeyError, TypeError, ValueError, AttributeError) as e:
                        raise LibraryError(f"malformed {op.get('op') if isinstance(op, dict) else 'op'}: {e}") from e
                self._q("UPDATE profiles SET version = version + 1 WHERE id = ?", (profile_id,))
                self._q("COMMIT")
            except Exception:
                self._q("ROLLBACK")
                raise
            return self.version(profile_id)

    def _apply(self, pid: str, op: dict) -> None:
        kind = op.get("op")
        now = time.time()
        at = float(op.get("at") or now * 1000) / 1000  # clients send milliseconds
        if kind == "like":
            vid = self._put_track(op["track"], now)
            self._q("INSERT OR REPLACE INTO likes (profile_id, video_id, liked_at) VALUES (?, ?, ?)", (pid, vid, at))
        elif kind == "unlike":
            self._q("DELETE FROM likes WHERE profile_id = ? AND video_id = ?", (pid, op["videoId"]))
        elif kind == "playlist.create":
            plid = str(op.get("id") or secrets.token_urlsafe(8))[:40]
            exists = self._q("SELECT profile_id FROM playlists WHERE id = ?", (plid,)).fetchone()
            if exists and exists["profile_id"] != pid:
                raise LibraryError("playlist id taken", 409)
            if not exists:
                self._q("INSERT INTO playlists (id, profile_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (plid, pid, str(op.get("name") or "My playlist")[:100], str(op.get("description") or "")[:500], at, at))
            if op.get("tracks"):
                self._apply(pid, {"op": "playlist.add", "id": plid, "tracks": op["tracks"], "at": op.get("at")})
        elif kind == "playlist.update":
            self._own_playlist(pid, op["id"])
            if op.get("name"):
                self._q("UPDATE playlists SET name = ? WHERE id = ?", (str(op["name"])[:100], op["id"]))
            if "description" in op:
                self._q("UPDATE playlists SET description = ? WHERE id = ?", (str(op["description"] or "")[:500], op["id"]))
            self._q("UPDATE playlists SET updated_at = ? WHERE id = ?", (now, op["id"]))
        elif kind == "playlist.add":
            self._own_playlist(pid, op["id"])
            have = {r["video_id"] for r in self._q("SELECT video_id FROM playlist_tracks WHERE playlist_id = ?", (op["id"],))}
            pos = self._q("SELECT COALESCE(MAX(position), -1) FROM playlist_tracks WHERE playlist_id = ?", (op["id"],)).fetchone()[0]
            for t in op.get("tracks") or []:
                vid = self._put_track(t, now)
                if vid in have:
                    continue
                have.add(vid)
                pos += 1
                self._q("INSERT INTO playlist_tracks (playlist_id, position, video_id, added_at) VALUES (?, ?, ?, ?)", (op["id"], pos, vid, at))
            self._q("UPDATE playlists SET updated_at = ? WHERE id = ?", (now, op["id"]))
        elif kind == "playlist.remove":
            self._own_playlist(pid, op["id"])
            order = [r["video_id"] for r in self._q("SELECT video_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position", (op["id"],))]
            self._set_order(op["id"], [v for v in order if v != op["videoId"]], now)
        elif kind == "playlist.reorder":
            self._own_playlist(pid, op["id"])
            current = {r["video_id"] for r in self._q("SELECT video_id FROM playlist_tracks WHERE playlist_id = ?", (op["id"],))}
            wanted = [v for v in op.get("videoIds") or [] if v in current]
            wanted += [v for v in current if v not in wanted]  # never lose tracks on a stale reorder
            self._set_order(op["id"], wanted, now)
        elif kind == "playlist.delete":
            self._own_playlist(pid, op["id"])
            self._q("DELETE FROM playlists WHERE id = ?", (op["id"],))
        elif kind == "save":
            k = op.get("kind")
            if k not in SAVED_KINDS:
                raise LibraryError("unknown save kind")
            card = _clean_card(op["card"], k)
            self._q("INSERT OR REPLACE INTO saved (profile_id, kind, item_id, data, saved_at) VALUES (?, ?, ?, ?, ?)",
                    (pid, k, str(card["id"]), json.dumps(card), at))
        elif kind == "unsave":
            self._q("DELETE FROM saved WHERE profile_id = ? AND kind = ? AND item_id = ?", (pid, op.get("kind"), str(op.get("id"))))
        elif kind == "play":
            vid = self._put_track(op["track"], now)
            seconds = max(0.0, min(float(op.get("seconds") or 0), 6 * 3600))
            self._q("INSERT INTO plays (profile_id, video_id, played_at, seconds) VALUES (?, ?, ?, ?)", (pid, vid, at, seconds))
        elif kind == "history.clear":
            self._q("DELETE FROM plays WHERE profile_id = ?", (pid,))
        elif kind == "search":
            q = str(op.get("q") or "").strip()[:200]
            if q:
                self._q("INSERT OR REPLACE INTO searches (profile_id, query, at) VALUES (?, ?, ?)", (pid, q, at))
        elif kind == "search.remove":
            self._q("DELETE FROM searches WHERE profile_id = ? AND query = ?", (pid, op.get("q")))
        elif kind == "settings":
            row = self._q("SELECT data FROM settings WHERE profile_id = ?", (pid,)).fetchone()
            merged = {**(json.loads(row["data"]) if row else {}), **(op.get("patch") or {})}
            self._q("INSERT OR REPLACE INTO settings (profile_id, data) VALUES (?, ?)", (pid, json.dumps(merged)[:20000]))
        elif kind == "reset":
            for table in ("likes", "playlists", "saved", "plays", "searches", "settings"):
                self._q(f"DELETE FROM {table} WHERE profile_id = ?", (pid,))
        else:
            raise LibraryError(f"unknown op {kind!r}")

    def _set_order(self, playlist_id: str, video_ids: list[str], now: float) -> None:
        added = {r["video_id"]: r["added_at"] for r in self._q("SELECT video_id, added_at FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))}
        self._q("DELETE FROM playlist_tracks WHERE playlist_id = ?", (playlist_id,))
        for pos, vid in enumerate(video_ids):
            self._q("INSERT INTO playlist_tracks (playlist_id, position, video_id, added_at) VALUES (?, ?, ?, ?)",
                    (playlist_id, pos, vid, added.get(vid, now)))
        self._q("UPDATE playlists SET updated_at = ? WHERE id = ?", (now, playlist_id))

    # ------------------------------------------------------------------ insights
    def stats(self, profile_id: str, days: int = 30, tz_offset_min: int = 0) -> dict:
        since = time.time() - days * 86400
        with self.lock:
            rows = self._q(
                "SELECT p.video_id, p.played_at, p.seconds, t.data FROM plays p JOIN tracks t ON t.video_id = p.video_id "
                "WHERE p.profile_id = ? AND p.played_at >= ? AND p.seconds >= ?",
                (profile_id, since, PLAY_COUNTS_AFTER)).fetchall()
        tracks: dict[str, dict] = {}
        track_plays: Counter = Counter()
        track_secs: Counter = Counter()
        artist_plays: Counter = Counter()
        artist_info: dict[str, dict] = {}
        hours = [0] * 24
        by_day: Counter = Counter()
        for r in rows:
            t = json.loads(r["data"])
            tracks[r["video_id"]] = t
            track_plays[r["video_id"]] += 1
            track_secs[r["video_id"]] += r["seconds"]
            for a in (t.get("artists") or [])[:1]:
                key = a.get("id") or a.get("name")
                artist_plays[key] += 1
                artist_info[key] = a
            local = r["played_at"] - tz_offset_min * 60
            hours[int(local // 3600) % 24] += 1
            by_day[time.strftime("%Y-%m-%d", time.gmtime(local))] += 1
        top_tracks = [{**tracks[v], "plays": n, "minutes": round(track_secs[v] / 60)} for v, n in track_plays.most_common(20)]
        top_artists = []
        for key, n in artist_plays.most_common(10):
            a = artist_info[key]
            thumb = next((tracks[v]["thumbnail"] for v in track_plays if any((x.get("id") or x.get("name")) == key for x in (tracks[v].get("artists") or [])[:1])), None)
            top_artists.append({"name": a.get("name"), "id": a.get("id"), "plays": n, "thumbnail": thumb})
        return {
            "days": days,
            "plays": len(rows),
            "minutes": round(sum(r["seconds"] for r in rows) / 60),
            "tracks": len(track_plays),
            "artists": len(artist_plays),
            "topTracks": top_tracks,
            "topArtists": top_artists,
            "hours": hours,
            "byDay": dict(sorted(by_day.items())),
        }

    def recent_video_ids(self, profile_id: str, limit: int = 300) -> list[str]:
        with self.lock:
            return [r["video_id"] for r in self._q(
                "SELECT video_id FROM plays WHERE profile_id = ? ORDER BY played_at DESC LIMIT ?", (profile_id, limit))]
