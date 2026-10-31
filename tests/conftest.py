import os

# Tests never contact public Nostr relays; shared-playlist tests run their own (tests/fake_relay.py).
os.environ.setdefault("OPENWAVE_RELAYS", "off")
