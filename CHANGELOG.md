# Changelog

All notable changes to OpenWave. Versions follow [Semantic Versioning](https://semver.org).

## [0.3.0] — 2026-10-24

OpenWave comes to Android, with no computer needed.

### Added
- **Android app** (64-bit phones, Android 7+). OpenWave's full engine runs on the phone itself: search, songs-only playback, profiles, playlists, imports, insights, offline downloads and lyrics.
  - Media notification and lock-screen controls, plus headphone and Bluetooth buttons.
  - Pauses for calls and other apps, and pauses when headphones are unplugged.
  - Keeps playing in the background.
  - Share a YouTube or YouTube Music link to OpenWave to play it, and use `openwave://` links.
  - **Library location:** keep the library on the phone, or connect to OpenWave on your computer to share one library everywhere.
  - Library backups and insight cards open Android's share sheet.
- **Checksums** (`.sha256`) next to every installer in each release.

### Changed
- **New logo in the app's top bar**: a silver glass wave.

### Fixed
- If you downloaded a song from a music video, the original item now shows as downloaded and plays offline. Before, it tried to stream.
- Opening the Windows or Linux app a second time now just opens another window, without taking over the running engine.

## [0.2.0] — 2026-10-24

The first public release: OpenWave becomes a full music app on Mac, Windows and Linux.

### Added
- **Native Mac app**: media keys, Control Center / lock screen "Now Playing" with artwork, a menu-bar mini player, song notifications, a Dock menu, native menus and shortcuts (⌘→, ⌘←, ⌘L, ⌘F, ⌘1–5, ⌘⇧I), `openwave://` links, launch at login, and update checks. Closing the window keeps the music playing.
- **Windows installer and Linux AppImage**: one-click apps that open OpenWave in their own window. No Python, Docker or setup needed.
- **Profiles**, with an optional PIN, so everyone in the house gets their own likes, playlists, history and settings.
- **Sync** across every device that uses your OpenWave. Changes made offline are queued and sent when you reconnect.
- **Gapless playback** and **crossfade** (2–12 s). The next song buffers ahead of time, so skipping is instant.
- **Personal mixes** on Home ("Made for you", "Because you liked…"), built from what you play.
- **Smarter autoplay** that skips songs you heard recently.
- **Insights**: minutes listened, top artists, top songs and when you listen, plus a shareable image card.
- **Import playlists** from Spotify links, Exportify CSV files, YouTube playlists or plain song lists.
- **Sleep timer** (5–90 minutes or end of song) with a gentle fade-out.
- **Drag to reorder** the queue and your playlists.
- **Phone access from the Mac app**: turn it on and scan a QR code.
- **Self-updating YouTube support** in the desktop apps, so they keep working when YouTube changes.
- **Download website**, plus Docker images for both PC (amd64) and ARM (arm64), with a persistent data volume.

### Changed
- **Songs, never videos.** OpenWave plays the audio track of every song: music videos are swapped for their song version, albums use their audio-only tracks, and radios are started from songs. No more film dialogue, intros or skits.
- **New logo and icons** everywhere: a glassy macOS app icon, a glass-style logo in the app, and a menu-bar icon.
- **Better audio formats**: OpenWave picks Opus or AAC to suit your device.
- First play starts in about 3 seconds instead of about 9.

### Fixed
- Safari, iPhone and the Mac app read YouTube's AAC files as twice their real length, which meant silence instead of the next song. The app now uses formats those devices read correctly, with a safety net.
- The Windows app now finds its bundled JavaScript runtime (`deno.exe`).
- The previous song now stops the moment you pick a new one.
- A pasted YouTube link no longer shows the same song twice.

### Removed
- Video mode. OpenWave is now focused entirely on music.

## [0.1.0] — 2026-10-23

- First version: search YouTube Music, stream audio through a self-hosted server, synced lyrics, an installable web app, offline downloads and a Docker image.

[0.3.0]: https://github.com/SaiSiddharthBS/OpenWave/releases/tag/v0.3.0
[0.2.0]: https://github.com/SaiSiddharthBS/OpenWave/releases/tag/v0.2.0
