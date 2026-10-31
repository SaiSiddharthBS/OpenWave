# Changelog

All notable changes to OpenWave. Versions follow [Semantic Versioning](https://semver.org).
Write new changes under **Unreleased**; `scripts/release.sh` turns that into the next version's section.

## [Unreleased]

### Added
- **iPhone, anywhere:** the Mac app's Settings → Phone has a new "Anywhere" option. With Tailscale (free) on the Mac and the iPhone, one click gives the iPhone a private HTTPS address for OpenWave on the Mac: it works on mobile data, downloads play offline, and only your own devices can open it.
- **Install on a Mac with one command**, with no "can't verify the developer" warning: `curl -fsSL https://saisiddharthbs.github.io/OpenWave/install.sh | bash`. It picks the Apple Silicon or Intel version by itself.
- **Stats page** on the website: downloads per app, version and day, stars and visitors. Public numbers from GitHub only; nothing is collected from the apps.

### Changed
- **Mac updates install themselves.** The app downloads the new version, checks its checksum, swaps itself and restarts, with no browser and no security warning.
- The website's Mac button no longer offers the Apple Silicon download to Intel Macs.
- A new README with fresh screenshots of every platform, line icons instead of emoji on the website, and release notes without emoji.
- A security policy, code of conduct, pull request template and clearer issue forms.
- OpenWave now describes itself as an open-source, non-commercial music player, with no "ad-free" or "instead of a subscription" wording in the app, website, README or release notes, and a clearer note on legal and responsible use.

### Fixed
- **Long song names on phones:** a long title or artist list no longer pushes the artwork, the end time and the controls of the Now Playing screen (and its Up next and Lyrics sheets) off the right edge, and no longer makes Search results wider than the screen. Titles are shortened with "…" instead. Fixed at the root: no one-column layout can grow wider than the screen any more.
- Very long unbroken words in album and artist descriptions now wrap.

### Added
- **Layout audit** (`tests/ui/layout_audit.mjs`, run in CI on every push): opens all 16 main screens at eight sizes, from a 320 px phone to a desktop, with real-world and extremely long names, and fails if anything goes past the edge of the screen or a screen fails to open.

## [0.3.1] — 2026-10-25

### Added
- **Play on another device.** The new devices button in the player lists every OpenWave on your Wi-Fi. Pick one and the music moves there, carrying on from the same second, and this device becomes its remote: play, pause, skip, seek, volume, the queue, and anything you choose to play. "Play on this phone" brings it back.
- **Listen together.** Start a listening session and anyone on the same Wi-Fi can join from their Devices list. Every device plays the same song at the same moment (kept within a few hundredths of a second by gently speeding up or slowing down). Anyone in the session can pause, skip or add songs.
- Devices find each other automatically, with no account and no server, and a device has to be allowed once (a prompt on its screen) before another one can control it or join it. Manage this under **Settings → Devices**, where you can also rename the device, hide it, or remove allowed devices. If a network stops devices seeing each other, add one by its address.
- **Import from more apps, with no song limit.** Paste a playlist or album link from **Spotify, YouTube Music, Apple Music, Deezer or JioSaavn**. Or import an export file: **Exportify** or Spotify's own data download (every song, every playlist), **TuneMyMusic** (Amazon Music, Tidal, SoundCloud and more), **Soundiiz**, the **Apple Music** app's Export Playlist, and **Google Takeout** for YouTube Music. A file with several playlists becomes several playlists. The import screen explains where to get each file.
- YouTube and YouTube Music playlists import every song (before: the first 300).
- **A smoother, more native phone app.** Pages slide in and out. Swipe the player down to close it, and swipe the artwork or the mini player to change songs. Long-press a song for its menu. Android gives a small vibration for these, images fade in, and everything you tap reacts.
- **Home shortcuts** to your liked songs, downloads and playlists.
- **Home-screen widget (Android):** artwork, song and artist, with previous, play/pause and next. Add it from Settings → Add widget.
- **Share** any song, album, playlist or artist (song menu, the player's ⋯ menu, or a page's ⋯ menu). It shares a normal YouTube Music link anyone can open, and friends with OpenWave on Android can open it straight in the app. Your own playlists share as a song list friends can paste into Import.
- **On Repeat and Rediscover:** two playlists made only from your own listening. On Repeat has the songs you've played most this month; Rediscover has favourites you haven't played in a while.
- Shared YouTube Music album and artist links now open the right page.
- **Faster.** Home opens instantly (the last Home is shown while a fresh one loads). Tapping a music video starts its song about 0.6 s sooner. Songs get ready while your finger is on them, and the song you were last playing is ready when the app opens. The song version of each music video is remembered between launches.
- On phones, **Library is a list**, and on album, playlist and artist pages the top bar takes the page's colour and shows its title as you scroll.

### Fixed
- **Android back button:** it now closes menus and the player, then goes to the previous screen, and only steps out of the app on Home. Before, it left the app.
- The back and forward arrows no longer show in the Android app.
- Home's Quick picks no longer run off the edge of phone screens (long titles like "Gehra Hua" looked cropped).
- Error pages explain problems in plain words.
- Right after an update, the phone app could show the previous version's screens until it was opened again. It now always loads the new version.
- On phones, the page title in the top bar no longer overlaps the OpenWave logo when you scroll Settings or Library.
- After an update, the app could keep using some old files for hours, because browsers cached them without re-checking. App files are now always re-checked (cheap when unchanged).
- **Songs no longer stop partway and skip to the next one.** In the Mac app (and Safari), every song longer than about 4 minutes was cut off around the 4-minute mark: the engine answered the player with only the first piece of the song, and WebKit took that as the end. The engine now always sends the whole song, fetching it from YouTube piece by piece behind the scenes, and picks up from the exact spot if YouTube drops the connection (for example during a long pause).
- If a song ever does stop early, the player now continues it from that point instead of skipping it.

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
- **One-tap updates**: the apps tell you when a new version is out and download the right file for your device (Android, Windows, Linux and Mac). Also in Settings → About.
- **Checksums** (`.sha256`) next to every installer in each release.

### Changed
- **New Mac menu-bar icon**: the silver glass wave, shown in full colour instead of a flat silhouette.

### Fixed
- If you downloaded a song from a music video, the original item now shows as downloaded and plays offline. Before, it tried to stream.
- Opening the Windows or Linux app a second time now just opens another window, without taking over the running engine.
- The Mac app keeps the same address when it restarts (for example after an update). Before, it sometimes moved, which made downloads and your chosen profile seem to disappear.

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
