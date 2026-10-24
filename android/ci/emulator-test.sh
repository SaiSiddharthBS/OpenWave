#!/usr/bin/env bash
# End-to-end test of the installed Android app on an emulator:
# engine starts on the phone → app shows OpenWave → profile → play a song → Android media session
# reports it → media notification shows → (when YouTube serves audio to this machine) hardware
# media keys work and playback continues on the home screen.
#
# YouTube often refuses audio to datacenter IPs (CI runners) with "Sign in to confirm you're not a bot".
# Android only routes hardware media keys to an app that is really producing sound, so those checks
# run only when the phone is actually playing audio; everything else runs regardless.
set -euo pipefail
APK="$1"
PKG=io.github.saisiddharthbs.openwave
OUT=android-test
HP="${HOST_PORT:-47878}"   # host side of the adb port forward
mkdir -p "$OUT"
shot() { adb exec-out screencap -p > "$OUT/$1.png" || true; }
session() { adb shell dumpsys media_session | tr -d '\r'; }
state() { session | grep -A30 "package=$PKG" | grep -oE "state=PlaybackState \{state=[A-Z_]+" | head -1 | sed 's/.*state=//'; }
# is Android playing sound from the app right now? (AudioTrack in state "started" for its uid)
APP_UID=""
audible() { adb shell dumpsys audio | tr -d '\r' | grep -E "u/pid:$APP_UID/" | grep -q "state:started"; }
screen_text() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 && adb shell cat /sdcard/ui.xml | tr -d '\r'; }
# centre of the first on-screen element whose text or hint matches $1
tap_text() {
  local b
  b=$(screen_text | grep -oE "(text|hint)=\"$1\"[^>]*bounds=\"\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]\"" | head -1 | grep -oE "\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]")
  [ -n "$b" ] || return 1
  local nums=($(echo "$b" | grep -oE "[0-9]+"))
  adb shell input tap $(( (nums[0] + nums[2]) / 2 )) $(( (nums[1] + nums[3]) / 2 ))
}
# centre of the first on-screen element of an Android widget class (e.g. android.widget.EditText)
tap_class() {
  local b
  b=$(screen_text | grep -oE "class=\"$1\"[^>]*bounds=\"\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]\"" | head -1 | grep -oE "\[[0-9]+,[0-9]+\]\[[0-9]+,[0-9]+\]")
  [ -n "$b" ] || return 1
  local nums=($(echo "$b" | grep -oE "[0-9]+"))
  adb shell input tap $(( (nums[0] + nums[2]) / 2 )) $(( (nums[1] + nums[3]) / 2 ))
}
wait_state() { for i in $(seq 1 "${2:-15}"); do [ "$(state)" = "$1" ] && return 0; sleep 1; done; return 1; }
wait_text() { for i in $(seq 1 "${2:-60}"); do screen_text | grep -q "$1" && return 0; sleep 2; done; return 1; }
fail() {
  echo "❌ $*"; shot failure
  echo "----- on screen"; screen_text | grep -oE '(text|content-desc)="[^"]+"' | sort -u | head -60 || true
  echo "----- media session"; session | grep -A30 "package=$PKG" || true
  echo "----- app log"; adb logcat -d -s OpenWave:V python.stdout:V python.stderr:V AndroidRuntime:E chromium:W | tail -120
  exit 1
}

adb logcat -c
adb install -r -g "$APK"
APP_UID=$(adb shell pm list packages -U "$PKG" | tr -d '\r' | grep -oE "uid:[0-9]+" | head -1 | cut -d: -f2)
adb shell am start -n "$PKG/.MainActivity"
adb forward "tcp:$HP" tcp:47878
for i in $(seq 1 150); do curl -sf "localhost:$HP"/api/health > "$OUT/health.json" && break; sleep 2; done
[ -s "$OUT/health.json" ] || fail "engine did not start"
echo "✅ engine running on the phone: $(cat "$OUT/health.json")"

wait_text "Welcome to OpenWave" 60 || fail "the app never showed OpenWave (stuck on the splash screen?)"
shot 1-welcome
echo "✅ app shows the welcome screen"

tap_class "android.widget.EditText" || tap_text "Your name" || fail "name field not found"
sleep 1; adb shell input text Tester; sleep 1
adb shell input keyevent 66   # Enter submits the form (the keyboard covers the button)
for i in $(seq 1 30); do curl -sf "localhost:$HP"/api/profiles | grep -q Tester && break; sleep 2; done
curl -sf "localhost:$HP"/api/profiles | grep -q Tester || fail "profile was not created"
echo "✅ profile created from the app"
wait_text "Tester" 30 || true
sleep 5; shot 2-home

adb shell am start -a android.intent.action.VIEW -d "openwave://play/9qnqYL0eNNI" "$PKG"
for i in $(seq 1 60); do [ "$(state)" = "PLAYING" ] && break; sleep 2; done
[ "$(state)" = "PLAYING" ] || fail "song did not start playing"
session | grep -A30 "package=$PKG" | grep -E "description=" | head -1
echo "✅ playing, reported to Android's media session"
sleep 5; shot 3-playing

for i in $(seq 1 30); do audible && break; sleep 1; done
if audible; then REAL_AUDIO=1; echo "✅ Android hears the song playing"; else
  REAL_AUDIO=0
  echo "⚠️  no sound reached Android. Engine log:"
  adb logcat -d -s python.stderr:V python.stdout:V | grep -iE "error|sign in|bot" | tail -5 || true
  echo "⚠️  (YouTube usually blocks datacenter IPs like this CI runner) — skipping the checks that need real sound"
fi

adb shell dumpsys notification --noredact | tr -d '\r' | grep -A80 "pkg=$PKG" | grep -qE "android.mediaSession|MediaStyle" \
  || fail "no media notification for the playing song"
adb shell cmd statusbar expand-notifications; sleep 3; shot 4-notification; adb shell cmd statusbar collapse; sleep 1
echo "✅ media notification and lock-screen controls are showing"

if [ "$REAL_AUDIO" = 1 ]; then
  for i in $(seq 1 15); do audible && break; sleep 1; done
  adb shell input keyevent KEYCODE_MEDIA_PAUSE
  wait_state PAUSED || fail "media pause key did not pause"
  echo "✅ hardware pause key works"
  adb shell input keyevent KEYCODE_MEDIA_PLAY
  wait_state PLAYING || fail "media play key did not resume"
  echo "✅ hardware play key works"

  adb shell input keyevent KEYCODE_HOME
  sleep 20
  [ "$(state)" = "PLAYING" ] && audible || fail "stopped playing in the background"
  echo "✅ keeps playing on the home screen"
  echo "🎉 all Android checks passed"
else
  echo "🎉 all Android checks that don't need YouTube audio passed"
fi
