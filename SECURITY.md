# Security policy

## Supported versions

Security fixes are made in the latest release. Every OpenWave app checks for updates and installs them in one step, so please make sure you are on the [latest version](https://github.com/SaiSiddharthBS/OpenWave/releases/latest) before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/SaiSiddharthBS/OpenWave/security/advisories/new)). Include:

- what the problem is and what an attacker could do with it;
- the steps to reproduce it, and the platform and OpenWave version;
- any suggestions for a fix.

You will get a reply within a few days. Once a fix is released, the advisory is published with credit to you, unless you prefer to stay anonymous.

## Scope

Areas where reports are especially valuable:

- the engine's HTTP API, including profile sessions and PINs;
- the device link on the local network (ports 47880–47889): discovery, pairing and remote control;
- the update paths: the Mac installer script, the Mac app's self-update, and the in-app update checks on other platforms;
- anything that could expose a user's library or listening history.

Problems in upstream projects (yt-dlp, ytmusicapi, FastAPI, Chaquopy) should be reported to those projects; feel free to let us know as well so OpenWave can update.
