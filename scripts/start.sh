#!/usr/bin/env bash
# One-command launcher for macOS / Linux: creates a virtualenv on first run,
# keeps the YouTube libraries up to date (YouTube changes often), then starts OpenWave.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=${PYTHON:-python3}
if [ ! -d .venv ]; then
  echo "Setting up OpenWave (first run only)…"
  "$PY" -m venv .venv
  .venv/bin/pip install -q --upgrade pip
  .venv/bin/pip install -q -e .
fi
echo "Checking for yt-dlp / ytmusicapi updates…"
.venv/bin/pip install -q --upgrade "yt-dlp[default]" ytmusicapi || echo "(update check failed — continuing with installed versions)"

if ! command -v deno >/dev/null && ! command -v node >/dev/null && ! command -v bun >/dev/null; then
  echo "WARNING: no JavaScript runtime found. Install Deno (https://deno.com) or Node.js 20+, or playback will fail."
fi
exec .venv/bin/python -m openwave "$@"
