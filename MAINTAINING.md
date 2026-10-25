# Maintaining OpenWave

Everything a maintainer does, in plain steps.

## Release a new version

1. As you work, add a line for each change under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md).
2. Run:

   ```bash
   ./scripts/release.sh 0.3.1
   ```

That's all. The script checks everything is committed and synced, turns "Unreleased" into the
new version, runs the tests, and pushes the tag. GitHub then builds the Mac, Windows, Linux and
Android apps and the Docker image, and publishes **one complete release** with every file,
checksums and notes (about 25 minutes). Follow it under **Actions → Release**.

Every OpenWave app then tells its users about the update and downloads it in one tap.

Want hand-written release notes instead of the changelog? Put them in `docs/releases/v0.3.1.md`
before releasing (see `v0.3.0.md`; `__SUMS__` becomes the checksums).

## One-time setup: Android signing

Android only installs an update if it's signed with the same key as the installed app. The key
lives on your Mac in `~/.openwave/android/`. **Back up that folder** (a password manager or an
encrypted drive). If it's lost, nobody can update their installed app.

To let GitHub sign the Android app, run this once:

```bash
uv run --with pynacl scripts/setup_android_signing.py
```

Until then, releases are saved as a **draft** without the Android app. Upload a signed
`OpenWave-Android.apk` and press **Publish** on the release page. To build one on your Mac:
`cd android && ./gradlew assembleRelease`. It's written to
`android/app/build/outputs/apk/release/app-release.apk`.

## Where things are

| What | Where |
|---|---|
| Engine (search, streaming, library) | `openwave/` (Python) |
| App screens | `openwave/web/` (shared by every platform) |
| Mac app | `macos/` · Android app: `android/` · Windows/Linux: `packaging/` |
| Website | `site/` (updates itself when you push to main) |
| Builds and releases | `.github/workflows/` (`publish.yml` makes releases) |

## How many people download OpenWave

The [Stats page](https://saisiddharthbs.github.io/OpenWave/stats.html) shows downloads per app and
per version, downloads per day, stars and visitors. The totals come live from GitHub; the daily
history is saved once a day by `.github/workflows/stats.yml` to the `stats` branch (run it by hand
from the Actions tab any time). Nothing is collected from the apps.

**Optional, visitors to the GitHub page:** GitHub only shows traffic to people who can change the
repository, so the workflow needs a read-only token for it, and only you can create one. Run:

```bash
uv run --with pynacl,certifi scripts/setup_stats_token.py
```

It opens GitHub's token page already filled in (choose "Only select repositories" → OpenWave, then
"Generate token"), checks the token you paste and saves it as the `STATS_TOKEN` secret. The token
expires after a year; run the script again then.

From the next daily run, the page also shows visitors per day, and keeps them for longer than the
two weeks GitHub remembers.

## Checking things

```bash
.venv/bin/python -m pytest -q        # engine tests
./scripts/start.sh                   # run OpenWave from source at http://localhost:8787
```

Pull requests run the tests and build the Mac and Android apps (the Android app is also tested on
an emulator) before you merge.
