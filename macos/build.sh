#!/usr/bin/env bash
# Builds OpenWave.app and OpenWave-macOS-<AppleSilicon|Intel>.dmg into macos/dist/.
#
#   ./macos/build.sh            # uses ../.venv if present, else python3
#
# Needs: Xcode command-line tools (swift) and Python 3.11+ (or `uv`, which fetches Python 3.12 for you).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DIST="$HERE/dist"
WORK="$HERE/.build-app"
DENO_VERSION="${DENO_VERSION:-2.9.7}"
ARCH="$(uname -m)"                       # x86_64 or arm64
DENO_ARCH="$ARCH"; [ "$ARCH" = "arm64" ] && DENO_ARCH="aarch64"
BUILD_VENV="$HERE/.venv-build"
if [ ! -x "$BUILD_VENV/bin/python" ]; then
  if command -v uv >/dev/null; then uv venv -q --python 3.12 "$BUILD_VENV"; else python3 -m venv "$BUILD_VENV"; fi
fi
PY="$BUILD_VENV/bin/python"
pip_install() {
  if command -v uv >/dev/null; then uv pip install -q --python "$PY" "$@"; else "$PY" -m pip install -q "$@"; fi
}
VERSION="$("$PY" -c 'import sys; sys.path.insert(0, "'"$ROOT"'"); import openwave; print(openwave.__version__)')"

echo "▸ OpenWave $VERSION for $ARCH"
rm -rf "$WORK" "$DIST/OpenWave.app"
mkdir -p "$WORK" "$DIST"

echo "▸ Freezing the engine (PyInstaller)"
rm -rf "$ROOT/build"  # setuptools reuses stale copies from here
pip_install --upgrade "$ROOT" pyinstaller "yt-dlp[default]" ytmusicapi
"$PY" -m PyInstaller --noconfirm --clean --log-level WARN \
  --name openwave-server --onedir \
  --distpath "$WORK/pyi-dist" --workpath "$WORK/pyi-work" --specpath "$WORK" \
  --add-data "$ROOT/openwave/web:openwave/web" \
  --collect-all yt_dlp_ejs --collect-data ytmusicapi --collect-submodules yt_dlp \
  --collect-submodules uvicorn --hidden-import openwave.desktop \
  "$HERE/server_entry.py"

echo "▸ Fetching Deno $DENO_VERSION (JavaScript runtime for YouTube's player challenges)"
DENO_ZIP="$WORK/deno.zip"
curl -fsSL "https://github.com/denoland/deno/releases/download/v$DENO_VERSION/deno-$DENO_ARCH-apple-darwin.zip" -o "$DENO_ZIP"
unzip -q -o "$DENO_ZIP" -d "$WORK/deno"

echo "▸ Building the Swift app"
(cd "$HERE" && swift build -c release --product OpenWave)
BIN="$(cd "$HERE" && swift build -c release --show-bin-path)/OpenWave"

echo "▸ Assembling OpenWave.app"
APP="$DIST/OpenWave.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bin"
cp "$BIN" "$APP/Contents/MacOS/OpenWave"
sed "s/__VERSION__/$VERSION/g" "$HERE/Info.plist" > "$APP/Contents/Info.plist"
cp -R "$WORK/pyi-dist/openwave-server" "$APP/Contents/Resources/server"
cp "$WORK/deno/deno" "$APP/Contents/Resources/bin/deno"
cp "$ROOT/openwave/web/icons/logo-mark-128.png" "$APP/Contents/Resources/logo-mark.png"
cp "$HERE"/Resources/MenuBarIcon*.png "$APP/Contents/Resources/"

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icon-macos-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$ROOT/assets/icon-macos-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

# Signing: a Developer ID + notarisation makes OpenWave open with no warnings on every Mac.
# Without one (local builds, forks) the app is ad-hoc signed and users confirm it once.
#   DEVELOPER_ID="Developer ID Application: Your Name (TEAMID)"
#   APPLE_ID=you@example.com APPLE_TEAM_ID=TEAMID APPLE_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx  (app-specific password)
SIGN_ID="${DEVELOPER_ID:--}"
SIGN_FLAGS=(--force --sign "$SIGN_ID")
if [ "$SIGN_ID" != "-" ]; then
  echo "▸ Signing with $SIGN_ID (hardened runtime)"
  SIGN_FLAGS+=(--options runtime --timestamp --entitlements "$HERE/entitlements.plist")
else
  echo "▸ Signing (ad-hoc)"
  SIGN_FLAGS+=(--timestamp=none)
fi
# Inside-out: every embedded binary, then the main executable, then the bundle.
find "$APP/Contents/Resources" -type f \( -perm -u+x -o -name "*.so" -o -name "*.dylib" \) -print0 \
  | xargs -0 -n 50 codesign "${SIGN_FLAGS[@]}" 2>/dev/null || true
codesign "${SIGN_FLAGS[@]}" "$APP/Contents/MacOS/OpenWave"
codesign "${SIGN_FLAGS[@]}" "$APP"
codesign --verify --deep --strict "$APP" && echo "  signature ok"

echo "▸ Creating disk image"
case "$ARCH" in arm64) LABEL="AppleSilicon" ;; *) LABEL="Intel" ;; esac
DMG="$DIST/OpenWave-macOS-$LABEL.dmg"
STAGE="$WORK/dmg"
RW="$WORK/rw.dmg"
mkdir -p "$STAGE/.background"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cp "$HERE/Resources/dmg-background.tiff" "$STAGE/.background/background.tiff"

# hdiutil sometimes fails for no lasting reason ("resource busy"), especially on CI machines,
# so each attempt cleans up after itself and the whole step is retried.
make_dmg() {
  local mount volname
  rm -f "$RW" "$DMG"
  hdiutil create -volname "OpenWave" -srcfolder "$STAGE" -fs HFS+ -format UDRW -ov "$RW" >/dev/null || { echo "  hdiutil create failed"; return 1; }
  mount="$(hdiutil attach -readwrite -noverify -noautoopen "$RW" | awk -F'\t' '/\/Volumes\// {print $NF}')" || true
  [ -n "$mount" ] || { echo "  hdiutil attach failed"; return 1; }
  volname="$(basename "$mount")"
  # Lay out the Finder window (best effort: needs a logged-in Finder, skipped silently on headless CI).
  perl -e 'alarm 60; exec @ARGV' osascript <<APPLESCRIPT >/dev/null 2>&1 || echo "  (Finder layout skipped: allow Terminal to control Finder to get the styled window)"
tell application "Finder"
  tell disk "$volname"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {200, 120, 860, 560}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 112
    set text size of opts to 13
    set background picture of opts to file ".background:background.tiff"
    set position of item "OpenWave.app" of container window to {170, 200}
    set position of item "Applications" of container window to {490, 200}
    update without registering applications
    delay 1
    close
  end tell
end tell
APPLESCRIPT
  SetFile -a C "$mount" 2>/dev/null || true
  sync
  hdiutil detach "$mount" -quiet || hdiutil detach "$mount" -force -quiet || { echo "  hdiutil detach failed"; return 1; }
  hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -o "$DMG" >/dev/null || { echo "  hdiutil convert failed"; return 1; }
  rm -f "$RW"
  hdiutil verify "$DMG" >/dev/null 2>&1 || { echo "  the disk image didn't verify"; return 1; }
}
for attempt in 1 2 3; do
  if make_dmg; then break; fi
  [ "$attempt" = 3 ] && { echo "✗ Couldn't create the disk image after 3 attempts" >&2; exit 1; }
  echo "  retrying in $((attempt * 10)) s"
  for v in /Volumes/OpenWave*; do [ -d "$v" ] && hdiutil detach "$v" -force -quiet 2>/dev/null; done
  sleep $((attempt * 10))
done

if [ "$SIGN_ID" != "-" ] && [ -n "${APPLE_ID:-}" ]; then
  echo "▸ Notarising with Apple (a few minutes)"
  codesign --sign "$SIGN_ID" --timestamp "$DMG"
  xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler staple "$APP"
fi

du -sh "$APP" "$DMG"
echo "✓ Done: $DMG"
