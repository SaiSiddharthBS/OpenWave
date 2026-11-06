# Changelog

All notable changes to OpenWave. Versions follow [Semantic Versioning](https://semver.org).
Write new changes under **Unreleased**; `scripts/release.sh` turns that into the next version's section.

## [Unreleased]

## [0.5.8] — 2026-11-06

### Fixed
- **Songs no longer show twice their length and then go silent.** Safari's engine (the Mac app, iPhone and iPad) reports double the length of some songs' audio, for example Lungi Dance (9:10 instead of 4:35), and then plays silence for the second half. OpenWave already corrected this, but only for one audio format, and only when the song's list included its length. Every song is now checked against YouTube's own length as it starts, so it shows the right length and moves on at its real end.

### Changed
- **The Stats page counts real downloads only.** Every release now also has a copy of each app just for updates, and the apps (and the Mac install script, on a Mac that already has an older OpenWave) update from that copy. New installs and reinstalls still count; updates don't. Releases before 0.5.8 had no such copy, so their numbers still include updates.

## [0.5.7] — 2026-11-04

### Changed
- **A cleaner top bar on computers.** The search box sits in the middle of the page and is wider, with a clear button inside it (and Escape clears it too). Search is no longer repeated in the sidebar.
- **You're at the foot of the sidebar**, with Settings beside you. The profile menu only has what isn't a tap away already: Import playlists and Switch profile (and Your insights on a phone, which has no sidebar).
- Audio quality and Crossfade in Settings use OpenWave's own menus instead of the browser's.
- **The iPhone Home Screen app has a solid status bar** in the app's colour. With a see-through one, iOS 26 leaves an empty strip at the bottom of the screen. To get it, remove OpenWave from the Home Screen, add it again from Safari, and pair it again with the code from the computer.

### Fixed
- In the Mac app, the window's close, minimise and zoom buttons sat on the sidebar's top-left corner. The sidebar now starts just below them.

## [0.5.6] — 2026-11-04

### Changed
- **The full-screen player opens and closes without a stutter.** Everything is drawn and set up while the player is still invisible, in the moment after you tap, and only then starts to move, and every part of the animation now ends together. The very first opening is prepared ahead, while the first song loads. Measured on an Intel MacBook Pro, every frame of the motion now takes 15 to 19 ms.
- On phones and upright tablets, the sleep timer and devices buttons sit in the row under the controls, either side of Up next and Lyrics, so "Playing from" is centred at the top with one button on each side.

### Fixed
- In the Mac app, the sidebar's glass was cut off at the left edge of the window. It now has the same gap and rounded corners on every side as the rest of the glass.
- "Playing from" at the top of the full-screen player was off-centre on Android and other phones.
- **iPhone Home Screen app reaches the bottom of the screen.** iOS 26 lays out Home Screen apps one status bar too short (WebKit bug 301108), which left an empty strip below the tab bar. Close the app fully and open it again after updating; there's no need to add it to the Home Screen again.
- On a phone, "Connecting to…" no longer covers the buttons in the top bar: it sits just under it.
- The screen-layout test no longer stops when a slow test machine briefly loses touch with its browser, and its failures now say which screen and why. A UI test that fails is retried once, and stays red if it fails again.

## [0.5.5] — 2026-11-03

### Changed
- **Smoother full-screen player.** Opening and closing it was choppy on the Mac: the player bar widened by redoing the page's layout on every frame, the artwork's corners were animated in a way that kept the graphics chip out of it, and Up next was built as the player opened. The bar now stretches and the artwork flies on the graphics chip, and Up next is ready beforehand. Measured on an Intel MacBook Pro, the worst stutter went from about 220 ms to under 90 ms, and closing costs about the same as no animation at all.
- **A cleaner start.** The Mac and Android apps show only the OpenWave logo while they start, with no "Starting OpenWave…" or "Loading…" text. Messages still appear when something needs your attention.

## [0.5.4] — 2026-11-03

### Fixed
- **Smooth Full animations on the Mac, iPhone and iPad.** Measured on an Intel MacBook Pro, a third of frames came late with the full-screen player open, and going back to Home or scrolling was choppy. In Safari's engine the colour behind the app now holds still, pieces of a page fade in as you scroll instead of sliding, and the springy motion uses curves the graphics chip can run by itself. Pages still slide in and the player still grows out of the mini player.

## [0.5.3] — 2026-11-03

### Added
- **Daily Mixes.** Three new mixes every day on Home, each with one mood: artists you play together share a mix, and it's part songs you love and part songs you haven't heard. They learn as you listen: songs you finish count for more, songs you keep skipping are left out, and recent listening counts most. Every profile has its own.
- **Tablet layouts.** Upright, tablets get their own layout: the tabs and the mini player share one row, covers and titles sit side by side, Quick picks and your Library use the room, and search is always at the top. On its side, a tablet gets the computer's layout with buttons sized for fingers.
- **Update notifications.** The Android app tells you about a new version with a notification, even when it's closed. The Mac, Windows and Linux apps look for updates every few hours while they're open and tell the system, not only when they start. The iPhone app updates itself and says so.

### Changed
- The Mac app updates from a card in the app with one click, instead of a window that interrupts you.
- **Later** on an update now means a few days, and a newer version shows up straight away.
- Full animations are on by default on every device (this was in 0.5.2, which was never published).
- Songs with little colour in their artwork let the app's own colours show behind them instead of grey.

### Fixed
- Search suggestions no longer disappear a moment after they appear, and results no longer flash while you type.
- On a computer, closing the full-screen player now shrinks the artwork into the mini player instead of sending it to the far left of the window.
- A song of unknown length shows –:–– instead of 0:00, and remembers its length once it has played.

## [0.5.2] — 2026-11-03

### Changed
- **Full animations are on by default on every device**, including devices set to reduce motion. Settings → Appearance → **Full animations** is now always there, and turning it off gives gentle fades instead.

## [0.5.1] — 2026-11-02

### Changed
- **Smoother on Android.** Scrolling no longer waits on the page: the covers and titles that follow the scroll run alongside it, and playback no longer interrupts it. The glass is drawn more lightly on Android, and the background only turns in the full-screen player. Long lists stay ready ahead of a fast fling.
- The Android app asks for the screen's fastest refresh rate, for phones that hold apps at 60 Hz by default.
- On phones, the tab bar now slides away as you scroll down and the mini player takes its place. Scroll up to bring it back.

## [0.5.0] — 2026-11-02

### Changed
- **A new look on every device.** OpenWave is redesigned around glass: the sidebar, player, tab bar, menus and dialogs float over your music, and the colours of the song playing glow through them. Lists, albums and Settings are cleaner, with Play and Shuffle buttons, inset settings groups and larger titles. The full-screen player fills the screen with the artwork's colours, the artwork settles back when paused, and it flies between the mini player and the full-screen player. Everything moves on springs. On phones, the tab bar tucks away as you scroll and returns when you scroll back, and pages have a back button.
- The Android app now draws behind the status and navigation bars, as the iPhone version does.
- **Pages come alive as you scroll.** Songs, albums and sections rise into place as they come into view, covers on album and playlist pages drift back and fade as you scroll, big titles sink into the top bar, and the colour behind the app shifts with the page. A mouse wheel on Windows and Linux now glides, and tapping the tab you're on scrolls back to the top.
- If a device asks apps to reduce motion, OpenWave uses gentle fades instead of switching animation off, and Settings → Appearance → **Full animations** turns everything on anyway.
- Settings → Appearance → **Reduce glass** swaps the see-through panels for solid ones on that device. Slower devices start with it on, and the system's Reduce Transparency setting is respected.

## [0.4.0] — 2026-11-01

### Added
- **iPhone, anywhere, with a QR code.** On the computer, Settings → Phones → **Add a phone** shows a code; scan it with the iPhone, add OpenWave to the Home Screen, and it plays from your computer at home, at work or on mobile data. No accounts, no Tailscale, no port forwarding and nothing to install. The phone and the computer find each other through public relays (end-to-end encrypted) and then talk directly over an encrypted WebRTC connection (OpenWave Connect). Songs keep playing with the screen locked, downloads play even when the computer is off, and the computer lists paired phones with a Remove button. The Mac app's Settings → Phone offers it first, with Tailscale as an alternative. Works with the Mac, Windows, Linux and Docker versions.
- Each QR code works for 15 minutes; a phone that uses it makes its own key, which never leaves the phone, so a photo of the code is useless later. A phone can't pair other phones, and "Forget" on the phone unpairs it on the computer too.
- **Tailscale in Settings → Phones** on every computer (it was only in the Mac app's own settings window): Turn on, then scan the code. Shows what's missing first: installing Tailscale, signing in, or switching on HTTPS for your account.
- **Only on this phone** (Settings → Profile on a paired phone, or a tick box when creating a profile there): the profile isn't listed on, and can't be opened from, the computer or anyone else's phone, without a PIN. Turning it on signs the profile out everywhere else. The computer's Settings → Phones shows which phone keeps whose profile; removing that phone, Forget on the phone, or a reset pairing file opens the profile again, with a note to its owner, so no profile is ever locked away.
- **Start with Windows** (Settings → Phones, in the Windows app), for a PC that's always on: OpenWave opens in the background when you sign in, so phones can play from it without anyone opening the app, and closing the OpenWave window leaves it running. Windows' own Settings → Apps → Startup lists it too, and uninstalling removes it. The Linux app has the same as **Start when you log in** (an autostart entry for the AppImage); the Mac app already has "Open OpenWave when I log in" and keeps running in the menu bar.
- **The Android app plays from your computer, anywhere:** share an Add a phone link to OpenWave (or paste it in Settings → Library → Connect to computer) and the app plays from the computer with its notification, lock-screen controls and artwork, on Wi-Fi or mobile data. **Use this phone** switches back to the app's own library, and **Play from your computer** returns to the computer later. The pairing screen in the app offers Use this phone too.

### Fixed
- When the computer can't be reached, the phone now keeps showing the message and **Try again**, and keeps trying quietly in the background. It used to fall straight back to "Connecting…", over and over.
- **A removed phone is cut off at once.** Settings → Phones → Remove now closes the phone's channel before its connection, so the phone is told straight away, and every request is checked against the paired phones, so a removed phone gets nothing even if its connection hasn't closed yet.
- A pairing link opened while the phone app is already open (shared to the Android app, or in a browser tab that has OpenWave) now pairs; it used to be ignored.
- The Android app playing from a computer checked for app updates against the computer's version instead of its own; it now compares with its own.
- Settings buttons such as Tailscale's "Turn on" no longer wrap onto two lines.
- **iPhone Home Screen app:** switching between Home, Search, Library and Downloads no longer stops the music. Safari treated each switch as leaving the page; on iPhone and iPad the app now changes screens without that, and if Safari still pauses right after a screen change, the music resumes at once.
- **iPhone Home Screen app uses the whole screen:** pages scroll behind the player and the tab bar instead of stopping above them, the empty band at the bottom is gone, and the top bar sits below the clock.
- A phone using OpenWave through Tailscale or the home Wi-Fi no longer shows the computer's own settings (Wi-Fi visibility, Phones, app updates). It shows how it's connected instead, and that Tailscale works anywhere, including on mobile data.
- Settings → About → **Copy the playback log**, to include in a report when playback misbehaves.

### Development
- The Linux build uses fixed, checksum-verified versions of appimagetool and its runtime, so an upstream re-upload can't break a release.
- `tests/test_connect.py`: pairing, offers from strangers, replays, expired codes, and real WebRTC connections through a test relay.
- `tests/ui/connect_e2e.mjs` (run in CI): the whole flow in a browser, from Add a phone on the computer to playing, reconnecting, Forget and Remove on the phone, with a layout check of every new screen. `E2E_ENGINE` runs it against a packaged app.
- The layout audit covers Settings → Phones and Add a phone (20 screens at eight sizes).
- Every app build checks that the packaged engine starts OpenWave Connect.
- `tests/test_private_profiles.py` covers who can list, open and keep a profile, over a test connection and a real WebRTC one; `connect_e2e.mjs` covers Only on this phone in the browser.
- `tests/test_startup.py` covers Start with Windows and Linux against a stand-in registry and autostart folder; the Windows and Linux builds check them for real, and changes to the launcher or packaging now build the Windows and Linux apps on every push to main. Changes to the engine or the Android app now build the Android app and run its emulator test on every push to main.
- `connect_e2e.mjs` also pairs a stand-in Android app (its own storage and native bridge).
- The website build (`scripts/build-site.py`) publishes the phone app: `/app/` from the latest release, `/app-next/` from main for testing.

## [0.3.2] — 2026-10-31

### Added
- **Shared playlists.** Invite friends and family to a playlist with a link: everyone adds, removes and reorders songs from their own OpenWave on any device, anywhere, and each song shows who added it. Changes sync within seconds, and edits made offline sync when you're back online. Only the owner can rename it, remove people (who are then locked out with a new key) or delete it for everyone; anyone else can leave. It syncs end-to-end encrypted through public Nostr relays, so OpenWave still runs no servers. Find it under a playlist's people button, and Library → Join.
- **iPhone, anywhere:** the Mac app's Settings → Phone has a new "Anywhere" option. With Tailscale (free) on the Mac and the iPhone, one click gives the iPhone a private HTTPS address for OpenWave on the Mac: it works on mobile data, downloads play offline, and only your own devices can open it.
- **Install on a Mac with one command**, with no "can't verify the developer" warning: `curl -fsSL https://saisiddharthbs.github.io/OpenWave/install.sh | bash`. It picks the Apple Silicon or Intel version by itself.
- **Stats page** on the website: downloads per app, version and day, stars and visitors. Public numbers from GitHub only; nothing is collected from the apps.

### Changed
- **Mac updates install themselves.** The app downloads the new version, checks its checksum, swaps itself and restarts, with no browser and no security warning.
- The website's Mac button no longer offers the Apple Silicon download to Intel Macs.
- A new README with fresh screenshots of every platform (including shared playlists and the Library), line icons instead of emoji on the website, and release notes without emoji.
- A security policy, code of conduct, pull request template and clearer issue forms.
- OpenWave now describes itself consistently as an open-source, non-commercial music player in the app, website, README and release notes, with a clearer note on legal and responsible use.

### Fixed
- **Long song names on phones:** a long title or artist list no longer pushes the artwork, the end time and the controls of the Now Playing screen (and its Up next and Lyrics sheets) off the right edge, and no longer makes Search results wider than the screen. Titles are shortened with "…" instead. Fixed at the root: no one-column layout can grow wider than the screen any more.
- Very long unbroken words in album, artist and playlist headers now wrap instead of widening the header.
- Notices in the app were squeezed into half the screen width on phones; they now use the full width.
- A change the engine refuses no longer blocks every later library change on that device.

### Development
- **Layout audit** (`tests/ui/layout_audit.mjs`, run in CI on every push): opens 19 screens at eight sizes, from a 320 px phone to a desktop, with real-world and extremely long names, and fails if anything goes past the edge of the screen or a screen fails to open.
- Shared-playlist tests: encryption, signatures (BIP-340 test vectors), merging, permissions, and three engines syncing through a private relay (`tests/test_shared.py`).

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
