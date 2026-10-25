"""One-time setup so the Stats page can also show visitors to the GitHub page.

    uv run --with pynacl,certifi scripts/setup_stats_token.py

GitHub only shows traffic to people who can change the repository, so the daily stats workflow
needs a token that may read it. Only you can create one (GitHub doesn't allow it any other way).
This opens GitHub's token page already filled in, you click "Generate token" and paste it here; the
script checks that it works and saves it as the STATS_TOKEN secret, encrypted like the other secrets.
The token can only read this repository's settings and traffic; it can't change anything.
"""

from __future__ import annotations

import base64
import getpass
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

REPO = "SaiSiddharthBS/OpenWave"
OWNER = REPO.split("/")[0]

try:
    from nacl import encoding, public
except ImportError:
    sys.exit("Needs PyNaCl. Run:  uv run --with pynacl,certifi scripts/setup_stats_token.py")

try:  # python.org's Python on macOS has no certificates of its own
    import certifi

    CONTEXT = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CONTEXT = ssl.create_default_context()


def github_login() -> str:
    out = subprocess.run(["git", "credential", "fill"], input="protocol=https\nhost=github.com\n\n",
                         capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        if line.startswith("password="):
            return line.split("=", 1)[1]
    sys.exit("No saved GitHub login found. Push something with git once, then run this again.")


def api(token: str, method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"https://api.github.com/repos/{REPO}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, context=CONTEXT) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def main() -> None:
    page = "https://github.com/settings/personal-access-tokens/new?" + urllib.parse.urlencode({
        "name": "OpenWave stats",
        "description": "Lets the daily stats workflow read GitHub traffic for the OpenWave Stats page.",
        "target_name": OWNER,
        "expires_in": "366",
        "administration": "read",
    })
    print("1. GitHub's token page is opening, already filled in. If it isn't, open:\n   " + page)
    print("2. Under Repository access choose “Only select repositories” → OpenWave,")
    print("   check that Permissions shows Administration: Read-only, then click “Generate token”.")
    print("3. Copy the token and paste it below (it won't show as you paste).\n")
    webbrowser.open(page)
    token = os.getenv("STATS_TOKEN") or getpass.getpass("Token: ").strip()
    if not token:
        sys.exit("No token given; nothing changed.")

    try:
        views = api(token, "GET", "/traffic/views")
    except urllib.error.HTTPError as e:
        sys.exit(f"That token can't read traffic yet (GitHub said {e.code}). Make sure it has OpenWave selected and "
                 "Administration: Read-only, then run this again.")
    print(f"✓ The token works: {views.get('count', 0)} views of the GitHub page in the last 14 days")

    login = github_login()
    key = api(login, "GET", "/actions/secrets/public-key")
    box = public.SealedBox(public.PublicKey(key["key"].encode(), encoding.Base64Encoder()))
    sealed = base64.b64encode(box.encrypt(token.encode())).decode()
    api(login, "PUT", "/actions/secrets/STATS_TOKEN", {"encrypted_value": sealed, "key_id": key["key_id"]})
    print("✓ Saved as the STATS_TOKEN secret")

    api(login, "POST", "/actions/workflows/stats.yml/dispatches", {"ref": "main"})
    print("✓ Collecting today's numbers now. Visitors show on https://saisiddharthbs.github.io/OpenWave/stats.html in a minute.")


if __name__ == "__main__":
    main()
