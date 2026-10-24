"""Import parsers for each service's export format (offline, with small sample files)."""

import asyncio
import json
import plistlib

from openwave import importer


def names_and_titles(playlists):
    return [(p["name"], [i.get("title") for i in p["items"]]) for p in playlists]


def test_exportify_csv():
    text = ("Track URI,Track Name,Artist Name(s),Album Name,Duration (ms)\n"
            "spotify:track:1,Yellow,Coldplay,Parachutes,266773\n"
            "spotify:track:2,Get Lucky,\"Daft Punk, Pharrell Williams\",Random Access Memories,369626\n")
    [p] = importer.parse_file(text, "Road Trip.csv")
    assert p["name"] == "Road Trip"
    assert p["items"][1] == {"title": "Get Lucky", "artist": "Daft Punk", "album": "Random Access Memories", "duration": 370}


def test_tunemymusic_csv_keeps_each_playlist():
    text = ("Track name,Artist name,Album,Playlist name,Type,ISRC\n"
            "Kesariya,Arijit Singh,Brahmastra,Chill,Playlist,X1\n"
            "Blinding Lights,The Weeknd,After Hours,Gym,Playlist,X2\n"
            "Tum Hi Ho,Arijit Singh,Aashiqui 2,Chill,Playlist,X3\n")
    assert names_and_titles(importer.parse_file(text, "My Spotify Library.csv")) == [
        ("Chill", ["Kesariya", "Tum Hi Ho"]), ("Gym", ["Blinding Lights"])]


def test_soundiiz_csv():
    [p] = importer.parse_file("title,artist,album,isrc\nLevitating,Dua Lipa,Future Nostalgia,GB1\n", "amazon-likes.csv")
    assert p["items"][0]["artist"] == "Dua Lipa"


def test_google_takeout_csv_uses_video_ids():
    new = "Video ID,Playlist Video Creation Timestamp\ndQw4w9WgXcQ,2024-01-01T00:00:00+00:00\nnot-an-id,x\n"
    old = ("Playlist Id,Channel Id,Time Created,Title\nPL1,UC1,2020-01-01,Favs\n\n"
           "Video Id,Time Added\ndQw4w9WgXcQ,2020-01-01 00:00:00 UTC\n")
    for text in (new, old):
        [p] = importer.parse_file(text, "Favs-videos.csv")
        assert p["name"] == "Favs" and p["items"][0]["videoId"] == "dQw4w9WgXcQ"


def test_spotify_data_download_json():
    data = {"playlists": [
        {"name": "Focus", "items": [{"track": {"trackName": "Weightless", "artistName": "Marconi Union", "albumName": "Weightless"}},
                                    {"episode": None, "track": None}]},
        {"name": "Empty", "items": []}],
        "tracks": [{"artist": "Queen", "album": "A Night at the Opera", "track": "Bohemian Rhapsody"}]}
    assert names_and_titles(importer.parse_file(json.dumps(data), "Playlist1.json")) == [
        ("Focus", ["Weightless"]), ("Liked Songs (Spotify)", ["Bohemian Rhapsody"])]


def test_apple_music_xml_export():
    lib = {"Tracks": {"1": {"Name": "Lose Yourself", "Artist": "Eminem", "Album": "8 Mile", "Total Time": 326000}},
           "Playlists": [{"Name": "Library", "Master": True, "Playlist Items": [{"Track ID": 1}]},
                         {"Name": "Workout", "Playlist Items": [{"Track ID": 1}]}]}
    [p] = importer.parse_file(plistlib.dumps(lib).decode(), "Workout.xml")
    assert p["name"] == "Workout" and p["items"][0] == {"title": "Lose Yourself", "artist": "Eminem", "album": "8 Mile", "duration": 326}


def test_apple_music_text_export():
    text = "Name\tArtist\tComposer\tAlbum\tGrouping\tTime\nBad Guy\tBillie Eilish\t\tWhen We All Fall Asleep\t\t194\n"
    [p] = importer.parse_file(text, "Late Night.txt")
    assert p["name"] == "Late Night" and p["items"][0]["duration"] == 194


def test_plain_list_and_durations():
    [p] = importer.parse_file("1. Coldplay - Yellow\nGet Lucky\n", "list.txt")
    assert [(i["artist"], i["title"]) for i in p["items"]] == [("Coldplay", "Yellow"), ("", "Get Lucky")]
    assert importer._secs("PT3M28S") == 208 and importer._secs(208810) == 209 and importer._secs("3:28") == 208


def test_match_keeps_one_answer_per_item(monkeypatch):
    async def fake(item):
        return {"videoId": item["title"]}
    monkeypatch.setattr(importer, "match_one", fake)
    out = asyncio.run(importer.match([{"title": "a"}, {"title": ""}, "junk", {"title": "b"}]))
    assert out == [{"videoId": "a"}, None, None, {"videoId": "b"}]
