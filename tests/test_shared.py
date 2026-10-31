"""Shared playlists: encryption, invites, merging, permissions, and two OpenWaves syncing end to end.

The end-to-end tests run two separate libraries (two people, each with their own OpenWave) that
only meet through a private relay (tests/fake_relay.py), exactly as they would over the internet.
"""

import asyncio
import itertools
import json
import random

import pytest
from fastapi.testclient import TestClient

from openwave import api_library, app, nostr, shared
from openwave.library import Library, LibraryError


def T(n, title=None):
    vid = f"song{n:07d}"
    return {"type": "song", "videoId": vid, "title": title or f"Song {n}", "artists": [{"name": f"Artist {n}", "id": "UC1"}],
            "album": None, "duration": 180 + n, "thumbnail": "https://i.ytimg.com/x.jpg", "explicit": False}


def person(tmp_path, name):
    lib = Library(tmp_path / f"{name}.db")
    pid = lib.create_profile(name)["profile"]["id"]
    return lib, pid


def titles(lib, pid, plid):
    return [t["title"] for t in next(p for p in lib.snapshot(pid)["playlists"] if p["id"] == plid)["tracks"]]


def playlist(lib, pid, plid):
    return next((p for p in lib.snapshot(pid)["playlists"] if p["id"] == plid), None)


def exchange(*sides):
    """Hand every copy to every other side, as relays would (no network)."""
    for _ in range(2):
        for (la, _pa, pla), (lb, _pb, plb) in itertools.permutations(sides, 2):
            rows = la.share_rows(playlist_id=pla)
            if rows:
                lb.share_merge(plb, rows[0]["doc"])


# --------------------------------------------------------------------------- building blocks


def test_seal_round_trip_and_tamper_detection():
    key = b"k" * 32
    blob = shared.seal(key, b"hello " * 1000)
    assert shared.unseal(key, blob) == b"hello " * 1000
    with pytest.raises(shared.ShareError):
        shared.unseal(b"x" * 32, blob)
    raw = bytearray(__import__("base64").b64decode(blob))
    raw[30] ^= 1
    with pytest.raises(shared.ShareError):
        shared.unseal(key, __import__("base64").b64encode(bytes(raw)).decode())
    assert shared.seal(key, b"same") != shared.seal(key, b"same")    # fresh nonce every time


def test_invite_links_survive_being_pasted_anywhere():
    owner = nostr.public_key(nostr.new_secret())
    link = shared.invite_link("abcdEFGH12345678", b"\x07" * 32, 3, owner, "Road trip “2026” 🚗")
    assert link.startswith("https://saisiddharthbs.github.io/OpenWave/join/#")
    for pasted in (link, f"  Join my playlist! {link}  ", link.split("#")[1], link + "\n"):
        inv = shared.parse_invite(pasted)
        assert inv == {"share": "abcdEFGH12345678", "key": b"\x07" * 32, "epoch": 3, "owner": owner, "name": "Road trip “2026” 🚗"}
    for bad in ("", "hello", "https://example.com/#nope", link[:-10]):
        with pytest.raises(shared.ShareError):
            shared.parse_invite(bad)


def test_merge_is_order_independent_and_idempotent():
    secret = nostr.new_secret()
    me = nostr.public_key(secret)
    others = [nostr.public_key(nostr.new_secret()) for _ in range(3)]
    base = shared.set_meta(shared.new_doc("s" * 16, me), secret, name="Mix")
    rng = random.Random(7)
    copies = []
    for who in [me] + others:
        d = shared.set_person(base, who, f"P{who[:4]}")
        for _ in range(12):
            n = rng.randrange(20)
            r = rng.random()
            if r < 0.5:
                d = shared.edit_add(d, [T(n)], who)
            elif r < 0.8:
                d = shared.edit_remove(d, f"song{n:07d}", who)
            else:
                order = [t["videoId"] for t in shared.view(d)]
                rng.shuffle(order)
                d = shared.edit_order(d, order, who)
        copies.append(d)
    results = set()
    for perm in itertools.permutations(copies):
        acc = perm[0]
        for c in perm[1:]:
            acc = shared.merge(acc, c)
        results.add(json.dumps(acc, sort_keys=True))
    assert len(results) == 1                                      # same result in every order
    final = json.loads(results.pop())
    assert json.dumps(shared.merge(final, final), sort_keys=True) == json.dumps(final, sort_keys=True)
    assert json.dumps(shared.merge(final, copies[2]), sort_keys=True) == json.dumps(final, sort_keys=True)


def test_concurrent_add_and_remove_the_later_edit_wins():
    secret = nostr.new_secret()
    a, b = nostr.public_key(secret), nostr.public_key(nostr.new_secret())
    d = shared.edit_add(shared.new_doc("s" * 16, a), [T(1), T(2)], a)
    removed_by_a = shared.edit_remove(d, "song0000001", a)
    readded_by_b = shared.edit_add(shared.edit_remove(d, "song0000001", b), [T(1)], b)   # b removed then re-added later
    merged = shared.merge(removed_by_a, readded_by_b)
    assert [t["videoId"] for t in shared.view(merged)] == ["song0000002", "song0000001"]


def test_only_the_owner_can_sign_settings():
    owner_secret, intruder_secret = nostr.new_secret(), nostr.new_secret()
    owner = nostr.public_key(owner_secret)
    doc = shared.set_meta(shared.new_doc("s" * 16, owner), owner_secret, name="Real name")
    forged = shared.set_meta(doc, intruder_secret, name="Hacked", deleted=True)
    forged["meta"]["ts"] = 10 ** 15
    merged = shared.merge(doc, forged)
    assert merged["meta"]["name"] == "Real name" and not merged["meta"]["deleted"]
    tampered = json.loads(json.dumps(doc))
    tampered["meta"]["name"] = "Changed without signing"
    assert shared.merge(doc, tampered)["meta"]["name"] == "Real name"


def test_edits_after_seeing_a_future_clock_still_win():
    secret = nostr.new_secret()
    me = nostr.public_key(secret)
    d = shared.edit_add(shared.new_doc("s" * 16, me), [T(1)], me)
    d["tracks"]["song0000001"]["in"][1] += 10 ** 9               # another device's clock runs far ahead
    d = shared.edit_remove(d, "song0000001", me)
    assert shared.view(d) == []


# --------------------------------------------------------------------------- two people, merged by hand


def test_share_join_edit_and_permissions(tmp_path):
    alice, a = person(tmp_path, "Alice")
    bob, b = person(tmp_path, "Bob")
    alice.apply_ops(a, [{"op": "playlist.create", "id": "road", "name": "Road trip", "tracks": [T(1), T(2)]}])
    info = alice.share_create(a, "road")
    assert info["owner"] and [p["name"] for p in info["people"]] == ["Alice"]
    assert alice.share_create(a, "road")["invite"] == info["invite"]          # sharing twice is harmless

    bp = bob.share_join(b, info["invite"])
    assert bob.share_join(b, info["invite"]) == bp                             # joining twice is harmless
    assert playlist(bob, b, bp)["name"] == "Road trip" and titles(bob, b, bp) == []   # until the first sync
    with pytest.raises(shared.ShareError):
        bob.share_join(b, "not a link")
    assert alice.share_join(a, info["invite"]) == "road"                      # your own invite opens your playlist

    exchange((alice, a, "road"), (bob, b, bp))
    assert titles(bob, b, bp) == ["Song 1", "Song 2"]
    assert [p["name"] for p in playlist(bob, b, bp)["shared"]["people"]] == ["Alice", "Bob"]

    # Both edit at once; nobody's change is lost and everyone sees who added what.
    bob.apply_ops(b, [{"op": "playlist.add", "id": bp, "tracks": [T(3)]}, {"op": "playlist.remove", "id": bp, "videoId": "song0000001"}])
    alice.apply_ops(a, [{"op": "playlist.add", "id": "road", "tracks": [T(4)]}])
    exchange((alice, a, "road"), (bob, b, bp))
    assert titles(alice, a, "road") == titles(bob, b, bp) == ["Song 2", "Song 3", "Song 4"]
    by = {t["title"]: t.get("addedBy") for t in playlist(alice, a, "road")["tracks"]}
    assert by == {"Song 2": "Alice", "Song 3": "Bob", "Song 4": "Alice"}

    # Reordering syncs too.
    bob.apply_ops(b, [{"op": "playlist.reorder", "id": bp, "videoIds": ["song0000004", "song0000002", "song0000003"]}])
    exchange((alice, a, "road"), (bob, b, bp))
    assert titles(alice, a, "road") == ["Song 4", "Song 2", "Song 3"]

    # Only the owner renames; the new name reaches everyone.
    bob.apply_ops(b, [{"op": "playlist.update", "id": bp, "name": "Bob's now"},           # ignored: not the owner
                      {"op": "playlist.add", "id": bp, "tracks": [T(9)]}])                 # …without blocking the rest
    assert playlist(bob, b, bp)["name"] == "Road trip" and "Song 9" in titles(bob, b, bp)
    bob.apply_ops(b, [{"op": "playlist.remove", "id": bp, "videoId": "song0000009"}])
    alice.apply_ops(a, [{"op": "playlist.update", "id": "road", "name": "Road trip 2026"}])
    exchange((alice, a, "road"), (bob, b, bp))
    assert playlist(bob, b, bp)["name"] == "Road trip 2026"

    # Renaming your profile renames you in every shared playlist.
    bob.update_profile(b, name="Robert")
    exchange((alice, a, "road"), (bob, b, bp))
    assert "Robert" in [p["name"] for p in playlist(alice, a, "road")["shared"]["people"]]


def test_owner_deletes_for_everyone_members_keep_a_copy(tmp_path):
    alice, a = person(tmp_path, "Alice")
    bob, b = person(tmp_path, "Bob")
    alice.apply_ops(a, [{"op": "playlist.create", "id": "p", "name": "Party", "tracks": [T(1)]}])
    bp = bob.share_join(b, alice.share_create(a, "p")["invite"])
    exchange((alice, a, "p"), (bob, b, bp))
    alice.apply_ops(a, [{"op": "playlist.delete", "id": "p"}])
    assert playlist(alice, a, "p") is None                                   # gone for Alice straight away
    exchange((alice, a, "p"), (bob, b, bp))
    kept = playlist(bob, b, bp)
    assert kept and "shared" not in kept and [t["title"] for t in kept["tracks"]] == ["Song 1"]
    assert "owner deleted it" in bob.snapshot(b)["notices"][0]
    bob.apply_ops(b, [{"op": "notices.clear"}])
    assert bob.snapshot(b)["notices"] == []


# --------------------------------------------------------------------------- end to end over a relay

try:
    import fake_relay
except ImportError:      # the Android-engine CI job runs without the websockets package
    fake_relay = None
needs_relay = pytest.mark.skipif(fake_relay is None, reason="needs the websockets package")


async def _start(lib, url):
    s = shared.Sync(lib, [url])
    await s.start()
    return s


@needs_relay
def test_two_openwaves_sync_through_a_relay(tmp_path):
    async def scenario():
        relay = await fake_relay.FakeRelay().start()
        alice, a = person(tmp_path, "Alice")
        bob, b = person(tmp_path, "Bob")
        carol, c = person(tmp_path, "Carol")
        sa, sb, sc = await _start(alice, relay.url), await _start(bob, relay.url), await _start(carol, relay.url)
        try:
            alice.apply_ops(a, [{"op": "playlist.create", "id": "fam", "name": "Family", "tracks": [T(1), T(2)]}])
            invite = alice.share_create(a, "fam")["invite"]
            bp = bob.share_join(b, invite)
            cp = carol.share_join(c, invite)
            await fake_relay.wait_until(lambda: titles(bob, b, bp) == ["Song 1", "Song 2"] and titles(carol, c, cp) == ["Song 1", "Song 2"])
            await fake_relay.wait_until(lambda: len(playlist(alice, a, "fam")["shared"]["people"]) == 3)

            # Live edits from everyone reach everyone.
            bob.apply_ops(b, [{"op": "playlist.add", "id": bp, "tracks": [T(3)]}])
            carol.apply_ops(c, [{"op": "playlist.remove", "id": cp, "videoId": "song0000001"}])
            want = ["Song 2", "Song 3"]
            await fake_relay.wait_until(lambda: titles(alice, a, "fam") == want and titles(bob, b, bp) == want and titles(carol, c, cp) == want)

            # Offline edits: Bob loses the connection, everyone keeps editing, nothing is lost.
            await sb.stop()
            bob.apply_ops(b, [{"op": "playlist.add", "id": bp, "tracks": [T(10)]}])
            alice.apply_ops(a, [{"op": "playlist.add", "id": "fam", "tracks": [T(11)]}])
            await asyncio.sleep(1.5)
            sb = await _start(bob, relay.url)
            want = ["Song 2", "Song 3", "Song 11", "Song 10"]
            await fake_relay.wait_until(lambda: all(sorted(titles(*x)) == sorted(want) for x in ((alice, a, "fam"), (bob, b, bp), (carol, c, cp))))
            assert titles(alice, a, "fam") == titles(bob, b, bp) == titles(carol, c, cp)

            # The relay goes down for a while; edits wait and go out when it's back.
            await relay.outage()
            carol.apply_ops(c, [{"op": "playlist.add", "id": cp, "tracks": [T(12)]}])
            await asyncio.sleep(1.5)
            assert "Song 12" not in titles(alice, a, "fam")
            assert playlist(carol, c, cp)["shared"]["pending"]
            relay.restore()
            await fake_relay.wait_until(lambda: "Song 12" in titles(alice, a, "fam") and "Song 12" in titles(bob, b, bp), timeout=40)
            await fake_relay.wait_until(lambda: not playlist(carol, c, cp)["shared"]["pending"], timeout=20)

            # Alice removes Carol: a new key goes to Bob only; Carol can no longer read or write.
            info = alice.share_remove_person(a, "fam", next(p["id"] for p in playlist(alice, a, "fam")["shared"]["people"] if p["name"] == "Carol"))
            assert [p["name"] for p in info["people"]] == ["Alice", "Bob"]
            await fake_relay.wait_until(lambda: playlist(carol, c, cp) and "shared" not in playlist(carol, c, cp))
            assert "removed" in carol.snapshot(c)["notices"][0]
            assert titles(carol, c, cp)                                     # Carol keeps her copy
            await fake_relay.wait_until(lambda: bob.share_rows(playlist_id=bp)[0]["epoch"] == 2)
            bob.apply_ops(b, [{"op": "playlist.add", "id": bp, "tracks": [T(20)]}])
            await fake_relay.wait_until(lambda: "Song 20" in titles(alice, a, "fam"))
            assert "Song 20" not in titles(carol, c, cp)

            # Carol's old invite no longer works for anyone new.
            dave, d = person(tmp_path, "Dave")
            sd = await _start(dave, relay.url)
            dp = dave.share_join(d, invite)
            await fake_relay.wait_until(lambda: dave.snapshot(d)["notices"])
            assert "out of date" in dave.snapshot(d)["notices"][0] and playlist(dave, d, dp) is None
            # A fresh invite works.
            dp = dave.share_join(d, alice.share_info(a, "fam")["invite"])
            await fake_relay.wait_until(lambda: titles(dave, d, dp) == titles(alice, a, "fam"))
            await sd.stop()

            # Bob leaves: it disappears for him, and he drops off everyone's list.
            bob.apply_ops(b, [{"op": "playlist.delete", "id": bp}])
            assert playlist(bob, b, bp) is None
            await fake_relay.wait_until(lambda: "Bob" not in [p["name"] for p in playlist(alice, a, "fam")["shared"]["people"]])
            await fake_relay.wait_until(lambda: not bob.share_rows())          # cleaned up once the others know
        finally:
            for s in (sa, sb, sc):
                await s.stop()
            await relay.stop()

    asyncio.run(scenario())


@needs_relay
def test_nothing_touches_the_network_without_shared_playlists(tmp_path):
    async def scenario():
        relay = await fake_relay.FakeRelay().start()
        lib, pid = person(tmp_path, "Solo")
        lib.apply_ops(pid, [{"op": "playlist.create", "id": "mine", "name": "Mine", "tracks": [T(1)]}])
        s = await _start(lib, relay.url)
        await asyncio.sleep(1.5)
        assert relay.clients == {} and relay.events == {}
        await s.stop()
        await relay.stop()

    asyncio.run(scenario())


# --------------------------------------------------------------------------- HTTP API


@pytest.fixture
def client(tmp_path):
    api_library.use_library(Library(tmp_path / "t.db"))
    with TestClient(app.app) as c:
        yield c


def test_share_api(client):
    h = {"Authorization": f"Bearer {client.post('/api/profiles', json={'name': 'Sai'}).json()['token']}"}
    client.post("/api/me/ops", json={"ops": [{"op": "playlist.create", "id": "pl1", "name": "Ours", "tracks": [T(1)]}]}, headers=h)
    assert client.post("/api/me/shares/pl1").status_code == 401
    r = client.post("/api/me/shares/pl1", headers=h)
    assert r.status_code == 200 and r.json()["invite"].startswith(shared.JOIN_URL)
    info = client.get("/api/me/shares/pl1", headers=h).json()
    assert info["owner"] and info["people"][0]["you"] and "sync" in info
    snap = client.get("/api/me/library", headers=h).json()
    assert snap["playlists"][0]["shared"]["owner"] and snap["playlists"][0]["tracks"][0]["addedBy"] == "Sai"
    assert client.post("/api/me/shares/join", json={"invite": "rubbish"}, headers=h).status_code == 400
    assert client.post("/api/me/shares/join", json={"invite": r.json()["invite"]}, headers=h).json() == {"playlistId": "pl1"}
    assert client.get("/api/me/shares/nope", headers=h).status_code == 404
    other = {"Authorization": f"Bearer {client.post('/api/profiles', json={'name': 'Other'}).json()['token']}"}
    assert client.post("/api/me/shares/pl1", headers=other).status_code == 403


def test_big_playlists_split_into_relay_sized_messages():
    secret = nostr.new_secret()
    me = nostr.public_key(secret)
    doc = shared.set_meta(shared.new_doc("s" * 16, me), secret, name="Huge")
    # Incompressible titles and thumbnails: the worst case for size.
    tracks = [{**T(i, title=__import__("os").urandom(40).hex()), "thumbnail": "https://x/" + __import__("os").urandom(60).hex()}
              for i in range(shared.MAX_TRACKS)]
    doc = shared.edit_add(doc, tracks, me)
    key = b"k" * 32
    pieces = shared.sealed_pieces(doc, key)
    assert 1 < len(pieces) <= shared.MAX_CHUNKS and max(len(p) for p in pieces) <= shared.MAX_MESSAGE
    merged = shared.new_doc("s" * 16, me)
    for p in pieces:
        merged = shared.merge(merged, json.loads(shared.unseal(key, p)))
    assert len(shared.view(merged)) == shared.MAX_TRACKS and merged["meta"]["name"] == "Huge"
    with pytest.raises(shared.ShareError):
        shared.edit_add(doc, [T(999999)], me)
