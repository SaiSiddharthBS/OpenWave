"""A small on-disk cache (SQLite) for lookups worth keeping across restarts.

Phones restart the engine often, and some answers barely ever change (which song a music video
is, for example), so remembering them makes the first tap after a restart as fast as the rest.
"""

from __future__ import annotations

import json
import random
import sqlite3
import threading
import time
from typing import Any

from .config import data_dir

_lock = threading.Lock()
_db: sqlite3.Connection | None = None
MISSING = object()


def _conn() -> sqlite3.Connection:
    global _db
    if _db is None:
        path = data_dir() / "cache.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(path, check_same_thread=False)
        _db.execute("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, until REAL NOT NULL)")
    return _db


def get(key: str) -> Any:
    """The stored value, or MISSING if there is none (or it expired). None is a valid value."""
    try:
        with _lock:
            row = _conn().execute("SELECT v, until FROM kv WHERE k = ?", (key,)).fetchone()
    except sqlite3.Error:
        return MISSING
    return json.loads(row[0]) if row and row[1] > time.time() else MISSING


def put(key: str, value: Any, ttl: float) -> None:
    try:
        with _lock:
            db = _conn()
            db.execute("INSERT OR REPLACE INTO kv VALUES (?, ?, ?)", (key, json.dumps(value), time.time() + ttl))
            if random.random() < 0.02:
                db.execute("DELETE FROM kv WHERE until < ?", (time.time(),))
            db.commit()
    except sqlite3.Error:
        pass  # a cache that can't write is just a slower cache
