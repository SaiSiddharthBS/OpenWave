<div align="center">

<img src="docs/logo.png" width="132" alt="OpenWave logo">

<h1>OpenWave</h1>

<h3>One music app. Every device you own.</h3>

<p>A complete music player for YouTube Music's public catalogue, with native apps for macOS, Windows,<br>Linux and Android, an iPhone app that pairs by QR code, and a library that lives on hardware you control.</p>

<p>
<a href="https://github.com/SaiSiddharthBS/OpenWave/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/SaiSiddharthBS/OpenWave?label=release&color=7b7bff"></a>
<a href="https://github.com/SaiSiddharthBS/OpenWave/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/SaiSiddharthBS/OpenWave/actions/workflows/ci.yml/badge.svg"></a>
<a href="https://github.com/SaiSiddharthBS/OpenWave/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/SaiSiddharthBS/OpenWave/total?color=2fc8ff"></a>
<a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/badge/license-GPL--3.0-7b7bff"></a>
<img alt="Platforms" src="https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux%20%7C%20Android%20%7C%20iPhone%20%7C%20Docker-c45cff">
</p>

<p>
<a href="https://saisiddharthbs.github.io/OpenWave/"><b>Website</b></a> ·
<a href="#download"><b>Download</b></a> ·
<a href="#what-it-does">Features</a> ·
<a href="#how-its-built">Architecture</a> ·
<a href="#engineering">Engineering</a> ·
<a href="#self-hosting">Self-hosting</a> ·
<a href="#faq">FAQ</a>
</p>

<img src="docs/screenshots/hero.png" alt="OpenWave on a Mac and an iPhone, playing the same song" width="100%">

</div>

<br>

## Why OpenWave

Music lives on several devices, but most players treat each device as its own island, or tie every one of them to an account in someone else's cloud. OpenWave takes a different route: **one engine you run yourself, and every device a window onto it.**

- **One library, everywhere.** Your profile, likes, playlists and listening history live in a SQLite database on your own Mac, PC or home server, and every device you pair sees the same library within seconds, at home or away.
- **No accounts, no telemetry.** There is nothing to sign up for. A phone pairs with your computer by scanning a QR code, and talks to it over a direct, end-to-end encrypted connection. The apps never report usage.
- **A product, not a script.** Gapless playback, crossfade, synced lyrics, offline downloads, Daily Mixes learned from your own listening, shared playlists, playback across devices, listening together in sync, and apps that update themselves.
- **Built to last.** Each release is built, tested and published by CI across six targets from one tag, with checksums, an Android emulator run and a 572-screen layout audit.

<table>
  <tr><td><b>Platforms</b></td><td>macOS 13+ (Apple Silicon and Intel), Windows 10/11, Linux x86-64, Android 7+, iPhone (Home Screen app), Docker (amd64, arm64)</td></tr>
  <tr><td><b>Engine</b></td><td>Python and FastAPI, one codebase on every platform, including on the phone itself on Android</td></tr>
  <tr><td><b>Apps</b></td><td>One shared interface in plain HTML, CSS and ES modules, in native shells written in Swift and Kotlin</td></tr>
  <tr><td><b>Quality</b></td><td>101 engine tests, 572 layout checks at 13 screen sizes, 71 behaviour checks, a motion audit, an end-to-end pairing test and an Android emulator test, on every push</td></tr>
  <tr><td><b>Account</b></td><td>None. Profiles are local, with an optional PIN</td></tr>
  <tr><td><b>License</b></td><td>GPL-3.0. Open source and non-commercial</td></tr>
</table>

## Download

**macOS, in one command.** Picks the Apple Silicon or Intel build, verifies its checksum and installs it to Applications.

```bash
curl -fsSL https://saisiddharthbs.github.io/OpenWave/install.sh | bash
```

| Platform | Download | First launch |
|---|---|---|
| **macOS**, Apple Silicon | [OpenWave-macOS-AppleSilicon.dmg](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-macOS-AppleSilicon.dmg) | Drag to Applications. If macOS can't verify it: **System Settings → Privacy & Security → Open Anyway**, once. |
| **macOS**, Intel | [OpenWave-macOS-Intel.dmg](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-macOS-Intel.dmg) | As above. |
| **Windows** 10/11 | [OpenWave-Windows-Setup.exe](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-Windows-Setup.exe) | On "Windows protected your PC", choose **More info → Run anyway**. No administrator rights needed. |
| **Linux** x86-64 | [OpenWave-Linux-x86_64.AppImage](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-Linux-x86_64.AppImage) | `chmod +x` the file, then open it. |
| **Android** 7+ | [OpenWave-Android.apk](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-Android.apk) | Open the file and allow your browser to install apps. For store-style updates, add this repository to [Obtainium](https://github.com/ImranR98/Obtainium). |
| **iPhone** | Pairs with OpenWave on your Mac, PC or server | Scan a QR code: see [iPhone](#iphone). |
| **Home server** | [Docker image](#self-hosting) for amd64 and arm64 | Open `http://<server>:8787` on any device. |

Every app is self-contained, with nothing else to install. Each [release](https://github.com/SaiSiddharthBS/OpenWave/releases) carries `SHA256SUMS.txt`.

## What it does

### Listening

<img src="docs/screenshots/now-playing.png" alt="The full-screen player, with synced lyrics" width="100%">

- **Search almost any song** on YouTube Music: songs, albums, artists and playlists, with suggestions as you type. Paste a YouTube or YouTube Music link to open it directly.
- **Songs, never videos.** OpenWave always plays the studio audio track. Music videos are swapped for their song version automatically.
- **Gapless playback** with optional **crossfade** of up to 12 seconds. The next song is buffered while the current one plays, so skipping is instant.
- **Endless autoplay.** When the queue ends, similar music keeps playing, leaving out what you heard recently.
- **Synced lyrics** that follow the song. Select a line to jump to it.
- **Offline downloads** of songs, albums and playlists, and a **sleep timer** that fades out.
- **Adaptive audio.** The best format the device plays well (Opus or AAC, up to about 160 kbps), with a data-saver option.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/artist.png" alt="An artist page"><p align="center"><sub>Artist pages, with radio and follow</sub></p></td>
    <td width="50%"><img src="docs/screenshots/album.png" alt="An album"><p align="center"><sub>Albums</sub></p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/search.png" alt="Search results"><p align="center"><sub>Search, with the box in the middle of the page</sub></p></td>
    <td width="50%"><img src="docs/screenshots/playlist.png" alt="A playlist"><p align="center"><sub>Your playlists, with drag to reorder, downloads and sharing</sub></p></td>
  </tr>
</table>

### Made for you

<img src="docs/screenshots/home.png" alt="Home, with Daily Mixes and On Repeat" width="100%">

- **Daily Mixes.** Three new mixes every day, one mood each. A song you finish counts for more than one you stop halfway, songs you keep skipping are left out, recent listening counts most, and artists you play in the same sitting share a mix. Each mix is part songs you love and part songs you haven't heard. It's all worked out on your own engine, from your own history.
- **On Repeat** and **Rediscover**: the songs you can't stop playing this month, and favourites you haven't played in a while.
- **Insights.** Minutes listened, top artists, top songs and when you listen, for the last week, month, year or all time, with a shareable image card.
- **Profiles** for everyone in the household, each with its own likes, playlists, history, mixes and settings, and an optional PIN. On a paired phone, a profile can be kept **only on that phone**.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/daily-mix.png" alt="A Daily Mix"><p align="center"><sub>A Daily Mix: new every day, from what you actually play</sub></p></td>
    <td width="50%"><img src="docs/screenshots/insights.png" alt="Listening insights"><p align="center"><sub>Insights</sub></p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/on-repeat.png" alt="On Repeat"><p align="center"><sub>On Repeat, built only from your own listening</sub></p></td>
    <td width="50%"><img src="docs/screenshots/library.png" alt="Your Library"><p align="center"><sub>Your Library</sub></p></td>
  </tr>
</table>

### Every device

<img src="docs/screenshots/every-device.png" alt="OpenWave on a Mac, an iPad and an iPhone" width="100%">

- **The same app on every screen.** Phones get a tab bar and a full-screen player you swipe down to close; tablets get a layout of their own, upright or on their side; computers get a sidebar and keyboard shortcuts. The interface, the motion and the library are the same everywhere.
- **Sync** across every device that uses the same engine. Changes apply instantly where you make them, queue up while offline, and reach your other devices within seconds.
- **Play on another device, or listen together.** Move the music to another OpenWave on the Wi-Fi and continue from the same second, or start a session that everyone joins from their own phone, kept in step to within a few hundredths of a second. A device has to be approved once, on its own screen, before it can be controlled.
- **Shared playlists** with friends and family on their own devices, anywhere: everyone adds, removes and reorders songs, each song shows who added it, and the playlist is end-to-end encrypted with a key that exists only in the invite link.
- **Updates that find you.** Every app checks for new versions while it's open; Android posts a notification even when the app is closed, the Mac app installs an update in one click, and the iPhone app updates itself.

<p align="center">
  <img src="docs/screenshots/mobile-home.png" width="200" alt="Home on a phone">
  &nbsp;
  <img src="docs/screenshots/mobile-now-playing.png" width="200" alt="The player on a phone">
  &nbsp;
  <img src="docs/screenshots/mobile-lyrics.png" width="200" alt="Lyrics on a phone">
  &nbsp;
  <img src="docs/screenshots/mobile-daily-mix.png" width="200" alt="A Daily Mix on a phone">
</p>

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/devices.png" alt="Devices menu"><p align="center"><sub>Every OpenWave on your Wi-Fi, one tap away</sub></p></td>
    <td width="50%"><img src="docs/screenshots/shared-with.png" alt="A shared playlist's members"><p align="center"><sub>A shared playlist: who's in it, and the invite link</sub></p></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/mobile-together.png" width="200" alt="A phone listening together with a Mac">
  &nbsp;
  <img src="docs/screenshots/mobile-remote.png" width="200" alt="A phone as the remote for another computer">
  &nbsp;
  <img src="docs/screenshots/mobile-shared.png" width="200" alt="A shared playlist on a friend's phone">
  &nbsp;
  <img src="docs/screenshots/mobile-join.png" width="200" alt="Joining a shared playlist">
</p>
<p align="center"><sub>Listening together with a Mac, a phone as the remote, and a shared playlist on a friend's phone.</sub></p>

### Bring your playlists

**Library → Import** (or <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> on a Mac). There is no song limit.

| Service | Paste a link | Import a file (every song, every playlist) |
|---|---|---|
| **Spotify** | First 100 songs (the most Spotify shares publicly) | [Exportify](https://exportify.app) CSV, or Spotify's own *Download your data* |
| **YouTube / YouTube Music** | Every song | Google Takeout CSV |
| **Apple Music** | Playlists and albums | Music app → File → Library → *Export Playlist* (text or XML) |
| **Deezer** | Every song | — |
| **JioSaavn** | Yes | — |
| **Amazon Music, Tidal, SoundCloud and others** | — | [TuneMyMusic](https://www.tunemymusic.com) *Export to file*, or a Soundiiz CSV |
| **Anything else** | — | A pasted list with one `Artist - Title` per line |

OpenWave matches each song on YouTube Music by title, artist and length, and builds the playlist for you. In testing, Spotify's "Today's Top Hits" imported 50 of 50 songs.

<p align="center"><img src="docs/screenshots/import.png" width="80%" alt="Importing a Spotify playlist"></p>

<details>
<summary><b>More screenshots</b></summary>
<br>
<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/settings.png" alt="Settings, with OpenWave's own menus"><p align="center"><sub>Settings</sub></p></td>
    <td width="50%"><img src="docs/screenshots/profile-menu.png" alt="The profile menu at the foot of the sidebar"><p align="center"><sub>You, at the foot of the sidebar</sub></p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/tablet-home.png" alt="Home on an iPad"><p align="center"><sub>An iPad, upright</sub></p></td>
    <td width="50%"><img src="docs/screenshots/tablet-album.png" alt="An album on an iPad"><p align="center"><sub>Albums on an iPad</sub></p></td>
  </tr>
</table>
<p align="center">
  <img src="docs/screenshots/mobile-library.png" width="200" alt="Library on a phone">
  &nbsp;
  <img src="docs/screenshots/mobile-search.png" width="200" alt="Search on a phone">
  &nbsp;
  <img src="docs/screenshots/mobile-playlist.png" width="200" alt="A playlist on a phone">
  &nbsp;
  <img src="docs/screenshots/mobile-insights.png" width="200" alt="Insights on a phone">
</p>
<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/profiles.png" alt="Choosing a profile"><p align="center"><sub>A profile for everyone in the household</sub></p></td>
    <td width="50%"><img src="docs/screenshots/share-card.png" alt="The shareable insights card"><p align="center"><sub>The shareable insights card</sub></p></td>
  </tr>
</table>
</details>

## Platforms

### macOS

<img src="docs/screenshots/mac-app.png" alt="OpenWave for macOS" width="100%">

A native Swift app (AppKit and SwiftUI) that runs its own engine, with nothing to install or configure.

- **System integration:** media keys, Control Center and lock-screen controls with artwork, AirPods controls, song notifications and a Dock menu.
- **Menu-bar mini player**, so the music is a click away without opening the window. Closing the window keeps the music playing.
- **Keyboard shortcuts:** <kbd>⌘</kbd><kbd>→</kbd> / <kbd>⌘</kbd><kbd>←</kbd> next and previous, <kbd>⌘</kbd><kbd>L</kbd> like, <kbd>⌘</kbd><kbd>F</kbd> search, <kbd>⌘</kbd><kbd>1</kbd>–<kbd>5</kbd> sections, <kbd>⌘</kbd><kbd>⇧</kbd><kbd>I</kbd> import.
- **Self-installing updates**, verified by SHA-256 before the app replaces itself.
- **Deep links** such as `openwave://play/<videoId>`, and launch at login.

<p align="center"><img src="docs/screenshots/mac-miniplayer.png" width="300" alt="Menu-bar mini player"><br><sub>The menu-bar mini player</sub></p>

> **About the macOS security prompt.** OpenWave is not notarised with a paid Apple Developer ID, so macOS may ask for confirmation at first launch. The install script verifies the published checksum; signed and notarised builds are on the [roadmap](#roadmap).

### Android

A native Kotlin app that runs the complete engine on the phone through [Chaquopy](https://chaquo.com/chaquopy/). No computer is needed.

- Media notification, lock-screen, headphone and Bluetooth controls; pauses for calls and when headphones are unplugged; keeps playing in the background.
- **Home-screen widget** with artwork and playback controls, and the screen's fastest refresh rate.
- Native-feeling navigation: swipe the player down to close, swipe the artwork to change songs, long-press for a song's menu, haptics and a back button that behaves as expected.
- **Library location:** keep the library on the phone, or play from OpenWave on your computer with the same profiles and playlists, from anywhere (on the computer, **Settings → Phones → Add a phone**).

<p align="center"><img src="docs/screenshots/android-widget.png" width="220" alt="Android home-screen widget"></p>

### iPhone

Apple does not allow apps like OpenWave on the App Store, so the iPhone plays from OpenWave on a computer you already have: a Mac, a Windows or Linux PC, or a home server. It gets the same profiles, playlists and likes, and runs from the Home Screen like an app.

1. On the computer, open **Settings → Phones → Add a phone**. A QR code appears.
2. Point the iPhone's camera at it and open the link.
3. Tap **Share → Add to Home Screen**, then open OpenWave from the Home Screen.

<p align="center">
  <img src="docs/screenshots/connect-pair.png" width="560" alt="Settings → Phones → Add a phone, with a QR code">
  &nbsp;
  <img src="docs/screenshots/mobile-connect-add.png" width="200" alt="The iPhone suggesting Add to Home Screen">
</p>

It works at home, at work and on mobile data, with no port forwarding, VPN or sign-in: OpenWave Connect finds a direct, encrypted path from the phone to the computer ([how it works](#privacy-and-security)). Songs keep playing with the screen locked, the Lock Screen shows controls and artwork, and downloaded songs play even when the computer is off. Paired phones are listed in Settings → Phones, where each can be removed. For a Windows PC that's always on, **Start with Windows** opens OpenWave in the background whenever you sign in.

<p align="center"><img src="docs/screenshots/connect-phones.png" width="720" alt="Settings → Phones with two paired phones"></p>

A few networks (some workplaces and mobile carriers) block direct connections between devices. Two options work everywhere:

- **With Tailscale.** Install [Tailscale](https://tailscale.com/download) on the computer and the iPhone, signed in to the same account, then **Settings → Phones → With Tailscale → Turn on** and scan the code. On a Docker server, run `tailscale serve --bg --https=8443 http://127.0.0.1:8787` on the server.
- **At home only.** In the Mac app, Settings → Phone → **At home**, then scan the code on the same Wi-Fi.

### Windows and Linux

One-click apps that bundle the same engine with a small launcher, which opens OpenWave in its own window (Microsoft Edge on Windows, Chrome or Chromium on Linux), with in-app updates and self-updating YouTube support.

## How it's built

```mermaid
flowchart LR
  subgraph Clients
    UI["Shared web interface<br/>gapless player · offline store · sync outbox"]
    Mac["macOS app<br/>Swift + WKWebView"]
    And["Android app<br/>Kotlin + WebView + Chaquopy"]
    Desk["Windows / Linux<br/>app window"]
    Web["iPhone and browsers"]
  end
  subgraph Engine["OpenWave engine (FastAPI)"]
    Music["music.py<br/>catalogue, radio, lyrics"]
    Stream["youtube.py + app.py<br/>stream resolution, range proxy"]
    Lib["library.py<br/>SQLite: profiles, playlists, plays"]
    Mixes["mixes.py<br/>Daily Mixes from your listening"]
    Imp["importer.py<br/>playlist import and matching"]
    Link["link.py<br/>devices, remote, listen together"]
  end
  YTM[("YouTube Music")]
  YT[("YouTube streams")]
  Peers["Other OpenWave engines<br/>on the same Wi-Fi"]
  Mac --- UI
  And --- UI
  Desk --- UI
  Web --- UI
  UI -->|catalogue API| Music
  UI -->|audio| Stream
  UI -->|library sync| Lib
  Lib --> Mixes
  Music --> YTM
  Stream --> YT
  Link <-->|UDP discovery, paired HTTP| Peers
  Phone["iPhone away from home<br/>web app from GitHub Pages"]
  Conn["connect.py<br/>OpenWave Connect"]
  Phone <-->|WebRTC data channel, direct| Conn
  Conn -->|same API, in-process| Engine
```

- **One engine, many shells.** The engine is a FastAPI application. Each platform wraps the same web interface in a native shell (Swift on macOS, Kotlin on Android, an app window on Windows and Linux) that adds system integration such as media keys, notifications and widgets.
- **Streaming.** YouTube ties stream URLs to the address that requested them, so the engine proxies audio with HTTP range requests; client devices never contact Google directly. Long songs are fetched in pieces and resumed from the exact byte if the connection drops.
- **Library and sync.** Each profile's library is a log of operations applied to SQLite. Clients apply changes optimistically, keep an outbox while offline and sync it on reconnect; other devices notice a new version and pull within seconds.
- **Daily Mixes.** `mixes.py` reads a profile's plays as taste: completion, skips and recency weight each song, and artists played in the same sitting are grouped. A day's mixes are ready at once from your own songs; new songs from YouTube's radio join them in the background, so Home never waits on the network.
- **Devices.** Engines discover each other with a UDP broadcast and talk over a separate listener that serves only the device routes. Pairing issues a bearer token whose hash is stored on the approving device. Listeners stay in step by playing marginally faster or slower rather than skipping.
- **OpenWave Connect.** A phone away from home runs the same interface from GitHub Pages in a "connect" mode. Its requests travel over a WebRTC data channel to `connect.py`, which hands each one to the engine's own API in-process. The two sides meet by posting encrypted offers and answers to Nostr relays. WebRTC comes from a vendored, data-channel-only copy of [aiortc](https://github.com/aiortc/aiortc).

## Engineering

OpenWave is developed with the discipline of a product team, and the machinery does the checking.

- **Six targets from one tag.** `scripts/release.sh` turns the changelog into a version and tags it; CI then builds the Mac app for Apple Silicon and Intel, the Windows installer, the Linux AppImage, the signed Android app and the multi-architecture Docker image, runs the Android app on an emulator, and publishes them as one release with SHA-256 checksums and notes. A failed build is retried once, and the newest version is always the one marked latest.
- **Tests on every push.**

  | Suite | What it checks |
  |---|---|
  | Engine tests (`pytest`, 101) | Profiles, sync, sharing, import, Daily Mixes, phone pairing, updates, on two FastAPI and pydantic versions |
  | Layout audit (`tests/ui/layout_audit.mjs`) | Every screen at 13 sizes, from a 320-pixel phone to a wide desktop, with real and deliberately extreme names: 572 checks that nothing is cut off or pushed past the edge |
  | Behaviour (`tests/ui/behaviour.mjs`, 71 checks) | Things a person does: search suggestions that stay, the player landing in the mini player, centred titles, menus, dropdowns, update cards and notifications |
  | Motion audit (`tests/ui/motion_audit.mjs`) | Scrolls and flings with the processor slowed down, and fails if an animation needs anything but the graphics chip |
  | Connect end to end (`tests/ui/connect_e2e.mjs`) | A phone pairs with an engine by QR link, uses the app through the connection, reconnects, and is removed |
  | Android emulator (`android/ci/emulator-test.sh`) | The installed app starts its engine, plays, and drives the media notification |

- **Measured performance.** Motion is tuned against frame timings measured on real hardware: in Safari's engine the full-screen player is drawn and set up while still invisible, then animated entirely on the graphics chip, with every part of the animation ending together.
- **Self-healing playback.** YouTube support (yt-dlp and ytmusicapi) updates itself between releases, so playback keeps working when YouTube changes.
- **Reproducible visuals.** Every image in this README comes from `scripts/screenshots.mjs` (a demo profile with real songs and a month of listening) and `scripts/compose_shots.mjs`.

## Self-hosting

Run the engine once on a PC, Mac, home server or VPS, then open OpenWave from any device in the house.

**Docker** (amd64 and arm64)

```bash
docker run -d --name openwave -p 8787:8787 \
  -v openwave:/data --restart unless-stopped \
  ghcr.io/saisiddharthbs/openwave
```

Or, from a clone of this repository: `docker compose up -d --build`.

**From source** (Python 3.10+, plus [Deno](https://deno.com) or Node.js 20+ for YouTube's player scripts)

```bash
git clone https://github.com/SaiSiddharthBS/OpenWave.git && cd OpenWave
./scripts/start.sh                 # Windows: scripts\start.bat
```

**With pip**

```bash
pip install git+https://github.com/SaiSiddharthBS/OpenWave.git
openwave --host 0.0.0.0 --port 8787 --no-browser
```

<details>
<summary><b>Configuration</b></summary>

| Variable | Effect |
|---|---|
| `OPENWAVE_DATA` | Where profiles and libraries are stored. Defaults to the platform's app-data folder; `/data` in Docker. |
| `OPENWAVE_LOCATION` | Region for recommendations, for example `US`, `IN` or `GB`. |
| `OPENWAVE_LANGUAGE` | Metadata language, for example `en`, `hi` or `es`. |
| `OPENWAVE_LINK` | `1` makes the device visible to other OpenWave devices on the network from the start. The Mac and Android apps set this; it can also be changed in Settings → Devices. |
| `OPENWAVE_DEVICE_NAME` | The name other devices see. Defaults to the computer's name. |
| `OPENWAVE_RELAYS` | Comma-separated `wss://` Nostr relays that shared playlists sync through and paired phones use to find this engine, or `off` to use neither. Defaults to six public relays. |
| `OPENWAVE_CONNECT` | `0` turns off OpenWave Connect (phones paired in Settings → Phones). |

</details>

<details>
<summary><b>HTTP API</b> (interactive documentation at <code>/api/docs</code>)</summary>

| Endpoint | Returns |
|---|---|
| `GET /api/search?q=&type=all\|songs\|albums\|artists\|playlists` | Normalised search results |
| `GET /api/home` · `/api/album/{id}` · `/api/playlist/{id}` · `/api/artist/{id}` | Catalogue pages |
| `GET /api/next/{videoId}` · `/api/lyrics/{videoId}` | Radio and lyrics |
| `GET /api/stream/{videoId}?q=&codec=opus\|aac` · `/api/download/{videoId}` | Audio |
| `GET /api/audio/{videoId}` | The song (audio-track) version of any video |
| `GET/POST /api/profiles` · `POST /api/profiles/{id}/login` | Profiles and sign-in |
| `GET /api/me/library` · `POST /api/me/ops` · `GET /api/me/version` | Library sync |
| `GET /api/me/daily` · `/api/me/stats` · `/api/me/mixes` · `/api/me/smart` · `/api/me/radio/{videoId}` | Daily Mixes, insights, mixes, On Repeat and Rediscover, personal radio |
| `POST /api/import/parse` · `/api/import/match` | Playlist import |
| `/api/link/*` | Devices, remote control and listening sessions |
| `GET /api/app-update` | Whether a newer release exists, and the right file for this device |
| `GET /api/connect` · `POST /api/connect/pair` · `POST /api/connect/devices/{id}/remove` | Paired phones (OpenWave Connect); pairing and removal are refused over Connect itself |

</details>

## Privacy and security

- **No telemetry.** The apps never report usage, crashes or identifiers. The public [Stats page](https://saisiddharthbs.github.io/OpenWave/stats.html) is built only from GitHub's public numbers: downloads per file, version and day, and stars.
- **Local data.** Libraries live in SQLite on the device or server you run. Client devices talk only to your engine, never to Google; that includes artwork and lyrics.
- **Shared playlists are end-to-end encrypted.** OpenWave runs no servers, so a shared playlist syncs through a few public [Nostr](https://nostr.com) relays. Each member's copy is encrypted with a key that exists only in the invite link (after the `#`, which browsers never send to a server). Relays see only encrypted data, a random identity per profile and your IP address. Owner-only changes are signed by the owner.
- **Device pairing.** Devices on the network can see each other's names, but can't play anything or join a session until approved on the target device's own screen. Only playback state crosses the network.
- **Phones connect directly and privately.** The QR code holds a pairing code that works for 15 minutes. The phone makes its own key pair and sends only the public half; from then on phone and computer share a key that neither ever sends (ECDH), so a photo of the code is useless later. They find each other through short end-to-end encrypted messages on public Nostr relays, then talk over a direct, encrypted WebRTC connection: music, artwork and library data never pass through anyone else. A paired phone can do what a browser at home can do and no more, and can't pair other phones.
- **Verified releases.** Every installer ships with a SHA-256 checksum, which the Mac installer and the Mac app's updater verify before installing. Android releases are signed with a single, stable key.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m openwave --no-browser      # http://localhost:8787
.venv/bin/pytest                               # 101 tests
node tests/ui/layout_audit.mjs                 # and the other suites in tests/ui (Node 22+ and Chrome)
```

The web interface in `openwave/web/` is plain HTML, CSS and ES modules with no build step: edit and reload.

| Path | Contents |
|---|---|
| `openwave/` | The engine: API, streaming, library, Daily Mixes, import, devices, Connect, updates |
| `openwave/web/` | The interface shared by every platform |
| `macos/` | Native macOS app (Swift) and `build.sh` |
| `android/` | Native Android app (Kotlin, Chaquopy) |
| `packaging/` | Windows installer and Linux AppImage |
| `site/` | Website, Mac installer script and Stats page, deployed to GitHub Pages |
| `scripts/` | Start scripts, release tooling, screenshots and statistics |
| `tests/` | Engine tests, and the browser suites in `tests/ui/` |
| `.github/workflows/` | CI, platform builds, releases, Pages, retries and daily statistics |

See [CONTRIBUTING.md](CONTRIBUTING.md) and [MAINTAINING.md](MAINTAINING.md).

## Roadmap

- [x] Native apps for macOS, Windows, Linux and Android, and an iPhone app
- [x] Profiles, sync, insights and smart playlists
- [x] Daily Mixes learned from each profile's own listening
- [x] Playlist import from Spotify, Apple Music, YouTube Music, Deezer, JioSaavn and export files
- [x] Play on another device and listen together on the same Wi-Fi
- [x] Shared playlists with friends and family, anywhere
- [x] iPhone access from anywhere with a QR code and no accounts (OpenWave Connect)
- [x] Tablet layouts, and update notifications on every platform
- [ ] My devices: one profile kept in step across several computers
- [ ] Listen together over the internet
- [ ] Distribution on F-Droid and IzzyOnDroid
- [ ] Notarised macOS and signed Windows builds
- [ ] Equaliser and loudness normalisation
- [ ] Translations

Release history is in [CHANGELOG.md](CHANGELOG.md). Ideas and requests are welcome in [issues](https://github.com/SaiSiddharthBS/OpenWave/issues).

## FAQ

<details>
<summary><b>Is OpenWave a commercial product?</b></summary>

No. It is open-source software under the GPL-3.0, with nothing to buy and no paid tier, and it will not be monetised.
</details>

<details>
<summary><b>Do I need an account?</b></summary>

No. Profiles are names with an optional PIN, stored on your own device or server. There is no email address and no sign-up.
</details>

<details>
<summary><b>Why isn't it on the App Store or Google Play?</b></summary>

Both stores reject apps that play YouTube content, which is why projects such as NewPipe are distributed directly. OpenWave is downloaded from GitHub or [the website](https://saisiddharthbs.github.io/OpenWave/), and its source is open for anyone to review.
</details>

<details>
<summary><b>Does it play music videos?</b></summary>

No, by design. OpenWave always plays the song itself.
</details>

<details>
<summary><b>Playback stopped working for every song.</b></summary>

YouTube changes occasionally. The desktop apps update their YouTube support automatically in the background; restart the app to apply it. On a server, run `pip install -U "yt-dlp[default]" ytmusicapi` (the start scripts do this automatically) or pull the latest Docker image.
</details>

<details>
<summary><b>Can someone else on my Wi-Fi take over my music?</b></summary>

No. Other devices can see your device's name, but a device must be approved once, on your screen, before it can play anything or join your session. Remove devices at any time in **Settings → Devices**, or turn off **Show this device on Wi-Fi**.
</details>

<details>
<summary><b>How many people use OpenWave?</b></summary>

The [Stats page](https://saisiddharthbs.github.io/OpenWave/stats.html) shows downloads per platform, per version and per day, and stars, from GitHub's public numbers. OpenWave does not count active users, because the apps do not report anything.
</details>

## Contributing

Contributions of every kind are welcome: code, design, translations, documentation and bug reports. Start with [CONTRIBUTING.md](CONTRIBUTING.md), and please read the [Code of Conduct](CODE_OF_CONDUCT.md). Security issues should be reported privately, as described in [SECURITY.md](SECURITY.md).

## Acknowledgements

OpenWave is built on [yt-dlp](https://github.com/yt-dlp/yt-dlp), [ytmusicapi](https://github.com/sigma67/ytmusicapi), [FastAPI](https://fastapi.tiangolo.com), [aiortc](https://github.com/aiortc/aiortc), [Deno](https://deno.com), [PyInstaller](https://pyinstaller.org) and [Chaquopy](https://chaquo.com/chaquopy/), and inspired by [NewPipe](https://newpipe.net), [FreeTube](https://freetubeapp.io) and [Invidious](https://invidious.io).

## Legal and responsible use

- **OpenWave hosts no content.** It is a client for content that YouTube makes publicly available, built on the same open-source libraries as other community projects such as yt-dlp and NewPipe. It does not store, redistribute or sell music.
- **Non-commercial.** OpenWave is not monetised and never will be. It is intended for personal use.
- **Respect the rights of others.** You are responsible for using OpenWave in line with the terms of the services it connects to and the copyright law of your country. Using third-party clients may conflict with YouTube's Terms of Service. Please support the artists you listen to through official channels.
- **Not affiliated.** OpenWave is an independent project, not affiliated with, endorsed by or connected to YouTube, Google, Spotify or any record label. Product names are used only to describe compatibility.
- **Rights holders** with a concern can [open an issue](https://github.com/SaiSiddharthBS/OpenWave/issues/new/choose) or reach the maintainer privately through the repository's [private reporting form](https://github.com/SaiSiddharthBS/OpenWave/security/advisories/new); concerns are reviewed promptly.

## License

[GNU General Public License v3.0 or later](LICENSE).
