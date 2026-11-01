"""OpenWave on your phone anywhere through Tailscale: this computer gets a private HTTPS address that
only devices signed in to your own Tailscale account can open. Tailscale forwards it to the engine,
which keeps listening where it was. HTTPS also lets the iPhone's Home Screen app keep downloads.

The same as the Mac app's Settings → Phone (macos/Sources/OpenWave/Tailscale.swift), and on the same
port, so either place shows and changes the one setting.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

HTTPS_PORT = 8443        # 443 is often taken by other things people share with Tailscale
DOWNLOAD = "https://tailscale.com/download"


def cli() -> str | None:
    if sys.platform == "darwin":
        options = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/opt/homebrew/bin/tailscale", "/usr/local/bin/tailscale"]
    elif sys.platform == "win32":
        options = [os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "Tailscale", "tailscale.exe")]
    else:
        options = ["/usr/bin/tailscale", "/usr/local/bin/tailscale", "/usr/sbin/tailscale"]
    found = next((p for p in options if os.path.isfile(p) and os.access(p, os.X_OK)), None)
    return found or shutil.which("tailscale")


def _run(args: list[str], timeout: float = 30) -> tuple[int, str]:
    exe = cli()
    if not exe:
        return -1, ""
    try:
        r = subprocess.run([exe, *args], capture_output=True, text=True, timeout=timeout,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except (OSError, subprocess.TimeoutExpired) as e:
        return -1, str(e)


def _json(args: list[str]) -> dict | None:
    code, out = _run(args, timeout=10)
    # Tailscale may print a warning (e.g. a version mismatch) around the JSON.
    start, end = out.find("{"), out.rfind("}")
    if code != 0 or start < 0 or end < start:
        return None
    try:
        value = json.loads(out[start:end + 1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None


def state(engine_port: int) -> dict:
    """{"state": "missing" | "signedOut" | "ready" | "sharing", "url": … when sharing}."""
    if not cli():
        return {"state": "missing", "download": DOWNLOAD}
    status = _json(["status", "--json"])
    me = (status or {}).get("Self") or {}
    dns = str(me.get("DNSName") or "").rstrip(".")
    if not status or status.get("BackendState") != "Running" or not dns:
        return {"state": "signedOut"}
    web = (_json(["serve", "status", "--json"]) or {}).get("Web") or {}
    proxy = (((web.get(f"{dns}:{HTTPS_PORT}") or {}).get("Handlers") or {}).get("/") or {}).get("Proxy")
    if proxy in (f"http://127.0.0.1:{engine_port}", f"http://localhost:{engine_port}"):
        return {"state": "sharing", "url": f"https://{dns}:{HTTPS_PORT}/"}
    return {"state": "ready", "host": dns}


def share(engine_port: int) -> str | None:
    """Start sharing; returns what the person needs to do first, if Tailscale couldn't."""
    code, out = _run(["serve", "--bg", f"--https={HTTPS_PORT}", f"http://127.0.0.1:{engine_port}"])
    if code == 0:
        return None
    link = re.search(r"https://login\.tailscale\.com/\S+", out)
    if link:   # a tailnet without HTTPS certificates: Tailscale prints where to switch them on
        return f"Tailscale needs HTTPS switched on for your account. Turn it on at {link.group(0)} and try again."
    if "access denied" in out.lower() or "operator" in out.lower():
        return "Tailscale needs permission first: run “sudo tailscale set --operator=$USER” once, then try again."
    detail = " ".join(out.split())[:200]
    return f"Tailscale couldn’t share OpenWave{': ' + detail if detail else '.'}"


def stop() -> None:
    _run(["serve", f"--https={HTTPS_PORT}", "off"])
