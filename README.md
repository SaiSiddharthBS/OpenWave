<div align="center">

<img src="docs/logo.png" width="200" alt="OpenWave logo">

# OpenWave

**Free, open-source music for everyone.** Search almost any song on YouTube, play it with no ads and no gaps, download it for offline listening, and keep your playlists in sync across your Mac, PC and phone.
<br>No subscriptions. No accounts. No tracking. No premium tier. Ever.

[![CI](https://github.com/SaiSiddharthBS/OpenWave/actions/workflows/ci.yml/badge.svg)](https://github.com/SaiSiddharthBS/OpenWave/actions/workflows/ci.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-7b7bff.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/Android%20·%20macOS%20·%20Windows%20·%20Linux%20·%20iPhone%20(web)-2fc8ff.svg)

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
| 🤖 **Android** (64-bit, Android 7+) | [OpenWave-Android.apk](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-Android.apk) | Open the file and allow your browser to "install unknown apps" when asked. [More](#-on-your-phone) |
| 📱 **iPhone** | Use OpenWave on your computer: **Settings → Phone → scan the QR code** | Then **Add to Home Screen** in Safari |
| 🏠 **Home server** | `docker run -d -p 8787:8787 -v openwave:/data ghcr.io/saisiddharthbs/openwave` | Open `http://<server>:8787` on any device |

Each app is self-contained: there's nothing else to install. The files are attached to every [GitHub release](https://github.com/SaiSiddharthBS/OpenWave/releases) with SHA-256 checksums.

**Staying up to date:** every app tells you when a new version is out (a small card in the app, or a prompt on the Mac) and downloads the right file for your device in one tap. YouTube support updates itself in the background between releases.

> **New in 0.3.1:** play on another device, listen together in sync, an Android home-screen widget, sharing, On Repeat and Rediscover mixes, imports with no song limit from more apps, a smoother phone app with gestures and a working back button, a faster start, and a fix for songs that stopped partway. See the [changelog](CHANGELOG.md).

## ✨ Features

**Listening**
- 🔎 **Search almost any song on YouTube Music:** songs, albums, artists and playlists. You can also paste a YouTube or YouTube Music link.
- 🎵 **Songs, never videos.** OpenWave always plays the clean audio track, so there's no film dialogue, intros or skits. Music videos are swapped for their song version automatically.
- 🎧 **Gapless playback** with optional **crossfade** (0–12 s). The next song buffers while the current one plays, so skipping is instant.
- 📻 **Never-ending autoplay.** When the queue ends, similar music keeps playing, and songs you heard recently are skipped.
- 🎤 **Synced lyrics** scroll with the song. Tap any line to jump to it.
- 🌙 **Sleep timer** (5–90 minutes, or end of song) that fades the music out gently.
- ⚡ **Fast.** Home appears instantly when the app opens, songs get ready while your finger is still on them, and music videos switch to their song version in well under a second.
- ⬇️ **Offline downloads.** Save songs, albums or playlists and listen with no internet.
- 🎚️ **Audio quality:** OpenWave picks the best format your device plays (Opus or AAC, up to about 160 kbps), with a Data saver option.

**Your music, remembered**
- 👤 **Profiles** for everyone in the house, each with its own likes, playlists and history. You can add an optional PIN.
- 🔄 **Sync** across every device that uses your OpenWave: your Mac, your phone and the family PC.
- ❤️ **Liked songs, playlists you can drag to reorder, saved albums and followed artists.**
- ✨ **Personal mixes on Home** ("Made for you", "Because you liked…"), built from what you actually play, plus **On Repeat** (your most-played songs this month) and **Rediscover** (old favourites you haven't played in a while).
- 📊 **Insights:** minutes listened, top artists, top songs and when you listen. You get a **shareable card** for social media.
- 📥 **Import** your playlists from Spotify, YouTube Music, Apple Music, Deezer, JioSaavn, Amazon Music and more, with no song limit.
- 🔗 **Share** any song, album, playlist or artist as a link anyone can open, or share your own playlist as a song list friends can import.

**Together**
- 🔊 **Play on another device.** Tap the devices button in the player to send the music from your phone to your Mac (or the other way round). Your phone becomes the remote: skip, pause, change the volume and pick songs, and the music plays there. One tap brings it back.
- 👥 **Listen together.** Start a listening session and friends on the same Wi-Fi join from their own phones or computers. Everyone hears the same song at the same moment, kept within a few hundredths of a second, and anyone can pause, skip or add songs.
- Works between any OpenWave apps on the same Wi-Fi, with no account and no server. A device has to be allowed once, with a prompt on its screen, before another one can control it.

**Everywhere**
- 🍎 **Native Mac app** with media keys, Control Center, a menu-bar mini player, notifications, a Dock menu and keyboard shortcuts.
- 🪟 **Windows and Linux apps** that install in one click and open in their own window.
- 🤖 **Android app** that runs everything on the phone, no computer needed. It has a home-screen widget, lock-screen and Bluetooth controls, swipe gestures and the back button you'd expect.
- 📱 **Installable web app** for iPhone and ChromeOS.
- 🔒 **Private by design.** Your library stays on your own computer or server, there are no analytics, and your devices never contact Google directly.

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
- **Play on your phone, or let your phone play here:** the devices button moves the music between your Mac and your phones, and starts listening sessions.
- **Updates in one click:** the app tells you when a new version is out and downloads the right one for your Mac (Apple Silicon or Intel).
- **Stays working when YouTube changes.** The app updates its YouTube support automatically in the background.
- `openwave://` links, for example `openwave://play/<videoId>`.

> **First launch:** until OpenWave is notarised by Apple, macOS asks you to confirm it once. Open it, then go to **System Settings → Privacy & Security** and click **Open Anyway**. Builds signed with an Apple Developer ID open with no prompt (see `macos/build.sh`).

**Build it yourself** (requires Xcode and Python 3.11+ or [uv](https://docs.astral.sh/uv/)):

```bash
./macos/build.sh        # → macos/dist/OpenWave.app and OpenWave-macOS-<AppleSilicon|Intel>.dmg
```

**Android** is built with `cd android && ./gradlew assembleRelease` (needs the Android SDK, JDK 17+ and Python 3.12). **Windows and Linux** apps are built by [`.github/workflows/desktop.yml`](.github/workflows/desktop.yml). They bundle the same engine with a small launcher (`openwave/launcher.py`) that opens OpenWave in its own window, using Microsoft Edge on Windows or Chrome/Chromium on Linux.

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

### Android
1. Download **[OpenWave-Android.apk](https://github.com/SaiSiddharthBS/OpenWave/releases/latest/download/OpenWave-Android.apk)** on your phone and open it.
2. Android asks you to allow your browser to install apps. Allow it, then tap **Install**.
3. Open OpenWave and create your profile. Everything runs on the phone, so it works anywhere.
4. Optional: add the **home-screen widget** from **Settings → Add widget**.

**Updates:** the app shows a card when a new version is out. Tap it to download, then install it over the old one; your library stays.

**Fully automatic updates:** install [Obtainium](https://github.com/ImranR98/Obtainium) and add `https://github.com/SaiSiddharthBS/OpenWave`. It installs new versions as soon as they're released.

**One library everywhere:** in **Settings → Library**, tap **Connect to computer** and enter the address shown in OpenWave on your computer (Settings → Phone). The phone then uses the same profiles and playlists as your computer.

### iPhone (and any other phone)
1. Start OpenWave on your computer. Use the Mac app's **Settings → Phone** QR code, or the `Your phone: http://192.168.x.x:8787` address the server prints.
2. Open it on your phone while you're on the same Wi-Fi, and pick your profile. Your library is already there.
3. Install it:
   - **iPhone:** in Safari, use **Share → Add to Home Screen**.
   - **Android:** in Chrome, use **⋮ → Install app**.

To listen away from home and use offline mode on a phone, use HTTPS. Tailscale is the easiest way (`tailscale serve 8787`); a Cloudflare Tunnel or a VPS with [Caddy](https://caddyserver.com) also work.

## 🔁 Bring your playlists

Go to **Library → Import** (or ⌘⇧I on Mac). There's no song limit.

| From | Paste a link | Or import a file (every song, every playlist) |
|---|---|---|
| **Spotify** | ✅ first 100 songs (all Spotify shares publicly) | [Exportify](https://exportify.app) CSV, or Spotify → Account → Privacy → *Download your data* |
| **YouTube / YouTube Music** | ✅ every song | Google Takeout CSV |
| **Apple Music** | ✅ playlists and albums | Music app → File → Library → *Export Playlist* (text or XML) |
| **Deezer** | ✅ every song | — |
| **JioSaavn** | ✅ | — |
| **Amazon Music, Tidal, SoundCloud and others** | — (Amazon doesn't share playlists publicly) | [TuneMyMusic](https://www.tunemymusic.com) (free) → *Export to file*, or a Soundiiz CSV |
| **Anything else** | — | A pasted list, one `Artist - Title` per line |

A file with several playlists in it becomes several playlists.

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
- **Android app:** the same Python engine runs on the phone through [Chaquopy](https://chaquo.com/chaquopy/), inside a native Kotlin app with Android's media notification, lock-screen and Bluetooth controls.
- **Windows and Linux apps:** the same self-contained engine, plus a small launcher that opens OpenWave in an app window using Microsoft Edge or Chrome/Chromium.
- **Your devices together:** engines on the same Wi-Fi find each other with a UDP broadcast and talk over a separate, small listener that only knows the "devices" routes. A device has to be allowed once before it can control another. Only "what's playing" is shared; each device streams the audio itself, and listeners stay in step by playing a touch faster or slower.
- **Songs, not videos:** when YouTube offers a music video, the server looks up its audio-track ("song") version, and radios are started from songs. You hear the record, not a film scene.

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
| `GET /api/me/smart` | On Repeat and Rediscover |
| `/api/link/*` | other devices on the Wi-Fi: devices, remote control, listening sessions |
| `GET /api/app-update` | whether a newer OpenWave is out, and the right file for this device |

</details>

<details>
<summary><b>Configuration</b></summary>

| Env var | Effect |
|---|---|
| `OPENWAVE_DATA` | Where profiles and libraries are stored (default: your OS's app-data folder; `/data` in Docker) |
| `OPENWAVE_LOCATION` | Region for recommendations, e.g. `US`, `IN`, `GB` |
| `OPENWAVE_LANGUAGE` | Metadata language, e.g. `en`, `hi`, `es` |
| `OPENWAVE_LINK` | `1` makes this device visible to your other devices on the Wi-Fi from the start (the Mac and Android apps do this; it can also be switched in Settings → Devices) |
| `OPENWAVE_DEVICE_NAME` | The name other devices see (default: the computer's name) |

</details>

## ❓ FAQ

**Is it really free?**
Yes, forever. There's nothing to buy, and the GPL-3.0 license keeps every version of OpenWave free and open source.

**Do I need an account?**
No. Profiles are just names, with an optional PIN, stored on your own server. There's no email and no sign-up.

**Does it play music videos?**
No, on purpose. OpenWave always plays the song itself, so you never get film dialogue, intros or skits in the middle of your music.

**Why isn't it on the App Store or Google Play?**
Both stores reject apps that play YouTube content, which is why projects like NewPipe are distributed directly instead. OpenWave is downloaded from this page (or [the website](https://saisiddharthbs.github.io/OpenWave/)), and the source is open for anyone to check. On Android, [Obtainium](https://github.com/ImranR98/Obtainium) gives you store-style automatic updates.

**Playback stopped working for everything.**
YouTube changes things now and then. The Mac, Windows and Linux apps update their YouTube support by themselves in the background (restart the app to apply). For a server, run `pip install -U "yt-dlp[default]" ytmusicapi` (the start scripts do this automatically) or rebuild the Docker image.

**Does it work on Android and iPhone?**
Android has its own app that runs everything on the phone. On iPhone, use OpenWave on your computer or home server: open it in Safari and use **Add to Home Screen**. OpenWave automatically uses formats iOS plays well.

**Can my family use it?**
Yes. Run it on one computer or server and give everyone their own profile.

**Can someone else on my Wi-Fi take over my music?**
No. Other devices can see your device's name in their Devices list, but a device has to be allowed once, by tapping **Allow** on your screen, before it can play anything or join your session. Remove a device any time in **Settings → Devices**, or turn off **Show this device on Wi-Fi** to hide it completely. Only "what's playing" travels between devices (no audio, no library), over ports 47880–47889 on your local network. The Mac and Android apps start visible; the Windows and Linux apps, Docker and the server start hidden.

## 🗺️ Roadmap

See what changed in each version in [CHANGELOG.md](CHANGELOG.md).


- [x] Standalone Android app (no computer needed)
- [x] In-app updates on every platform
- [x] Play on another device and listen together (same Wi-Fi)
- [ ] Listen together over the internet
- [ ] OpenWave on F-Droid / IzzyOnDroid
- [ ] iPhone app (sideloading via AltStore)
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

[yt-dlp](https://github.com/yt-dlp/yt-dlp) · [ytmusicapi](https://github.com/sigma67/ytmusicapi) · [FastAPI](https://fastapi.tiangolo.com) · [Deno](https://deno.com) · [PyInstaller](https://pyinstaller.org) · [Chaquopy](https://chaquo.com/chaquopy/). Inspired by [NewPipe](https://newpipe.net), [FreeTube](https://freetubeapp.io) and [Invidious](https://invidious.io).

## ⚖️ Disclaimer

OpenWave is an independent project. It is **not affiliated with, endorsed by, or connected to YouTube, Google or Spotify**. It hosts no content: it's a client for publicly available content, built on the same open-source libraries other community projects use. Using third-party clients may go against YouTube's Terms of Service. OpenWave is meant for personal use; please support the artists you love.

## 📄 License

[GNU General Public License v3.0 or later](LICENSE).

<div align="center"><sub>Made with ♥ so that everyone, everywhere, can enjoy music freely.</sub></div>
