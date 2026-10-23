@echo off
rem One-command launcher for Windows: sets up a virtualenv on first run,
rem keeps the YouTube libraries up to date, then starts OpenWave.
cd /d "%~dp0\.."
if not exist .venv (
  echo Setting up OpenWave ^(first run only^)...
  py -3 -m venv .venv || python -m venv .venv
  .venv\Scripts\python -m pip install -q --upgrade pip
  .venv\Scripts\python -m pip install -q -e .
)
echo Checking for yt-dlp / ytmusicapi updates...
.venv\Scripts\python -m pip install -q --upgrade "yt-dlp[default]" ytmusicapi
where deno >nul 2>nul || where node >nul 2>nul || echo WARNING: install Deno ^(https://deno.com^) or Node.js 20+ or playback will fail.
.venv\Scripts\python -m openwave %*
