"""Daily snapshot of OpenWave's public numbers, for the Stats page (site/stats.html).

Run by .github/workflows/stats.yml: python scripts/collect_stats.py history.json
It adds today's downloads of every release file, stars, forks and watchers to the file. With a
token that may read traffic (the optional STATS_TOKEN secret), it also keeps GitHub's daily views
and clones, which GitHub itself only remembers for two weeks.

Only public counts from GitHub are used: the apps never report anything, so these numbers say how
many times OpenWave was downloaded, not how many people use it.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

REPO = os.getenv("GITHUB_REPOSITORY", "SaiSiddharthBS/OpenWave")
API = f"https://api.github.com/repos/{REPO}"


def get(path: str, token: str | None):
    req = urllib.request.Request(path if path.startswith("http") else API + path)
    req.add_header("Accept", "application/vnd.github+json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def downloads(token: str | None) -> dict:
    """{"v0.3.1": {"OpenWave-Android.apk": 12, ...}, ...} for every published release."""
    out: dict[str, dict[str, int]] = {}
    page = 1
    while True:
        releases = get(f"/releases?per_page=100&page={page}", token)
        for rel in releases:
            if rel.get("draft"):
                continue
            files = {a["name"]: a["download_count"] for a in rel.get("assets", [])
                     if not a["name"].endswith((".sha256", ".txt"))}
            out[rel["tag_name"]] = files
        if len(releases) < 100:
            return out
        page += 1


def traffic(history: dict, token: str | None) -> None:
    """Merge GitHub's last 14 days of views and clones into the kept history."""
    kept = history.setdefault("traffic", {})
    try:
        for kind in ("views", "clones"):
            data = get(f"/traffic/{kind}", token)
            days = kept.setdefault(kind, {})
            for d in data.get(kind, []):
                days[d["timestamp"][:10]] = {"count": d["count"], "uniques": d["uniques"]}
        kept["referrers"] = get("/traffic/popular/referrers", token)
    except urllib.error.HTTPError as e:
        print(f"traffic not collected ({e.code}): add a STATS_TOKEN secret that can read traffic to include it")


def main(path: str) -> None:
    token = os.getenv("GH_TOKEN")
    try:
        with open(path) as f:
            history = json.load(f)
    except (OSError, ValueError):
        history = {}
    history = history if isinstance(history, dict) else {}
    repo = get("", token)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    snapshot = {
        "date": today,
        "downloads": downloads(token),
        "stars": repo["stargazers_count"],
        "forks": repo["forks_count"],
        "watchers": repo["subscribers_count"],
    }
    days = [d for d in history.get("days", []) if d.get("date") != today]
    history["days"] = [*days, snapshot]
    traffic(history, os.getenv("STATS_TOKEN") or None)
    history["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with open(path, "w") as f:
        json.dump(history, f, indent=1)
    total = sum(sum(files.values()) for files in snapshot["downloads"].values())
    print(f"{today}: {total} downloads, {snapshot['stars']} stars, {len(history['days'])} days kept")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "history.json")
