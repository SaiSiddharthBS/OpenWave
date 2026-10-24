"""One-time setup so GitHub can sign the Android app, and releases publish completely by themselves.

    uv run --with pynacl scripts/setup_android_signing.py
    (or: pip install pynacl && python3 scripts/setup_android_signing.py)

Reads your signing key from ~/.openwave/android/keystore.properties and stores it as the four
encrypted repository secrets android.yml uses. Your GitHub login comes from git's saved
credentials, the same one `git push` uses. Nothing is printed or written anywhere else.
Keep a backup of ~/.openwave/android/ too: Android only installs updates signed with the same key.
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO = "SaiSiddharthBS/OpenWave"
PROPS = Path.home() / ".openwave" / "android" / "keystore.properties"

try:
    from nacl import encoding, public
except ImportError:
    sys.exit("Needs PyNaCl. Run:  uv run --with pynacl scripts/setup_android_signing.py")


def github_token() -> str:
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
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        raw = r.read()
    return json.loads(raw) if raw else {}


def main() -> None:
    if not PROPS.exists():
        sys.exit(f"{PROPS} not found. Is this the computer that has the OpenWave signing key?")
    props = dict(line.split("=", 1) for line in PROPS.read_text().splitlines() if "=" in line and not line.startswith("#"))
    keystore = Path(props["storeFile"]).expanduser()
    if not keystore.is_absolute():
        keystore = PROPS.parent / keystore
    secrets = {
        "OPENWAVE_KEYSTORE_B64": base64.b64encode(keystore.read_bytes()).decode(),
        "OPENWAVE_KEYSTORE_PASSWORD": props["storePassword"],
        "OPENWAVE_KEY_ALIAS": props["keyAlias"],
        "OPENWAVE_KEY_PASSWORD": props["keyPassword"],
    }
    token = github_token()
    key = api(token, "GET", "/actions/secrets/public-key")
    box = public.SealedBox(public.PublicKey(key["key"].encode(), encoding.Base64Encoder()))
    for name, value in secrets.items():
        sealed = base64.b64encode(box.encrypt(value.encode())).decode()
        api(token, "PUT", f"/actions/secrets/{name}", {"encrypted_value": sealed, "key_id": key["key_id"]})
        print(f"✓ {name}")
    print("\nDone. From now on, ./scripts/release.sh publishes every release, Android included, by itself.")


if __name__ == "__main__":
    main()
