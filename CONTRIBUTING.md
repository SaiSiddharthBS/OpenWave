# Contributing to OpenWave

Thank you for helping keep music free and open. Every kind of contribution helps: bug reports, translations, design, documentation and code. By taking part, you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ground rules

- **Non-commercial, forever.** OpenWave will never be monetised: no ads, paid tiers, accounts or tracking. PRs that add any of these won't be merged.
- **No content, no circumvention.** OpenWave never hosts or redistributes music, and contributions must not break DRM or other technical protection measures.
- **Privacy first.** Libraries live only on the server the user runs (and downloads only on their device). No analytics, no third-party calls from the client, nothing phones home. The one exception is opt-in: shared playlists sync end-to-end encrypted through public Nostr relays, and only once a user shares or joins one.
- **No YouTube/Google branding.** Don't add their logos, names in the app title, or look-alike trademarks.
- **Be kind.** Treat everyone with respect in issues and reviews.
- **Security issues** go to the maintainer privately, not to public issues. See [SECURITY.md](SECURITY.md).

## Getting started

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m openwave --no-browser     # http://localhost:8787
.venv/bin/pytest
```

The frontend in `openwave/web/` is plain HTML/CSS/ES modules with no build step: edit and reload.
If you change files the service worker caches, bump `VERSION` in `openwave/web/sw.js`.

`node tests/ui/behaviour.mjs` does what a person does and checks what a layout check can't see: search
suggestions that stay, the player closing into the mini player, update cards and notifications.

`node tests/ui/motion_audit.mjs` scrolls and flings on a phone-sized window with the processor slowed
down, prints how much work each one gave the page, and fails if the bars at the bottom of the screen
animate anything but transforms and opacity. Keep animations to those two: anything else redoes the
page's layout or repaints it on every frame, and that's what makes a phone stutter. `MOTION_WHY=1`
shows what caused the work.

`node tests/ui/layout_audit.mjs` (Node 22+ and Chrome) opens every screen at thirteen sizes, from a
320 px phone to a desktop, with real-world and very long song, artist and playlist names, and fails
if anything is pushed past the edge of the screen. CI runs it on every push, together with
`node tests/ui/connect_e2e.mjs`, which pairs a phone-sized browser with an engine through a test
relay and goes through Connect end to end.

## Where things live

| Path | What |
|---|---|
| `openwave/music.py` | Catalog (search, albums, artists, lyrics) via ytmusicapi, normalised into `track` / `card` shapes |
| `openwave/youtube.py` | Stream resolution via yt-dlp, caching, fast-client → robust-client fallback |
| `openwave/app.py` | HTTP API, byte-range audio proxy, image proxy, full-file download endpoint, song-version lookup |
| `openwave/library.py` · `api_library.py` | Profiles, PINs and the per-profile library in SQLite (ops-based sync), insights, mixes, personal radio |
| `openwave/importer.py` | Spotify / CSV / text playlist parsing and YouTube Music matching |
| `openwave/updater.py` · `desktop.py` | Packaged-app entry point and background yt-dlp / ytmusicapi updates |
| `openwave/link.py` | Devices on the same Wi-Fi: UDP discovery, the LAN listener, pairing, remote control and listening sessions |
| `openwave/releases.py` | In-app update checks (`/api/app-update`) |
| `openwave/connect.py` · `api_connect.py` | OpenWave Connect: phones away from home pair by QR code, meet through Nostr relays and talk over WebRTC (vendored aiortc in `openwave/_vendor/`, refreshed with `scripts/vendor-aiortc.sh`) |
| `openwave/web/js/remote.js` · `connect.js` · `phones.js` | The phone side of Connect (the website's copy of the app), and Settings → Phones |
| `openwave/web/js/store.js` | Client library cache + offline outbox that syncs to `/api/me/ops` |
| `openwave/web/js/profiles.js` · `insights.js` · `importer.js` · `native.js` | Profile picker, insights + share card, import dialog, Mac app bridge |
| `android/` | Android app (Kotlin): runs the engine on the phone via Chaquopy, WebView UI, media notification / lock screen / Bluetooth controls, audio focus |
| `macos/` | Native macOS app (Swift: AppKit window, SwiftUI menu-bar player & settings, media keys, Now Playing) and `build.sh` |
| `openwave/web/js/player.js` | Playback engine: two-deck gapless/crossfade, queue, radio, sleep timer, song-version swapping, media session |
| `openwave/web/js/offline.js` | Offline downloads in IndexedDB |
| `openwave/web/js/views.js` | Page rendering |
| `openwave/web/js/app.js` | Router, event handling, player UI bindings |
| `openwave/web/js/link.js` | Devices menu, remote control and listen-together sync in the browser |
| `openwave/web/js/gestures.js` · `update.js` | Touch gestures; the update card |
| `site/` · `scripts/build-site.py` | Website, the Mac installer script (`install.sh`) and the Stats page; the build adds the phone app under `/app/` |

## The Mac app

```bash
cd macos && swift build                      # compile the Swift shell
OPENWAVE_DEV_URL=http://localhost:8787 .build/debug/OpenWave   # run it against your dev server
./macos/build.sh                             # full .app + .dmg (bundles the engine and Deno)
```

## The Android app

```bash
cd android && ./gradlew assembleDebug    # needs the Android SDK, JDK 17+, and python3.12 on PATH
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

The engine is copied in from `openwave/` at build time. On the phone it runs FastAPI 0.99 with pydantic 1.x,
because pydantic 2's Rust core has no Android build. Keep server code compatible with both
(CI runs the test suite against the desktop versions; `tests/` also passes on the Android set).

## Pull requests

1. Open an issue first for anything big, so we can agree on the approach.
2. Keep PRs focused; add or update tests in `tests/` for server changes.
3. `pytest` must pass. For UI changes, `node tests/ui/layout_audit.mjs` must pass too, and include a screenshot (desktop + phone width). For changes to OpenWave Connect (phones away from home), `node tests/ui/connect_e2e.mjs` must pass.

## Releases

Maintainers release with one command (`./scripts/release.sh 0.3.1`). See [MAINTAINING.md](MAINTAINING.md).
Contributors: add your change under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).

## Good first issues

- Translations of the interface
- Equaliser and loudness normalisation
- Listen together over the internet (today it works on the same Wi-Fi)
- Touch drag-to-reorder on phones
- Packaging for F-Droid / IzzyOnDroid
