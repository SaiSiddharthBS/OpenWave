#!/bin/bash
# Refreshes openwave/_vendor/aiortc from PyPI. OpenWave Connect only uses aiortc's data channels;
# vendoring it (pure Python, BSD-3-Clause) avoids its dependency on PyAV/FFmpeg (~60 MB), which
# audio and video calls need and OpenWave doesn't. Usage: scripts/vendor-aiortc.sh 1.15.0
set -euo pipefail
VERSION="${1:?usage: $0 VERSION}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/openwave/_vendor/aiortc"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
python3 -m pip download -q --no-deps --only-binary :all: -d "$TMP" "aiortc==$VERSION"
python3 -m zipfile -e "$TMP"/aiortc-"$VERSION"-*.whl "$TMP/x"
rm -rf "$DEST"
cp -R "$TMP/x/aiortc" "$DEST"
rm -rf "$DEST/contrib" "$DEST/py.typed"
find "$DEST" -name __pycache__ -prune -exec rm -rf {} +
cp "$TMP"/x/aiortc-"$VERSION".dist-info/licenses/LICENSE "$DEST/LICENSE"
# The one absolute self-import; everything else is relative.
sed -i.bak 's/^from aiortc\.utils import/from .utils import/' "$DEST/rate.py" && rm "$DEST/rate.py.bak"
if grep -rn "^\s*\(from\|import\) aiortc" "$DEST"; then echo "absolute aiortc import left in the vendored copy" >&2; exit 1; fi
echo "$VERSION" > "$DEST/VERSION"
echo "Vendored aiortc $VERSION into openwave/_vendor/aiortc"
