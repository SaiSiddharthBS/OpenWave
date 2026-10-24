#!/usr/bin/env bash
# End-to-end test of the installed Android app on an emulator:
# engine starts on the phone → app shows OpenWave → profile → play a song → Android media session
# reports it → hardware media keys work → playback continues on the home screen.
set -euo pipefail
APK="$1"
PKG=io.github.saisiddharthbs.openwave
OUT=android-test
mkdir -p "$OUT"
shot() { adb exec-out screencap -p > "$OUT/$1.png" || true; }
session() { adb shell dumpsys media_session | tr -d '\r'; }
state() { session | grep -A30 "package=$PKG" | grep -oE "state=PlaybackState \{state=[A-Z_]+" | head -1 | sed 's/.*state=//'; }
position() { session | grep -A30 "package=$PKG" | grep -oE "position=[0-9]+" | head -1 | cut -d= -f2; }
screen_text() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb shell cat /sdcard/ui.xml | tr -d '\r'; }
# centre of the first on-screen element whose text or hint matches $1
tap_text() {
  local b
  b=$(screen_text | grep -oE "(text|hint)=\"$1\"[^>]*bounds=\"\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]\"" | head -1 | grep -oE "\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]")
  [ -n "$b" ] || return 1
  local nums=($(echo "$b" | grep -oE "[0-9]+"))
  adb shell input tap $(( (nums[0] + nums[2]) / 2 )) $(( (nums[1] + nums[3]) / 2 ))
}
wait_text() { for i in $(seq 1 "${2:-60}"); do screen_text | grep -q "$1" && return 0; sleep 2; done; return 1; }
fail() {
  echo "❌ $*"; shot failure
  echo "----- media session"; session | grep -A30 "package=$PKG" || true
  echo "----- app log"; adb logcat -d -s OpenWave:V python.stdout:V python.stderr:V AndroidRuntime:E chromium:W | tail -120
  exit 1
}

adb logcat -c
adb install -r -g "$APK"
adb shell am start -n "$PKG/.MainActivity"
adb forward tcp:47878 tcp:47878
for i in $(seq 1 150); do curl -sf localhost:47878/api/health > "$OUT/health.json" && break; sleep 2; done
[ -s "$OUT/health.json" ] || fail "engine did not start"
echo "✅ engine running on the phone: $(cat "$OUT/health.json")"

wait_text "Welcome to OpenWave" 60 || fail "the app never showed OpenWave (stuck on the splash screen?)"
shot 1-welcome
echo "✅ app shows the welcome screen"

tap_text "Your name" || fail "name field not found"
sleep 1; adb shell input text Tester; sleep 1
tap_text "Start listening" || adb shell input keyevent 66
for i in $(seq 1 30); do curl -sf localhost:47878/api/profiles | grep -q Tester && break; sleep 2; done
curl -sf localhost:47878/api/profiles | grep -q Tester || fail "profile was not created"
echo "✅ profile created from the app"
wait_text "Tester" 30 || true
sleep 5; shot 2-home

adb shell am start -a android.intent.action.VIEW -d "openwave://play/9qnqYL0eNNI" "$PKG"
for i in $(seq 1 60); do [ "$(state)" = "PLAYING" ] && break; sleep 2; done
[ "$(state)" = "PLAYING" ] || fail "song did not start playing"
session | grep -A30 "package=$PKG" | grep -E "description=" | head -1
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
