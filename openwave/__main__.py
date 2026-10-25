"""Run with:  python -m openwave [--host 0.0.0.0] [--port 8787] [--no-browser]"""

import argparse
import threading
import webbrowser

import uvicorn

from .link import lan_ip


def main():
    parser = argparse.ArgumentParser(prog="openwave", description="Free, open-source music player backed by YouTube")
    parser.add_argument("--host", default="0.0.0.0", help="interface to bind (default: all, so phones on your Wi-Fi can connect)")
    parser.add_argument("--port", type=int, default=8787)
    parser.add_argument("--no-browser", action="store_true", help="don't open a browser window")
    args = parser.parse_args()

    local = f"http://localhost:{args.port}"
    print(f"\n  OpenWave is running\n\n  This computer:  {local}")
    if args.host == "0.0.0.0" and (ip := lan_ip()):
        print(f"  Your phone:     http://{ip}:{args.port}   (same Wi-Fi)")
    print()
    if not args.no_browser:
        threading.Timer(1.5, lambda: webbrowser.open(local)).start()
    uvicorn.run("openwave.app:app", host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
