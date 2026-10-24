"""Offline tests for parsing, normalisation and proxy safety. Run: pytest"""

from openwave import app, music


def test_parse_youtube_url():
    assert music.parse_youtube_url("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1") == ("video", "dQw4w9WgXcQ")
    assert music.parse_youtube_url("youtu.be/dQw4w9WgXcQ") == ("video", "dQw4w9WgXcQ")
    assert music.parse_youtube_url("https://music.youtube.com/watch?v=dQw4w9WgXcQ") == ("video", "dQw4w9WgXcQ")
    assert music.parse_youtube_url("https://youtube.com/shorts/dQw4w9WgXcQ") == ("video", "dQw4w9WgXcQ")
    assert music.parse_youtube_url("https://www.youtube.com/playlist?list=PL123") == ("playlist", "PL123")
    assert music.parse_youtube_url("blinding lights") is None
    assert music.parse_youtube_url("https://example.com/watch?v=dQw4w9WgXcQ") is None


def test_parse_duration():
    assert music.parse_duration("3:51") == 231
    assert music.parse_duration("1:02:03") == 3723
    assert music.parse_duration(42) == 42
    assert music.parse_duration("live") is None
    assert music.parse_duration(None) is None


def test_thumb_upscales_google_images():
    thumbs = [{"url": "https://lh3.googleusercontent.com/abc=w60-h60-l90-rj", "width": 60}]
    assert music.thumb(thumbs) == "https://lh3.googleusercontent.com/abc=w544-h544-l90-rj"
    assert music.thumb(None) is None


def test_track_normalisation():
    t = music.track({
        "videoId": "abcdefghijk", "title": "Song", "videoType": "MUSIC_VIDEO_TYPE_ATV",
        "artists": [{"name": "A", "id": "UC1"}], "album": {"name": "Alb", "id": "MPRE1"}, "length": "2:00",
    })
    assert t["type"] == "song" and t["duration"] == 120 and t["album"] == {"name": "Alb", "id": "MPRE1"}
    v = music.track({"videoId": "abcdefghijk", "title": "Clip", "videoType": "MUSIC_VIDEO_TYPE_OMV"})
    assert v["type"] == "video" and v["thumbnail"].endswith("/abcdefghijk/hqdefault.jpg")
    assert music.track({"title": "no id"}) is None


def test_cards():
    assert music.card({"resultType": "album", "browseId": "MPRE1", "title": "X"})["type"] == "album"
    assert music.card({"resultType": "playlist", "browseId": "VLPL1", "title": "P"})["id"] == "PL1"
    top_artist = music.card({"resultType": "artist", "artists": [{"name": "C", "id": "UC9"}]})
    assert top_artist == {"type": "artist", "id": "UC9", "title": "C", "subtitle": "Artist", "thumbnail": None}


def test_image_allowlist():
    assert app._allowed("https://i.ytimg.com/vi/x/hqdefault.jpg", app.IMAGE_HOSTS)
    assert app._allowed("https://lh3.googleusercontent.com/abc=w60-h60", app.IMAGE_HOSTS)
    assert not app._allowed("https://x.i.ytimg.com/vi/x.jpg", app.IMAGE_HOSTS)
    assert not app._allowed("http://i.ytimg.com/vi/x.jpg", app.IMAGE_HOSTS)
    assert not app._allowed("https://169.254.169.254/latest", app.IMAGE_HOSTS)


def test_clean_title_and_matching():
    from openwave import music
    assert music.clean_title("Blinding Lights (Official Video)") == "Blinding Lights"
    assert music.clean_title("Kesariya (Full Song) | Brahmastra") == "Kesariya"
    assert music.clean_title("STAY (Official Music Video) ft. Justin Bieber") == "STAY"
    song = {"title": "Blinding Lights", "artists": [{"name": "The Weeknd"}], "duration": 200}
    other = {"title": "Blinding Lights (Slowed)", "artists": [{"name": "Someone"}], "duration": 260}
    assert music.match_score("Blinding Lights (Official Video)", "The Weeknd", None, song) > music.match_score("Blinding Lights (Official Video)", "The Weeknd", None, other)


def test_clamp_range():
    assert app._clamp_range(None, None) == f"bytes=0-{app.CHUNK - 1}"
    assert app._clamp_range("bytes=0-", 1000) == "bytes=0-999"
    assert app._clamp_range("bytes=100-199", 10**9) == "bytes=100-199"
    assert app._clamp_range("bytes=5-", 10**9) == f"bytes=5-{5 + app.CHUNK - 1}"


def test_stream_falls_back_to_robust_client(monkeypatch):
    """A 403 on the fast client's URL must trigger a robust re-resolve, not an error."""
    import asyncio

    import httpx

    calls = []

    def fmt(url):
        return {"url": url, "headers": {}, "available_at": 0, "audio": True, "video": False, "ext": "m4a", "abr": 128, "height": 0, "size": 10}

    async def fake_resolve(video_id, force=False, robust=False):
        calls.append(robust)
        url = "https://rr1.googlevideo.com/robust" if robust else "https://rr1.googlevideo.com/fast"
        return {"fast": not robust, "formats": {"140": fmt(url)}}

    def handler(request):
        if request.url.path == "/fast":
            return httpx.Response(403)
        return httpx.Response(206, content=b"0123456789", headers={"content-range": "bytes 0-9/10"})

    monkeypatch.setattr(app.youtube, "resolve", fake_resolve)
    monkeypatch.setattr(app, "client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def run():
        resp = await app._open_upstream("dQw4w9WgXcQ", "normal", "bytes=0-")
        body = await resp.aread()
        await resp.aclose()
        return resp.status_code, body

    status, body = asyncio.run(run())
    assert status == 206 and body == b"0123456789"
    assert calls == [False, True]


def test_download_stitches_chunks(monkeypatch):
    """/api/download must return the whole file even when upstream serves it in pieces."""
    import httpx
    from fastapi.testclient import TestClient

    data = bytes(range(256)) * 40  # 10240 bytes
    piece = 4096
    requested = []

    def upstream(request):
        start = int(request.headers["range"].split("=")[1].split("-")[0])
        end = min(start + piece, len(data)) - 1
        return httpx.Response(
            206,
            stream=Chunked(data[start:end + 1]),  # a live stream, like a real network response
            headers={"content-range": f"bytes {start}-{end}/{len(data)}", "content-type": "audio/mp4"},
        )

    class Chunked(httpx.AsyncByteStream):
        def __init__(self, body):
            self.body = body

        async def __aiter__(self):
            for i in range(0, len(self.body), 1000):
                yield self.body[i:i + 1000]

    mock = httpx.AsyncClient(transport=httpx.MockTransport(upstream))

    async def fake_open(video_id, quality, range_header, codec=None):
        requested.append(int(range_header.split("=")[1].split("-")[0]))
        return await mock.send(mock.build_request("GET", "https://rr1.googlevideo.com/x", headers={"range": range_header}), stream=True)

    monkeypatch.setattr(app, "_open_upstream", fake_open)
    with TestClient(app.app) as c:
        r = c.get("/api/download/dQw4w9WgXcQ")
    assert r.status_code == 200
    assert r.content == data
    assert r.headers["content-length"] == str(len(data))
    assert requested == [0, 4096, 8192]


def test_updated_extractors_take_priority(tmp_path, monkeypatch):
    """Downloaded extractor updates must shadow the bundled copies on the next launch."""
    import importlib
    import sys

    from openwave import updater

    pkg = tmp_path / "current" / "fake_extractor_pkg"
    pkg.mkdir(parents=True)
    (pkg / "__init__.py").write_text("VERSION = 'updated'\n")
    finder = updater._UpdatedFirst(tmp_path / "current", {"fake_extractor_pkg"})
    monkeypatch.setattr(sys, "meta_path", [finder, *sys.meta_path])
    sys.modules.pop("fake_extractor_pkg", None)
    assert importlib.import_module("fake_extractor_pkg").VERSION == "updated"
    assert finder.find_spec("json") is None  # everything else resolves normally
    assert updater._newer("2026.11.1", "2026.10.21") and not updater._newer("2026.10.21", "2026.10.21")


def test_bundled_js_runtime_found_on_every_os(tmp_path, monkeypatch):
    """Packaged apps ship Deno next to the engine: 'deno' on macOS/Linux, 'deno.exe' on Windows."""
    from openwave import youtube

    for filename in ("deno", "deno.exe"):
        d = tmp_path / filename.replace(".", "_")
        d.mkdir()
        (d / filename).write_text("")
        monkeypatch.setattr(youtube, "bin_dir", lambda d=d: d)
        monkeypatch.setattr(youtube.shutil, "which", lambda name: None)
        assert youtube._js_runtimes() == {"deno": {"path": str(d / filename)}}


def test_app_update_offers_the_right_download(monkeypatch):
    import asyncio

    from openwave import releases

    assert releases.is_newer("0.3.1", "0.3.0") and releases.is_newer("v1.0", "0.9.9")
    assert not releases.is_newer("0.3.0", "0.3.0") and not releases.is_newer("0.2.9", "0.3.0")
    files = ["OpenWave-Android.apk", "OpenWave-Windows-Setup.exe", "OpenWave-Linux-x86_64.AppImage"]
    release = {"version": "99.0.0", "page": "https://example/rel",
               "assets": {f: f"https://example/dl/{f}" for f in files}}
    monkeypatch.setattr(releases, "_cache", {"at": 1e18, "release": release})

    phone = asyncio.run(releases.check(None, "android"))
    assert phone["available"] and phone["download"].endswith("OpenWave-Android.apk") and phone["latest"] == "99.0.0"

    monkeypatch.setattr(releases, "FROZEN", False)  # Docker / source install: never offered a download
    assert not asyncio.run(releases.check(None))["available"]

    monkeypatch.setattr(releases, "FROZEN", True)
    monkeypatch.setattr(releases.sys, "platform", "win32")
    assert asyncio.run(releases.check(None))["download"].endswith("OpenWave-Windows-Setup.exe")
    monkeypatch.setattr(releases.sys, "platform", "darwin")  # no Mac files in this release
    assert not asyncio.run(releases.check(None))["available"]


def test_stream_answers_the_whole_requested_range(monkeypatch):
    """WebKit ends the song when a "bytes=N-" answer stops short, so /api/stream must cover the
    full range even though upstream is fetched in pieces, and resume if a piece breaks off."""
    import httpx
    from fastapi.testclient import TestClient

    data = bytes(range(256)) * 40  # 10240 bytes, served upstream 4096 at a time
    piece = 4096
    requested = []
    broken = {"once": True}

    class Chunked(httpx.AsyncByteStream):
        def __init__(self, body, fail_after=None):
            self.body, self.fail_after = body, fail_after

        async def __aiter__(self):
            for i in range(0, len(self.body), 1000):
                if self.fail_after is not None and i >= self.fail_after:
                    raise httpx.ReadError("connection dropped")
                yield self.body[i:i + 1000]

    def upstream(request):
        start, _, want = request.headers["range"].split("=")[1].partition("-")
        start = int(start)
        end = min(start + piece, len(data), int(want) + 1 if want else len(data)) - 1
        fail = 2000 if start == 4096 and broken.pop("once", False) else None  # second piece breaks once
        return httpx.Response(206, stream=Chunked(data[start:end + 1], fail),
                              headers={"content-range": f"bytes {start}-{end}/{len(data)}", "content-type": "audio/webm"})

    mock = httpx.AsyncClient(transport=httpx.MockTransport(upstream))

    async def fake_open(video_id, quality, range_header, codec=None):
        requested.append(range_header)
        return await mock.send(mock.build_request("GET", "https://rr1.googlevideo.com/x", headers={"range": range_header or "bytes=0-"}), stream=True)

    monkeypatch.setattr(app, "_open_upstream", fake_open)
    with TestClient(app.app) as c:
        whole = c.get("/api/stream/dQw4w9WgXcQ", headers={"Range": "bytes=0-"})
        assert whole.status_code == 206 and whole.content == data
        assert whole.headers["content-range"] == f"bytes 0-{len(data) - 1}/{len(data)}"
        assert whole.headers["content-length"] == str(len(data))
        assert requested == ["bytes=0-", "bytes=4096-10239", "bytes=6096-10239", "bytes=10192-10239"]  # resumed at 6096

        part = c.get("/api/stream/dQw4w9WgXcQ", headers={"Range": "bytes=5000-9000"})
        assert part.status_code == 206 and part.content == data[5000:9001]
        assert part.headers["content-range"] == f"bytes 5000-9000/{len(data)}"

        plain = c.get("/api/stream/dQw4w9WgXcQ")
        assert plain.status_code == 200 and plain.content == data


def test_song_versions_are_remembered_across_restarts(tmp_path, monkeypatch):
    import asyncio

    from openwave import kv, music

    monkeypatch.setenv("OPENWAVE_DATA", str(tmp_path))
    monkeypatch.setattr(kv, "_db", None)
    calls = []

    async def fake_track_info(video_id):
        calls.append(video_id)
        return {"type": "song", "videoId": video_id, "title": "x", "artists": []}

    monkeypatch.setattr(music, "track_info", fake_track_info)
    first = asyncio.run(music.audio_version.__wrapped__("abcdefghijk"))
    monkeypatch.setattr(kv, "_db", None)  # a "restart": new connection, empty memory cache
    again = asyncio.run(music.audio_version.__wrapped__("abcdefghijk"))
    assert first == again and calls == ["abcdefghijk"]
    kv.put("gone", 1, -1)
    assert kv.get("gone") is kv.MISSING and kv.get("never") is kv.MISSING
