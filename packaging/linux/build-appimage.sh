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
Comment=Open-source music player
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
# Fixed versions, checked against their checksums: the "continuous" downloads are replaced now and
# then, which fails any build that lands in the gap.
fetch() {  # url, file, sha256
  [ -f "$2" ] && echo "$3  $2" | sha256sum -c --status && return 0
  curl -fsSL --retry 5 --retry-delay 5 --retry-all-errors -o "$2" "$1"
  echo "$3  $2" | sha256sum -c --status || { echo "Checksum mismatch for $1" >&2; exit 1; }
}
TOOL="$ROOT/dist/appimagetool"
RUNTIME="$ROOT/dist/appimage-runtime"
fetch https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage "$TOOL" ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0
fetch https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64 "$RUNTIME" 2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d
chmod +x "$TOOL"
ARCH=x86_64 "$TOOL" --appimage-extract-and-run --runtime-file "$RUNTIME" "$APPDIR" "$ROOT/dist/OpenWave-Linux-x86_64.AppImage"
