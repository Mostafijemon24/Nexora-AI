#!/usr/bin/env bash
# Installs a debug APK on the running emulator or connected phone and checks that the app really
# works there: the UI loads, the Android Keystore stores and returns a secret, and the device
# registration survives a restart of the app.
#
#   bash src-tauri/android/emulator-test.sh path/to/app-debug.apk
set -euo pipefail

apk="${1:?Pass the path of a debug APK.}"
app="ai.nexora.app"

fail() {
  echo "FAILED: $1"
  adb logcat -d -t 400 | grep -iE "nexora|tauri|rust|AndroidRuntime|chromium" | tail -n 120 || true
  exit 1
}

# Starts the app and prints the self-test report a debug build writes once its UI has loaded.
launch() {
  adb shell am start -W -n "$app/.MainActivity" > /dev/null
  local report=""
  for _ in $(seq 1 45); do
    report="$(adb shell run-as "$app" cat self-test.json 2> /dev/null || true)"
    if [ -n "$report" ] && [[ "$report" == \{* ]]; then
      echo "$report"
      return 0
    fi
    sleep 4
  done
  return 1
}

field() { node -e 'const r = JSON.parse(process.argv[1]); console.log(r[process.argv[2]] ?? "")' "$1" "$2"; }

adb install -r "$apk"

first="$(launch)" || fail "The UI did not load within three minutes."
echo "First start:  $first"
[ "$(field "$first" keystore)" = "ok" ] || fail "Keystore check: $(field "$first" keystore)"
adb shell pidof "$app" > /dev/null || fail "The app is no longer running."
id="$(field "$first" deviceId)"
[ -n "$id" ] || fail "No device registration was created."

adb shell am force-stop "$app"
adb shell run-as "$app" rm self-test.json

second="$(launch)" || fail "The UI did not load after a restart."
echo "Second start: $second"
[ "$(field "$second" keystore)" = "ok" ] || fail "Keystore check after restart: $(field "$second" keystore)"
[ "$(field "$second" deviceId)" = "$id" ] || fail "The device registration changed after a restart, so the Keystore did not keep it."

sleep 15
adb shell pidof "$app" > /dev/null || fail "The app stopped within 15 seconds."
echo "OK: UI loads, Keystore works, registration kept across restarts ($(field "$second" device), $(field "$second" os))."
