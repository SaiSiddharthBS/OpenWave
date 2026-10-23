#!/usr/bin/env bash
# Wraps the PyInstaller build in dist/OpenWave into dist/OpenWave-Linux-x86_64.AppImage.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
APPDIR="$ROOT/dist/OpenWave.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/lib"
cp -R "$ROOT/dist/OpenWave" "$APPDIR/usr/lib/openwave"
cp "$ROOT/packaging/linux/openwave.png" "$APPDIR/openwave.png"
cat > "$APPDIR/openwave.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=OpenWave
Comment=Free, open-source music for everyone
Exec=OpenWave
Icon=openwave
Categories=AudioVideo;Audio;Player;
Terminal=false
DESKTOP
cat > "$APPDIR/AppRun" <<'APPRUN'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/lib/openwave/OpenWave" "$@"
APPRUN
chmod +x "$APPDIR/AppRun"
TOOL="$ROOT/dist/appimagetool"
[ -x "$TOOL" ] || { curl -fsSL -o "$TOOL" https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage; chmod +x "$TOOL"; }
ARCH=x86_64 "$TOOL" --appimage-extract-and-run "$APPDIR" "$ROOT/dist/OpenWave-Linux-x86_64.AppImage"
