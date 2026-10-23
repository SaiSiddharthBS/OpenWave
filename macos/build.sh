#!/usr/bin/env bash
# Builds OpenWave.app and OpenWave-<version>-<arch>.dmg into macos/dist/.
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

ICONSET="$WORK/AppIcon.iconset"
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ROOT/assets/icon-macos-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$ROOT/assets/icon-macos-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "▸ Signing (ad-hoc)"
# Sign inside-out: every embedded binary, then the bundle.
find "$APP/Contents/Resources" -type f \( -perm -u+x -o -name "*.so" -o -name "*.dylib" \) -print0 | xargs -0 codesign --force --sign - --timestamp=none 2>/dev/null || true
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/OpenWave"
codesign --force --sign - --timestamp=none "$APP"
codesign --verify --deep --strict "$APP" && echo "  signature ok"

echo "▸ Creating disk image"
DMG="$DIST/OpenWave-$VERSION-macOS-$ARCH.dmg"
STAGE="$WORK/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "OpenWave $VERSION" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null

du -sh "$APP" "$DMG"
echo "✓ Done: $DMG"
