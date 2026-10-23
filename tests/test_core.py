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


def test_proxy_allowlist():
    assert app._allowed("https://rr1---sn-abc.googlevideo.com/videoplayback?x", app.MEDIA_HOSTS)
    assert app._allowed("https://manifest.googlevideo.com/api/manifest/hls", app.MEDIA_HOSTS)
    assert not app._allowed("https://evilgooglevideo.com/x", app.MEDIA_HOSTS)
    assert not app._allowed("http://rr1.googlevideo.com/x", app.MEDIA_HOSTS)
    assert not app._allowed("https://googlevideo.com.evil.net/x", app.MEDIA_HOSTS)
    assert app._allowed("https://i.ytimg.com/vi/x/hqdefault.jpg", app.IMAGE_HOSTS)
    assert not app._allowed("https://x.i.ytimg.com/vi/x.jpg", app.IMAGE_HOSTS)
    assert not app._allowed("https://169.254.169.254/latest", app.IMAGE_HOSTS)


def test_rewrite_m3u8():
    src = (
        '#EXTM3U\n#EXT-X-MEDIA:URI="https://manifest.googlevideo.com/a/index.m3u8",TYPE=AUDIO\n'
        '#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\nseg1.ts\n'
    )
    out = app.rewrite_m3u8(src, "https://rr1.googlevideo.com/dir/list.m3u8")
    assert 'URI="/api/proxy?u=https%3A%2F%2Fmanifest.googlevideo.com%2Fa%2Findex.m3u8"' in out
    assert 'URI="/api/proxy?u=https%3A%2F%2Frr1.googlevideo.com%2Fdir%2Finit.mp4"' in out
    assert "/api/proxy?u=https%3A%2F%2Frr1.googlevideo.com%2Fdir%2Fseg1.ts" in out
    assert out.startswith("#EXTM3U")


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
        return {"fast": not robust, "formats": {"140": fmt(url)}, "hls": None}

    def handler(request):
        if request.url.path == "/fast":
            return httpx.Response(403)
        return httpx.Response(206, content=b"0123456789", headers={"content-range": "bytes 0-9/10"})

    monkeypatch.setattr(app.youtube, "resolve", fake_resolve)
    monkeypatch.setattr(app, "client", httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    async def run():
        resp = await app._open_upstream("dQw4w9WgXcQ", "audio", "normal", "bytes=0-")
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

    async def fake_open(video_id, kind, quality, range_header):
        requested.append(int(range_header.split("=")[1].split("-")[0]))
        return await mock.send(mock.build_request("GET", "https://rr1.googlevideo.com/x", headers={"range": range_header}), stream=True)

    monkeypatch.setattr(app, "_open_upstream", fake_open)
    with TestClient(app.app) as c:
        r = c.get("/api/download/dQw4w9WgXcQ")
    assert r.status_code == 200
    assert r.content == data
    assert r.headers["content-length"] == str(len(data))
    assert requested == [0, 4096, 8192]
