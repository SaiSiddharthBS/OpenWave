"""Writes the GitHub release notes for a version: python scripts/release_notes.py 0.3.1 [SHA256SUMS.txt]

Uses docs/releases/v<version>.md when it exists (a hand-written page; "__SUMS__" is replaced by the
checksums). Otherwise builds the page from the download table below and the version's CHANGELOG.md
section, so a normal release needs nothing but a changelog entry.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPO = "SaiSiddharthBS/OpenWave"

TEMPLATE = """<p align="center"><img src="https://raw.githubusercontent.com/{repo}/v{v}/docs/logo.png" width="200" alt="OpenWave"></p>

<h3 align="center">One music app. Every device you own.</h3>
<p align="center">Open-source, non-commercial software under the GPL-3.0, with no accounts and no tracking.</p>

## Download

| Your device | Download | First launch (once) |
|---|---|---|
| **Android** 7+ (64-bit) | [**OpenWave-Android.apk**]({dl}/OpenWave-Android.apk) | Open the file → allow **Install unknown apps** → **Install** |
| **Mac** (any) | `curl -fsSL https://saisiddharthbs.github.io/OpenWave/install.sh \| bash` in Terminal | Picks Apple Silicon or Intel and opens with no security prompt |
| **Mac** with Apple Silicon (M1 and later) | [**OpenWave-macOS-AppleSilicon.dmg**]({dl}/OpenWave-macOS-AppleSilicon.dmg) | Open the app, then **System Settings → Privacy & Security → Open Anyway** |
| **Mac** with Intel | [**OpenWave-macOS-Intel.dmg**]({dl}/OpenWave-macOS-Intel.dmg) | Same as above |
| **Windows** 10 / 11 | [**OpenWave-Windows-Setup.exe**]({dl}/OpenWave-Windows-Setup.exe) | "Windows protected your PC" → **More info → Run anyway** |
| **Linux** (x86-64) | [**OpenWave-Linux-x86_64.AppImage**]({dl}/OpenWave-Linux-x86_64.AppImage) | `chmod +x` the file, then double-click |
| **Home server** | `docker run -d -p 8787:8787 -v openwave:/data ghcr.io/{repo_lower}:{v}` | Open `http://<server>:8787` |

Already using OpenWave? The app tells you about this update and downloads it in one tap. Your library stays as it is.

## What's new

{changes}

Full details are in [CHANGELOG.md](https://github.com/{repo}/blob/v{v}/CHANGELOG.md).

## Verify your download

SHA-256 checksums (also attached as `SHA256SUMS.txt`):

```
__SUMS__
```

---

**OpenWave is free and open source (GPL-3.0).** If you find it useful, star the repo and [report anything that breaks](https://github.com/{repo}/issues/new/choose).
<sub>OpenWave is an independent, non-commercial project, not affiliated with YouTube, Google, Spotify or any record label. It hosts no content. Please support the artists you listen to through official channels.</sub>
"""


def changelog_section(version: str) -> str:
    text = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    m = re.search(rf"^## \[{re.escape(version)}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
    if not m:
        sys.exit(f"CHANGELOG.md has no section for {version}")
    return m.group(1).strip()  # its "### Added" headings sit under "## What's new"


def notes(version: str, sums: str = "") -> str:
    custom = ROOT / "docs" / "releases" / f"v{version}.md"
    if custom.exists():
        body = custom.read_text(encoding="utf-8")
    else:
        body = TEMPLATE.format(
            repo=REPO, repo_lower=REPO.lower(), v=version,
            dl=f"https://github.com/{REPO}/releases/download/v{version}",
            changes=changelog_section(version),
        )
    return body.replace("__SUMS__", sums.strip() or "(checksums are attached to the release)")


if __name__ == "__main__":
    version = sys.argv[1].lstrip("v")
    sums = Path(sys.argv[2]).read_text(encoding="utf-8") if len(sys.argv) > 2 else ""
    sys.stdout.write(notes(version, sums))
