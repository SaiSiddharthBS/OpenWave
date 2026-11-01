#!/usr/bin/env python3
"""Assembles the OpenWave website (GitHub Pages) into OUT.

Besides the pages in site/, it publishes the web app for phones paired through OpenWave Connect
(openwave/connect.py): it's the same app an engine serves, switched to "connect" mode.

  /app/       the app from the latest release, which is what engines in people's homes run. Until a
              release includes OpenWave Connect, no released engine links here, so it's this
              branch's copy (for trying the first release before it's tagged).
  /app-next/  the app as it is on this branch, unlisted, for trying changes before a release
              (OPENWAVE_CONNECT_APP=https://…/app-next/ points an engine's pairing codes at it).

Usage: scripts/build-site.py OUT
"""

from __future__ import annotations

import io
import re
import shutil
import subprocess
import sys
import tarfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def remote_mode(app: Path, unlisted: bool) -> None:
    index = app / "index.html"
    html = index.read_text()
    html, n = re.subn(r'<meta name="openwave-mode" content="engine">', '<meta name="openwave-mode" content="connect">', html)
    if n != 1:
        raise SystemExit(f"{index}: no openwave-mode tag to switch")
    # No manifest: iOS then saves the page's own address (with its pairing code) to the Home
    # Screen, and the manifest's paths are written for an engine at "/".
    html = re.sub(r'\s*<link rel="manifest"[^>]*>', "", html)
    if unlisted:
        html = html.replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="robots" content="noindex">')
    index.write_text(html)
    (app / "manifest.webmanifest").unlink(missing_ok=True)


def latest_release_web() -> Path | None:
    """openwave/web from the newest v* tag, if that release has OpenWave Connect."""
    tags = subprocess.run(["git", "tag", "--list", "v*", "--sort=-v:refname"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split()
    for tag in tags[:1]:
        archive = subprocess.run(["git", "archive", "--format=tar", tag, "openwave/web"], cwd=ROOT, capture_output=True, check=True).stdout
        dest = ROOT / "build" / "release-web" / tag
        shutil.rmtree(dest, ignore_errors=True)
        dest.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            if hasattr(tarfile, "data_filter"):
                tar.extractall(dest, filter="data")
            else:                       # older Pythons; the archive is this repository's own files
                tar.extractall(dest)
        web = dest / "openwave" / "web"
        if (web / "js" / "remote.js").exists():
            print(f"/app/ from {tag}")
            return web
        print(f"/app/ from this branch: {tag} predates OpenWave Connect")
    return None


def main() -> None:
    out = Path(sys.argv[1]).resolve()
    shutil.rmtree(out, ignore_errors=True)
    shutil.copytree(ROOT / "site", out)
    shutil.rmtree(out / "connect-test", ignore_errors=True)
    shutil.copytree(ROOT / "docs" / "screenshots", out / "screenshots")
    shutil.copy(ROOT / "docs" / "logo.png", out / "logo.png")
    shutil.copy(ROOT / "openwave" / "web" / "icons" / "favicon-64.png", out / "favicon-64.png")

    ignore = shutil.ignore_patterns("__pycache__", ".DS_Store")
    shutil.copytree(ROOT / "openwave" / "web", out / "app-next", ignore=ignore)
    remote_mode(out / "app-next", unlisted=True)
    released = latest_release_web()
    shutil.copytree(released or ROOT / "openwave" / "web", out / "app", ignore=ignore)
    remote_mode(out / "app", unlisted=False)
    print(f"site in {out}")


if __name__ == "__main__":
    main()
