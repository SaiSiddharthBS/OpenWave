#!/bin/bash
# Installs or updates OpenWave on a Mac, with no "can't verify the developer" warning:
#
#   curl -fsSL https://saisiddharthbs.github.io/OpenWave/install.sh | bash
#
# It downloads the right app for this Mac (Apple Silicon or Intel) from the latest GitHub release,
# checks it against the release's SHA-256 checksum, and copies it into Applications. macOS only
# shows its warning for apps downloaded by a browser, so this way OpenWave simply opens.
# Your profiles and library are kept: they live in ~/Library/Application Support/OpenWave.
set -euo pipefail

REPO="SaiSiddharthBS/OpenWave"
say() { printf '\033[1m%s\033[0m\n' "$*"; }

[ "$(uname -s)" = "Darwin" ] || { echo "This installer is for Macs. For other devices, see https://saisiddharthbs.github.io/OpenWave/"; exit 1; }

# hw.optional.arm64 is 1 on Apple Silicon even inside a Rosetta (Intel) Terminal.
if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
  FILE="OpenWave-macOS-AppleSilicon.dmg"; KIND="Apple Silicon"
else
  FILE="OpenWave-macOS-Intel.dmg"; KIND="Intel"
fi
URL="https://github.com/$REPO/releases/latest/download/$FILE"

TMP="$(mktemp -d)"
MNT="$TMP/mount"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

say "Downloading OpenWave for $KIND Macs…"
curl -fL --progress-bar -o "$TMP/$FILE" "$URL"
curl -fsSL -o "$TMP/$FILE.sha256" "$URL.sha256"
(cd "$TMP" && shasum -a 256 -c "$FILE.sha256" >/dev/null) || { echo "The download didn't match its checksum. Please try again."; exit 1; }

say "Installing…"
mkdir -p "$MNT"
hdiutil attach -nobrowse -noautoopen -quiet -mountpoint "$MNT" "$TMP/$FILE"
if [ -w /Applications ]; then DEST="/Applications/OpenWave.app"; else mkdir -p "$HOME/Applications"; DEST="$HOME/Applications/OpenWave.app"; fi
if pgrep -xq OpenWave; then
  osascript -e 'quit app "OpenWave"' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do pgrep -xq OpenWave || break; sleep 0.5; done
fi
rm -rf "$DEST"
ditto "$MNT/OpenWave.app" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

say "✓ OpenWave is installed in ${DEST%/OpenWave.app}. Opening it now."
open "$DEST"
