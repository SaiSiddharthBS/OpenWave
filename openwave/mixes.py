"""Daily Mixes: a few playlists a day, made from what each profile actually listens to.

Listening is read for what it says about taste: a song played to the end counts for more than one
stopped halfway, a song skipped counts against itself, and last week counts for more than last
season. Artists played in the same sitting go in the same mix, so each mix has one mood, and each
is part songs you love and part songs you haven't heard from YouTube's radio for them.

A day's mixes stay the same all day. They're ready at once from your own listening; the new songs
join them in the background, so Home never waits for YouTube and works when YouTube doesn't.
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from collections import Counter, defaultdict

from . import kv, music

log = logging.getLogger(__name__)

MIXES = 3
SONGS = 30                # in a finished mix
FAMILIAR = 14             # of those, how many you know
ENOUGH_PLAYS = 8          # less than this says nothing about taste yet
ENOUGH_SONGS = 4          # the fewest songs that make a mix
MOST_NEW_BY_ONE_ARTIST = 6
WATCHES = 120 * 86400     # how far back listening counts
HALF_LIFE = 30 * 86400    # a play this old counts for half
SITTING = 45 * 60         # a pause longer than this ends a sitting
SKIPPED_BEFORE = 30       # seconds
JUST_HEARD = 6 * 3600     # a song you've just heard waits for tomorrow
HEARD_LATELY = 14 * 86400  # not "new" if you played it this recently
RETRY_AFTER = 30 * 60
ASK_FOR = 20              # seconds to wait for YouTube's radio

_building: set[str] = set()
_tasks: set[asyncio.Task] = set()
_asking: asyncio.Semaphore | None = None   # at most two radios at a time, so a search or a song starting never waits behind them


def _artist(track: dict) -> tuple[str, str] | None:
    """The first credited artist as (key, name)."""
    first = (track.get("artists") or [{}])[0]
    key = first.get("id") or first.get("name")
    return (key, first.get("name") or "") if key else None


def _length(track: dict) -> float:
    d = track.get("duration")
    return float(d) if isinstance(d, (int, float)) and d > 0 else 0


def learn(plays: list[dict], liked: list[dict], now: float) -> dict:
    """What this listening says about taste. `plays`: oldest first, as from Library.listening."""
    songs: dict[str, dict] = {}
    score: Counter = Counter()
    skipped: Counter = Counter()
    finished: Counter = Counter()
    last: dict[str, float] = {}
    for p in plays:
        track, vid, seconds = p["track"], p["track"]["videoId"], p["seconds"]
        songs[vid] = track
        last[vid] = p["at"]
        length = _length(track)
        heard = min(1, seconds / length) if length else min(1, seconds / 180)
        fade = 0.5 ** ((now - p["at"]) / HALF_LIFE)
        if seconds < SKIPPED_BEFORE and heard < 0.5:
            skipped[vid] += 1
            score[vid] -= 0.75 * fade
        else:
            finished[vid] += 1
            score[vid] += (0.5 + heard) * fade
    for track in liked:
        songs.setdefault(track["videoId"], track)
        score[track["videoId"]] += 2
    avoid = {v for v, n in skipped.items() if n >= 2 and n > finished[v]}

    artists: Counter = Counter()
    names: dict[str, str] = {}
    for vid, s in score.items():
        who = _artist(songs[vid])
        if who and s > 0 and vid not in avoid:
            artists[who[0]] += s
            names[who[0]] = who[1]

    together: dict[str, Counter] = defaultdict(Counter)
    sitting: set[str] = set()
    previous = None
    for p in plays:
        if previous is not None and p["at"] - previous > SITTING:
            sitting = set()
        previous = p["at"]
        who = _artist(p["track"])
        if not who or who[0] not in artists:
            continue
        for other in sitting - {who[0]}:
            together[who[0]][other] += 1
            together[other][who[0]] += 1
        sitting.add(who[0])
    return {"songs": songs, "score": score, "avoid": avoid, "last": last, "artists": artists, "names": names,
            "together": together, "plays": len(plays), "now": now}


def groups(taste: dict) -> list[list[str]]:
    """Up to MIXES groups of artists: your favourite, with those you play alongside them."""
    free = [a for a, _ in taste["artists"].most_common()]
    made = []
    while free and len(made) < MIXES:
        anchor = free.pop(0)
        group = [anchor]
        for other, n in taste["together"][anchor].most_common():
            if len(group) == 4:
                break
            if n >= 2 and other in free:
                free.remove(other)
                group.append(other)
        made.append(group)
    return made


def _familiar(taste: dict, group: list[str]) -> list[dict]:
    """This group's songs, best loved first, leaving out what was skipped or has only just played."""
    now = taste["now"]
    choice = [(s, v) for v, s in taste["score"].items()
              if s > 0 and v not in taste["avoid"] and (_artist(taste["songs"][v]) or ("",))[0] in group]
    rested = [(s, v) for s, v in choice if now - taste["last"].get(v, 0) > JUST_HEARD]
    best = rested if len(rested) >= ENOUGH_SONGS else choice
    return [taste["songs"][v] for _, v in sorted(best, key=lambda x: (-x[0], x[1]))]


def _capped(tracks: list[dict], used: set[str], most: int) -> list[dict]:
    """Each song once, here and across the day's mixes, and at most `most` by one artist."""
    per_artist: Counter = Counter()
    kept = []
    for t in tracks:
        who = (_artist(t) or ("", ""))[0]
        if t["videoId"] in used or per_artist[who] >= most:
            continue
        per_artist[who] += 1
        used.add(t["videoId"])
        kept.append(t)
    return kept


def _blend(known: list[dict], new: list[dict]) -> list[dict]:
    """Known and new songs spread evenly through the mix."""
    if not new:
        return known
    if not known:
        return new
    blended = []
    k = n = 0
    while k < len(known) or n < len(new):
        if n >= len(new) or (k < len(known) and k * len(new) <= n * len(known)):
            blended.append(known[k])
            k += 1
        else:
            blended.append(new[n])
            n += 1
    return blended


def _mix(index: int, taste: dict, group: list[str], tracks: list[dict]) -> dict:
    names = [taste["names"][a] for a in group if taste["names"].get(a)]
    return {"id": str(index + 1), "title": f"Daily Mix {index + 1}",
            "subtitle": f"{', '.join(names[:3])} and more" if names else "Songs for today",
            "thumbnail": tracks[0].get("thumbnail") or "", "tracks": tracks}


def build(taste: dict, seed: str, radios: dict[int, list[dict]] | None = None) -> list[dict]:
    """The day's mixes. `seed` keeps the order the same all day; `radios`: new songs for each group."""
    if taste["plays"] < ENOUGH_PLAYS:
        return []
    now = taste["now"]
    heard = {v for v, at in taste["last"].items() if now - at < HEARD_LATELY}
    used: set[str] = set()
    made = []
    for i, group in enumerate(groups(taste)):
        rng = random.Random(f"{seed}:{i}")
        best = _familiar(taste, group)
        known = best[:FAMILIAR]
        rng.shuffle(known)
        known = _capped(known, used, FAMILIAR)
        if len(known) < ENOUGH_SONGS:
            used.difference_update(t["videoId"] for t in known)
            continue
        new = [t for t in (radios or {}).get(i, []) if t.get("videoId") and t["videoId"] not in taste["avoid"]
               and t["videoId"] not in heard and t["videoId"] not in taste["songs"]]
        rng.shuffle(new)
        new = _capped(new, used, MOST_NEW_BY_ONE_ARTIST)[:SONGS - len(known)]
        made.append(_mix(len(made), taste, group, _blend(known, new)))
    return made


async def _radio(video_id: str) -> list[dict]:
    global _asking
    _asking = _asking or asyncio.Semaphore(2)
    try:
        async with _asking:
            return (await asyncio.wait_for(music.up_next(video_id), ASK_FOR))["tracks"]
    except Exception as e:  # YouTube, the network or a timeout: the mix just stays as it is
        log.info("no radio for %s: %s", video_id, e)
        return []


async def _add_new_songs(key: str, taste: dict, seed: str) -> None:
    try:
        made = groups(taste)
        seeds = {i: _familiar(taste, group)[:2] for i, group in enumerate(made)}
        answers = await asyncio.gather(*(_radio(t["videoId"]) for tracks in seeds.values() for t in tracks))
        radios: dict[int, list[dict]] = {}
        n = 0
        for i, tracks in seeds.items():
            for _ in tracks:
                radios.setdefault(i, []).extend(answers[n])
                n += 1
        found = any(radios.values())
        mixes = build(taste, seed, radios if found else None)
        kv.put(key, {"mixes": mixes, "complete": found, "tried": time.time()}, 2 * 86400)
    finally:
        _building.discard(key)


async def daily(lib, profile_id: str, now: float | None = None) -> dict:
    """Today's mixes for this profile."""
    now = now or time.time()
    day = time.strftime("%Y-%m-%d", time.localtime(now))
    key = f"daily:{profile_id}:{day}"
    seed = f"{profile_id}:{day}"
    stored = kv.get(key)
    if stored is not kv.MISSING and stored["complete"]:
        return {"day": day, "mixes": stored["mixes"]}
    taste = learn(lib.listening(profile_id, now - WATCHES), lib.snapshot(profile_id)["liked"], now)
    if stored is kv.MISSING:
        mixes = build(taste, seed)
        stored = {"mixes": mixes, "complete": False, "tried": 0}
        if mixes:
            kv.put(key, stored, 2 * 86400)
    if stored["mixes"] and key not in _building and now - stored["tried"] > RETRY_AFTER:
        _building.add(key)
        task = asyncio.create_task(_add_new_songs(key, taste, seed))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    return {"day": day, "mixes": stored["mixes"]}
