#!/usr/bin/env bash
# Releases a new version of OpenWave in one command:   ./scripts/release.sh 0.3.1
#
#  1. checks you're on an up-to-date, clean main branch
#  2. turns CHANGELOG.md's "Unreleased" notes into the new version's section
#  3. sets the version in openwave/__init__.py and pyproject.toml
#  4. runs the tests
#  5. commits, tags v0.3.1 and pushes
#
# GitHub then builds the Mac, Windows, Linux and Android apps and the Docker image, and publishes
# the release with every file and its notes (.github/workflows/publish.yml). Takes about 25 minutes.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-}"
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Usage: ./scripts/release.sh 0.3.1"; exit 1; }
TAG="v$VERSION"
REPO_URL="https://github.com/SaiSiddharthBS/OpenWave"

say() { printf '\n▸ %s\n' "$*"; }
die() { printf '\n✗ %s\n' "$*" >&2; exit 1; }

say "Checking the repository"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "Switch to the main branch first (git checkout main)."
[ -z "$(git status --porcelain)" ] || die "You have uncommitted changes. Commit or stash them first."
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "main isn't in sync with GitHub. Run: git pull"
! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || die "$TAG already exists."

say "Changelog"
python3 - "$VERSION" <<'EOF'
import datetime, re, sys
version = sys.argv[1]
path = "CHANGELOG.md"
text = open(path, encoding="utf-8").read()
if re.search(rf"^## \[{re.escape(version)}\]", text, re.M):
    print(f"  CHANGELOG.md already has a section for {version}")
    sys.exit(0)
m = re.search(r"^## \[Unreleased\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
if not m or not m.group(1).strip():
    sys.exit(f"  Write what changed under '## [Unreleased]' in CHANGELOG.md first, then run this again.")
today = datetime.date.today().isoformat()
text = text[:m.start()] + f"## [Unreleased]\n\n## [{version}] — {today}\n\n{m.group(1).strip()}\n\n" + text[m.end():]
open(path, "w", encoding="utf-8").write(text)
print(f"  'Unreleased' is now {version} ({today})")
EOF

say "Version $VERSION"
python3 - "$VERSION" <<'EOF'
import re, sys
v = sys.argv[1]
for path, pattern, repl in [("openwave/__init__.py", r'__version__ = "[^"]+"', f'__version__ = "{v}"'),
                            ("pyproject.toml", r'(?m)^version = "[^"]+"', f'version = "{v}"')]:
    text = open(path, encoding="utf-8").read()
    new, n = re.subn(pattern, repl, text, count=1)
    if n != 1:
        sys.exit(f"  couldn't find the version in {path}")
    open(path, "w", encoding="utf-8").write(new)
EOF

say "Running the tests"
PY=python3; [ -x .venv/bin/python ] && PY=.venv/bin/python
PYTHONPATH="$PWD" "$PY" -m pytest -q || die "Tests failed, so nothing was released. Your version/changelog edits are still there to fix up."

say "Committing and tagging $TAG"
git add CHANGELOG.md openwave/__init__.py pyproject.toml
git diff --cached --quiet || git commit -q -m "Release $VERSION"
git tag -a "$TAG" -m "OpenWave $VERSION"
git push -q origin main
git push -q origin "$TAG"

cat <<EOF

✓ $TAG is on its way.
  GitHub is now building every app. In about 25 minutes the release appears at
  $REPO_URL/releases/tag/$TAG
  Follow the builds at $REPO_URL/actions
EOF
