# Contributing to OpenWave

Thanks for helping keep music free and open! Every kind of contribution helps: bug reports, translations, design, docs and code.

## Ground rules

- **Free forever.** OpenWave will never have ads, paid tiers, accounts or tracking. PRs that add any of these won't be merged.
- **Privacy first.** Libraries live only on the server the user runs (and downloads only on their device). No analytics, no third-party calls from the client, nothing phones home.
- **No YouTube/Google branding.** Don't add their logos, names in the app title, or look-alike trademarks.
- **Be kind.** Treat everyone with respect in issues and reviews.

## Getting started

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m openwave --no-browser     # http://localhost:8787
.venv/bin/pytest
```

The frontend in `openwave/web/` is plain HTML/CSS/ES modules with no build step: edit and reload.
If you change files the service worker caches, bump `VERSION` in `openwave/web/sw.js`.

## Where things live

| Path | What |
|---|---|
| `openwave/music.py` | Catalog (search, albums, artists, lyrics) via ytmusicapi, normalised into `track` / `card` shapes |
| `openwave/youtube.py` | Stream resolution via yt-dlp, caching, fast-client → robust-client fallback |
| `openwave/app.py` | HTTP API, byte-range stream proxy, HLS + image proxies, full-file download endpoint |
| `openwave/library.py` · `api_library.py` | Profiles, PINs and the per-profile library in SQLite (ops-based sync), insights, mixes, personal radio |
| `openwave/importer.py` | Spotify / CSV / text playlist parsing and YouTube Music matching |
| `openwave/updater.py` · `desktop.py` | Packaged-app entry point and background yt-dlp / ytmusicapi updates |
| `openwave/web/js/store.js` | Client library cache + offline outbox that syncs to `/api/me/ops` |
| `openwave/web/js/profiles.js` · `insights.js` · `importer.js` · `native.js` | Profile picker, insights + share card, import dialog, Mac app bridge |
| `macos/` | Native macOS app (Swift: AppKit window, SwiftUI menu-bar player & settings, media keys, Now Playing) and `build.sh` |
| `openwave/web/js/player.js` | Playback engine: two-deck gapless/crossfade, queue, radio, sleep timer, video mode, media session |
| `openwave/web/js/offline.js` | Offline downloads in IndexedDB |
| `openwave/web/js/views.js` | Page rendering |
| `openwave/web/js/app.js` | Router, event handling, player UI bindings |

## The Mac app

```bash
cd macos && swift build                      # compile the Swift shell
OPENWAVE_DEV_URL=http://localhost:8787 .build/debug/OpenWave   # run it against your dev server
./macos/build.sh                             # full .app + .dmg (bundles the engine and Deno)
```

## Pull requests

1. Open an issue first for anything big, so we can agree on the approach.
2. Keep PRs focused; add or update tests in `tests/` for server changes.
3. `pytest` must pass. For UI changes, include a screenshot (desktop + phone width).

## Good first issues

- Translations / i18n of UI strings
- Equalizer and loudness normalisation
- Windows desktop shell (port of `macos/`)
- Native wrappers for Android / iOS
- Touch drag-to-reorder on phones
- Translations
