# Contributing to OpenWave

Thanks for helping keep music free and open! Every kind of contribution helps: bug reports, translations, design, docs and code.

## Ground rules

- **Free forever.** OpenWave will never have ads, paid tiers, accounts or tracking. PRs that add any of these won't be merged.
- **Privacy first.** User data (library, history, downloads) stays on the user's device. The server stores nothing about people.
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
| `openwave/web/js/player.js` | Playback engine: queue, shuffle/repeat, radio, video mode, media session |
| `openwave/web/js/offline.js` | Offline downloads in IndexedDB |
| `openwave/web/js/views.js` | Page rendering |
| `openwave/web/js/app.js` | Router, event handling, player UI bindings |

## Pull requests

1. Open an issue first for anything big, so we can agree on the approach.
2. Keep PRs focused; add or update tests in `tests/` for server changes.
3. `pytest` must pass. For UI changes, include a screenshot (desktop + phone width).

## Good first issues

- Translations / i18n of UI strings
- Sleep timer, crossfade, equalizer
- Drag-to-reorder in the queue and playlists
- Import playlists from other services (CSV / Spotify export)
- Native wrappers (Capacitor for Android/iOS, Tauri for desktop)
