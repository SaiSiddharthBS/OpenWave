"""Settings → Phones → With Tailscale, against a stand-in `tailscale` command (never the real one)."""

from __future__ import annotations

import json
import sys

import pytest
from fastapi.testclient import TestClient

from openwave import app, tailscale

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="the stand-in is a shell script")


@pytest.fixture
def fake(tmp_path, monkeypatch):
    """A `tailscale` that answers from a JSON file and records what it was asked to do."""
    state = tmp_path / "state.json"
    calls = tmp_path / "calls.txt"
    script = tmp_path / "tailscale"
    script.write_text(f"""#!/usr/bin/env python3
import json, sys
st = json.load(open({str(state)!r}))
open({str(calls)!r}, "a").write(" ".join(sys.argv[1:]) + "\\n")
args = sys.argv[1:]
if args[:2] == ["status", "--json"]:
    print("Warning: client version != tailscaled version")
    print(json.dumps({{"BackendState": st["backend"], "Self": {{"DNSName": "den-mac.tail1234.ts.net."}}}}))
elif args[:3] == ["serve", "status", "--json"]:
    print(json.dumps({{"Web": st.get("web", {{}})}}))
elif args[:2] == ["serve", "--bg"]:
    if st.get("refuse"):
        print(st["refuse"]); sys.exit(1)
    st["web"] = {{"den-mac.tail1234.ts.net:8443": {{"Handlers": {{"/": {{"Proxy": args[-1]}}}}}}}}
    json.dump(st, open({str(state)!r}, "w"))
elif args[:2] == ["serve", "--https=8443"] and args[-1] == "off":
    st["web"] = {{}}
    json.dump(st, open({str(state)!r}, "w"))
""")
    script.chmod(0o755)
    state.write_text(json.dumps({"backend": "Running"}))
    monkeypatch.setattr(tailscale, "cli", lambda: str(script))

    class Fake:
        def set(self, **kw):
            st = json.loads(state.read_text())
            st.update(kw)
            state.write_text(json.dumps(st))

        def calls(self):
            return calls.read_text().splitlines() if calls.exists() else []
    return Fake()


def test_states_from_missing_to_sharing(fake, monkeypatch):
    fake.set(backend="NeedsLogin")
    assert tailscale.state(47878) == {"state": "signedOut"}
    fake.set(backend="Running")
    assert tailscale.state(47878) == {"state": "ready", "host": "den-mac.tail1234.ts.net"}
    assert tailscale.share(47878) is None
    assert fake.calls()[-1] == "serve --bg --https=8443 http://127.0.0.1:47878"
    assert tailscale.state(47878) == {"state": "sharing", "url": "https://den-mac.tail1234.ts.net:8443/"}
    assert tailscale.state(9999)["state"] == "ready"          # shared, but for another engine
    tailscale.stop()
    assert tailscale.state(47878)["state"] == "ready"
    monkeypatch.setattr(tailscale, "cli", lambda: None)
    assert tailscale.state(47878)["state"] == "missing"


def test_what_to_do_when_tailscale_refuses(fake):
    fake.set(refuse="To enable, visit:\n\n    https://login.tailscale.com/f/serve?node=abc\n")
    assert "https://login.tailscale.com/f/serve?node=abc" in tailscale.share(47878)
    fake.set(refuse="Access denied: serve config denied")
    assert "--operator" in tailscale.share(47878)


def test_settings_api_and_phones_cannot_change_it(fake):
    with TestClient(app.app) as c:
        port = 80                                              # what the test client's requests arrive on
        assert c.get("/api/connect/tailscale").json()["state"] == "ready"
        on = c.post("/api/connect/tailscale", json={"on": True}).json()
        assert on == {"state": "sharing", "url": "https://den-mac.tail1234.ts.net:8443/"}
        assert f"http://127.0.0.1:{port}" in fake.calls()[-3]
        assert c.post("/api/connect/tailscale", json={"on": False}).json()["state"] == "ready"
        fake.set(refuse="something went wrong")
        r = c.post("/api/connect/tailscale", json={"on": True})
        assert r.status_code == 409 and "something went wrong" in r.json()["detail"]
