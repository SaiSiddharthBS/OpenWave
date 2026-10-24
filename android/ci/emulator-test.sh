#!/usr/bin/env bash
# End-to-end test of the installed Android app on an emulator:
# engine starts on the phone → profile → play a song → Android media session reports it →
# hardware media keys work → playback continues on the home screen.
set -euo pipefail
APK="$1"
PKG=io.github.saisiddharthbs.openwave
OUT=android-test
mkdir -p "$OUT"
shot() { adb exec-out screencap -p > "$OUT/$1.png" || true; }
session() { adb shell dumpsys media_session | tr -d '\r'; }
state() { session | grep -A30 "package=$PKG" | grep -oE "state=PlaybackState \{state=[A-Z_]+" | head -1 | sed 's/.*state=//'; }
position() { session | grep -A30 "package=$PKG" | grep -oE "position=[0-9]+" | head -1 | cut -d= -f2; }
fail() { echo "❌ $*"; shot failure; session | grep -A30 "package=$PKG" || true; adb logcat -d | grep -iE "python|openwave|chromium|AndroidRuntime" | tail -60; exit 1; }

adb install -r -g "$APK"
adb shell am start -n "$PKG/.MainActivity"
adb forward tcp:47878 tcp:47878
for i in $(seq 1 150); do curl -sf localhost:47878/api/health > "$OUT/health.json" && break; sleep 2; done
[ -s "$OUT/health.json" ] || fail "engine did not start"
echo "✅ engine running on the phone: $(cat "$OUT/health.json")"
sleep 8; shot 1-welcome

# The name field is focused on the welcome screen: type a name and press Enter.
adb shell input text Tester; sleep 1; adb shell input keyevent 66
for i in $(seq 1 30); do curl -sf localhost:47878/api/profiles | grep -q Tester && break; sleep 2; done
curl -sf localhost:47878/api/profiles | grep -q Tester || fail "profile was not created"
echo "✅ profile created from the app"
sleep 10; shot 2-home

adb shell am start -a android.intent.action.VIEW -d "openwave://play/9qnqYL0eNNI" "$PKG"
for i in $(seq 1 60); do [ "$(state)" = "PLAYING" ] && break; sleep 2; done
[ "$(state)" = "PLAYING" ] || fail "song did not start playing"
session | grep -A30 "package=$PKG" | grep -E "description=|metadata" | head -2
echo "✅ playing, reported to Android's media session"
sleep 5; shot 3-playing

adb shell input keyevent KEYCODE_MEDIA_PAUSE
for i in $(seq 1 15); do [ "$(state)" = "PAUSED" ] && break; sleep 1; done
[ "$(state)" = "PAUSED" ] || fail "media pause key did not pause"
echo "✅ hardware pause key works"
adb shell input keyevent KEYCODE_MEDIA_PLAY
for i in $(seq 1 15); do [ "$(state)" = "PLAYING" ] && break; sleep 1; done
[ "$(state)" = "PLAYING" ] || fail "media play key did not resume"
echo "✅ hardware play key works"

adb shell input keyevent KEYCODE_HOME
sleep 3; P1=$(position); sleep 15; P2=$(position)
[ "$(state)" = "PLAYING" ] || fail "stopped playing in the background"
echo "✅ keeps playing on the home screen (position ${P1}ms → ${P2}ms)"
adb shell cmd statusbar expand-notifications; sleep 3; shot 4-notification
echo "🎉 all Android checks passed"
