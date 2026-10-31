"""A private, in-process Nostr relay for tests: stores events and forwards them like a public one.

Follows the rules shared playlists depend on: signatures are checked, and for replaceable events
(kind 30000-39999) only the newest per (author, kind, "d" tag) is kept; on a tie of timestamps the
lowest id wins, as NIP-01 specifies. `online = False` drops every connection, like a lost network.
"""

from __future__ import annotations

import asyncio
import json

import websockets

from openwave import nostr


class FakeRelay:
    def __init__(self):
        self.events: dict[tuple, dict] = {}
        self.clients: dict = {}            # websocket -> {sub_id: filter}
        self.server = None
        self.url = ""
        self.accepting = True              # False: refuse new connections (simulates an outage)

    async def start(self) -> "FakeRelay":
        self.server = await websockets.serve(self._client, "127.0.0.1", 0, max_size=8 * 1024 * 1024)
        port = self.server.sockets[0].getsockname()[1]
        self.url = f"ws://127.0.0.1:{port}"
        return self

    async def stop(self) -> None:
        self.server.close()
        await self.server.wait_closed()

    async def outage(self) -> None:
        """Drop everyone and refuse to reconnect until `restore()`."""
        self.accepting = False
        for ws in list(self.clients):
            await ws.close()

    def restore(self) -> None:
        self.accepting = True

    @staticmethod
    def _matches(flt: dict, ev: dict) -> bool:
        if "kinds" in flt and ev["kind"] not in flt["kinds"]:
            return False
        if "#d" in flt and nostr.tag(ev, "d") not in flt["#d"]:
            return False
        return True

    async def _client(self, ws):
        if not self.accepting:
            await ws.close()
            return
        self.clients[ws] = {}
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg[0] == "EVENT":
                    ev = msg[1]
                    if not nostr.valid_event(ev):
                        await ws.send(json.dumps(["OK", ev.get("id"), False, "invalid: bad signature"]))
                        continue
                    key = (ev["pubkey"], ev["kind"], nostr.tag(ev, "d")) if 30000 <= ev["kind"] < 40000 else (ev["id"],)
                    old = self.events.get(key)
                    if old and (old["created_at"], [-ord(c) for c in old["id"]]) >= (ev["created_at"], [-ord(c) for c in ev["id"]]):
                        await ws.send(json.dumps(["OK", ev["id"], True, "duplicate: have a newer one"]))
                        continue
                    self.events[key] = ev
                    await ws.send(json.dumps(["OK", ev["id"], True, ""]))
                    for other, subs in list(self.clients.items()):
                        for sub_id, flt in subs.items():
                            if self._matches(flt, ev):
                                await other.send(json.dumps(["EVENT", sub_id, ev]))
                elif msg[0] == "REQ":
                    sub_id, flt = msg[1], msg[2]
                    self.clients[ws][sub_id] = flt
                    for ev in list(self.events.values()):
                        if self._matches(flt, ev):
                            await ws.send(json.dumps(["EVENT", sub_id, ev]))
                    await ws.send(json.dumps(["EOSE", sub_id]))
                elif msg[0] == "CLOSE":
                    self.clients[ws].pop(msg[1], None)
        except websockets.ConnectionClosed:
            pass
        finally:
            self.clients.pop(ws, None)


async def wait_until(check, timeout: float = 15.0, step: float = 0.1):
    """Polls `check()` until it returns something truthy."""
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        value = check()
        if value:
            return value
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out waiting for sync")
        await asyncio.sleep(step)


if __name__ == "__main__":
    # Run standalone for manual testing: python tests/fake_relay.py 47950
    import sys

    async def main():
        relay = FakeRelay()
        relay.server = await websockets.serve(relay._client, "127.0.0.1", int(sys.argv[1]) if len(sys.argv) > 1 else 0, max_size=8 * 1024 * 1024)
        print(f"relay on ws://127.0.0.1:{relay.server.sockets[0].getsockname()[1]}", flush=True)
        await asyncio.Future()

    asyncio.run(main())
