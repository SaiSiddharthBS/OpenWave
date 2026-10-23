<div align="center">

<img src="docs/logo.png" width="200" alt="OpenWave logo">

# OpenWave

**Free, open-source music for everyone.** Search almost any song on YouTube, play it with no ads and no gaps, download it for offline listening, and keep your playlists in sync across your Mac, PC and phone.
<br>No subscriptions. No accounts. No tracking. No premium tier. Ever.

[![CI](https://github.com/SaiSiddharthBS/OpenWave/actions/workflows/ci.yml/badge.svg)](https://github.com/SaiSiddharthBS/OpenWave/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-7b7bff.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/macOS%20app%20·%20Web%20·%20Android%20·%20iOS%20·%20Windows%20·%20Linux-2fc8ff.svg)

**[⬇️ Download OpenWave](https://saisiddharthbs.github.io/OpenWave/)**

[Get it](#-get-openwave) · [Features](#-features) · [Mac app](#-the-mac-app) · [Phone](#-on-your-phone) · [Switch from Spotify](#-bring-your-playlists) · [How it works](#-how-it-works) · [FAQ](#-faq) · [Contribute](#-contributing)

<img src="docs/screenshots/home.png" alt="OpenWave home with personal mixes" width="100%">

</div>

## ⬇️ Get OpenWave

Everything is free. Pick your device:

| Device | Download | First launch |
|---|---|---|
| 🍎 **Mac** (Apple Silicon) | [OpenWave-macOS-AppleSilicon.dmg](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-macOS-AppleSilicon.dmg) | Drag it to Applications and open it. If macOS can't verify it, go to **System Settings → Privacy & Security → Open Anyway** (once). |
| 🍎 **Mac** (Intel) | [OpenWave-macOS-Intel.dmg](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-macOS-Intel.dmg) | Same as above |
| 🪟 **Windows 10/11** | [OpenWave-Windows-Setup.exe](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-Windows-Setup.exe) | If you see "Windows protected your PC", click **More info → Run anyway**. No admin needed. |
| 🐧 **Linux** | [OpenWave-Linux-x86_64.AppImage](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-Linux-x86_64.AppImage) | Make it executable (`chmod +x`), then double-click. |
| 📱 **Phone** | Use the app on your computer: **Settings → Phone → scan the QR code** | Then **Add to Home Screen**. [More](#-on-your-phone) |
| 🏠 **Home server** | `docker run -d -p 8787:8787 -v openwave:/data ghcr.io/saisiddharthbs/openwave` | Open `http://<server>:8787` on any device |

Each desktop app is self-contained: there's nothing else to install.

## ✨ Features

**Listening**
- 🔎 **Search almost any song on YouTube Music:** songs, albums, artists and playlists. You can also paste a YouTube or YouTube Music link.
- 🎵 **Songs, never videos.** OpenWave always plays the clean audio track, so there's no film dialogue, intros or skits. Music videos are swapped for their song version automatically.
- 🎧 **Gapless playback** with optional **crossfade** (0–12 s). The next song buffers while the current one plays, so skipping is instant.
- 📻 **Never-ending autoplay.** When the queue ends, similar music keeps playing, and songs you heard recently are skipped.
- 🎤 **Synced lyrics** scroll with the song. Tap any line to jump to it.
- 🌙 **Sleep timer** (5–90 minutes, or end of song) that fades the music out gently.
- ⬇️ **Offline downloads.** Save songs, albums or playlists and listen with no internet.
- 🎚️ **Audio quality:** OpenWave picks the best format your device plays (Opus or AAC, up to about 160 kbps), with a Data saver option.

**Your music, remembered**
- 👤 **Profiles** for everyone in the house, each with its own likes, playlists and history. You can add an optional PIN.
- 🔄 **Sync** across every device that uses your OpenWave: your Mac, your phone and the family PC.
- ❤️ **Liked songs, playlists you can drag to reorder, saved albums and followed artists.**
- ✨ **Personal mixes on Home** ("Made for you", "Because you liked…"), built from what you actually play.
- 📊 **Insights:** minutes listened, top artists, top songs and when you listen. You get a **shareable card** for social media.
- 📥 **Import** from Spotify (paste a link or use an Exportify CSV), any YouTube playlist, or a plain song list.

**Everywhere**
- 🍎 **Native Mac app** with media keys, Control Center, a menu-bar mini player, notifications, a Dock menu and keyboard shortcuts.
- 📱 **Installable web app** for Android, iPhone, Windows, Linux and ChromeOS.
- 🔒 **Private by design.** Your devices never talk to Google directly, and nothing ever leaves the server you run.

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/now-playing-lyrics.png" alt="Now playing with synced lyrics"><p align="center"><sub>Now playing with synced lyrics</sub></p></td>
    <td width="50%"><img src="docs/screenshots/insights.png" alt="Listening insights"><p align="center"><sub>Your insights</sub></p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/profiles.png" alt="Profiles"><p align="center"><sub>A profile for everyone, synced everywhere</sub></p></td>
    <td width="50%"><img src="docs/screenshots/import.png" alt="Import from Spotify"><p align="center"><sub>Importing a Spotify playlist: 50 of 50 songs found</sub></p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/screenshots/artist.png" alt="Artist page"><p align="center"><sub>Artist pages</sub></p></td>
    <td width="50%"><img src="docs/screenshots/offline.png" alt="Offline mode"><p align="center"><sub>Offline mode plays your downloads</sub></p></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/mobile-home.png" width="250" alt="Home on a phone">
  &nbsp;
  <img src="docs/screenshots/mobile-now-playing.png" width="250" alt="Now playing on a phone">
  &nbsp;
  <img src="docs/screenshots/share-card.png" width="250" alt="Shareable insights card">
</p>

## 🍎 The Mac app

<img src="docs/screenshots/mac-app.png" alt="OpenWave for macOS" width="100%">

The Mac app runs everything itself, so there's nothing to install or configure:
- **Media keys and Control Center:** play/pause, next and previous work from your keyboard, AirPods and the lock screen, with album art.
- **Menu-bar mini player:** control the music without opening the window.<br><img src="docs/screenshots/mac-miniplayer.png" width="300" alt="Menu bar mini player">
- **Keeps playing when you close the window,** just like Music.app.
- **Native menus and shortcuts:** ⌘→ / ⌘← next/previous, ⌘L like, ⌘F search, ⌘1–5 to jump between sections, ⌘⇧I import.
- **Song notifications** when OpenWave is in the background, and a Dock menu with playback controls.
- **Listen on your phone:** in Settings → Phone, switch it on and scan the QR code.
- **Stays working when YouTube changes.** The app updates its YouTube support automatically in the background.
- `openwave://` links, for example `openwave://play/<videoId>`.

> **First launch:** until OpenWave is notarised by Apple, macOS asks you to confirm it once. Open it, then go to **System Settings → Privacy & Security** and click **Open Anyway**. Builds signed with an Apple Developer ID open with no prompt (see `macos/build.sh`).

**Build it yourself** (requires Xcode and Python 3.11+ or [uv](https://docs.astral.sh/uv/)):

```bash
./macos/build.sh        # → macos/dist/OpenWave.app and OpenWave-macOS-<AppleSilicon|Intel>.dmg
```

**Windows and Linux** apps are built by [`.github/workflows/desktop.yml`](.github/workflows/desktop.yml). They bundle the same engine with a small launcher (`openwave/launcher.py`) that opens OpenWave in its own window, using Microsoft Edge on Windows or Chrome/Chromium on Linux.

## 🖥️ Run the server

You run the server once on a PC, Mac, home server or VPS, and then open OpenWave from any device.

**One command** (macOS / Linux / Windows). You need [Python 3.10+](https://www.python.org/downloads/) and [Deno](https://deno.com) or [Node.js 20+](https://nodejs.org):

```bash
git clone https://github.com/SaiSiddharthBS/OpenWave.git && cd OpenWave
./scripts/start.sh          # Windows: scripts\start.bat
```

**Docker:**

```bash
git clone https://github.com/SaiSiddharthBS/OpenWave.git && cd OpenWave
docker compose up -d --build        # profiles & libraries persist in the openwave-data volume
```

**pip:**

```bash
pip install git+https://github.com/SaiSiddharthBS/OpenWave.git
openwave                    # --port 8787  --host 0.0.0.0  --no-browser
```

## 📱 On your phone

1. Start OpenWave on your computer. Use the Mac app's **Settings → Phone** QR code, or the `Your phone: http://192.168.x.x:8787` address the server prints.
2. Open it on your phone while you're on the same Wi-Fi, and pick your profile. Your library is already there.
3. Install it:
   - **iPhone:** in Safari, use **Share → Add to Home Screen**.
   - **Android:** in Chrome, use **⋮ → Install app**.

To listen away from home and use offline mode on a phone, use HTTPS. Tailscale is the easiest way (`tailscale serve 8787`); a Cloudflare Tunnel or a VPS with [Caddy](https://caddyserver.com) also work.

## 🔁 Bring your playlists

Go to **Library → Import** (or ⌘⇧I on Mac) and use any of these:
- **A Spotify playlist or album link.** Public playlists work; Spotify only shares the first 100 songs of a link.
- **An [Exportify](https://exportify.app) CSV** with all your Spotify playlists, at any size.
- **A YouTube or YouTube Music playlist link.**
- **A pasted list,** one `Artist - Title` per line.

OpenWave matches every song on YouTube Music, comparing title, artist and length, and builds the playlist for you. In testing, it matched 50 of 50 songs from Spotify's "Today's Top Hits" in about 12 seconds.

## 🧠 How it works

```
 Mac app / browser / phone                     OpenWave server (FastAPI)                     YouTube
┌──────────────────────────────┐ /api/search  ┌──────────────────────────────────┐
│ UI · queue · lyrics          │────────────▶ │ ytmusicapi → catalog, radio,     │ ──▶ music.youtube.com
│ 2 audio decks (gapless/xfade)│ /api/me/*    │   lyrics                         │
│ downloads (IndexedDB)        │────────────▶ │ SQLite → profiles, likes,        │
│ offline outbox → sync        │              │   playlists, plays, insights     │
│                              │ /api/stream  │ yt-dlp (+Deno) → streams         │ ──▶ youtube.com
│ Mac: Swift shell + bridge    │◀──────────── │ byte-range proxy                 │ ◀── googlevideo.com
└──────────────────────────────┘              └──────────────────────────────────┘
```

- **Streaming:** YouTube ties stream URLs to the IP that asked for them, so the server proxies the audio with range requests. Your devices never contact Google.
- **Your library:** it lives in a SQLite database on your server, one per profile. Changes apply instantly on the device you're using, queue up while you're offline, and sync when you're back. Other devices pick them up within seconds.
- **The Mac app:** a native Swift app (AppKit + SwiftUI) that runs a self-contained copy of the server and shows the same interface, so every feature reaches every platform at once.

<details>
<summary><b>HTTP API</b> (interactive docs at <code>/api/docs</code>)</summary>

| Endpoint | Returns |
|---|---|
| `GET /api/search?q=&type=all\|songs\|albums\|artists\|playlists` | normalised results |
| `GET /api/home` · `/api/album/{id}` · `/api/playlist/{id}` · `/api/artist/{id}` | catalog pages |
| `GET /api/next/{videoId}` · `/api/lyrics/{videoId}` | radio, lyrics |
| `GET /api/stream/{videoId}?q=&codec=opus\|aac` · `/api/download/{videoId}` | audio |
| `GET /api/audio/{videoId}` | the song (audio-track) version of any video |
| `GET/POST /api/profiles` · `POST /api/profiles/{id}/login` | profiles & sign-in |
| `GET /api/me/library` · `POST /api/me/ops` · `GET /api/me/version` | library sync |
| `GET /api/me/stats` · `/api/me/mixes` · `/api/me/radio/{videoId}` | insights, mixes, personal radio |
| `POST /api/import/parse` · `/api/import/match` | playlist import |

</details>

<details>
<summary><b>Configuration</b></summary>

| Env var | Effect |
|---|---|
| `OPENWAVE_DATA` | Where profiles and libraries are stored (default: your OS's app-data folder; `/data` in Docker) |
| `OPENWAVE_LOCATION` | Region for recommendations, e.g. `US`, `IN`, `GB` |
| `OPENWAVE_LANGUAGE` | Metadata language, e.g. `en`, `hi`, `es` |

</details>

## ❓ FAQ

**Is it really free?**
Yes, forever. There's nothing to buy, and the GPL-3.0 license keeps every version of OpenWave free and open source.

**Do I need an account?**
No. Profiles are just names, with an optional PIN, stored on your own server. There's no email and no sign-up.

**Playback stopped working for everything.**
YouTube changes things now and then. The Mac app updates its YouTube support by itself. For a server, run `pip install -U "yt-dlp[default]" ytmusicapi` (the start scripts do this automatically) or rebuild the Docker image.

**Does it work on iPhone?**
Yes, in Safari: use **Add to Home Screen**. OpenWave automatically uses formats iOS plays well.

**Can my family use it?**
Yes. Run it on one computer or server and give everyone their own profile.

## 🗺️ Roadmap

- [ ] Standalone Android app (no computer needed), distributed as an APK, via Obtainium and on F-Droid
- [ ] Notarised Mac builds and signed Windows builds (no first-launch prompts)
- [ ] Equalizer and loudness normalisation
- [ ] Collaborative playlists across profiles
- [ ] Translations

Ideas are welcome: [open an issue](https://github.com/SaiSiddharthBS/OpenWave/issues).

## 🤝 Contributing

OpenWave is built by people who believe music should be free to enjoy. Code, design, translations, docs and bug reports all help. Start with **[CONTRIBUTING.md](CONTRIBUTING.md)**.

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m openwave --no-browser      # http://localhost:8787
.venv/bin/pytest
```

## 🙏 Built with

[yt-dlp](https://github.com/yt-dlp/yt-dlp) · [ytmusicapi](https://github.com/sigma67/ytmusicapi) · [FastAPI](https://fastapi.tiangolo.com) · [Deno](https://deno.com) · [PyInstaller](https://pyinstaller.org). Inspired by [NewPipe](https://newpipe.net), [FreeTube](https://freetubeapp.io) and [Invidious](https://invidious.io).

## ⚖️ Disclaimer

OpenWave is an independent project. It is **not affiliated with, endorsed by, or connected to YouTube, Google or Spotify**. It hosts no content: it's a client for publicly available content, built on the same open-source libraries other community projects use. Using third-party clients may go against YouTube's Terms of Service. OpenWave is meant for personal use; please support the artists you love.

## 📄 License

[GNU General Public License v3.0 or later](LICENSE).

<div align="center"><sub>Made with ♥ so that everyone, everywhere, can enjoy music freely.</sub></div>
