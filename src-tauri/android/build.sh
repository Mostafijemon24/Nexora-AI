#!/usr/bin/env bash
# Builds the Android app. Run from the repository root:
#
#   bash src-tauri/android/build.sh debug     a debug APK (installable, signed with the SDK's debug key)
#   bash src-tauri/android/build.sh release   a release APK and an .aab for Google Play
#
# Needs Node, Rust, JDK 17 and the Android SDK with an NDK (ANDROID_HOME, and NDK_HOME or
# ANDROID_NDK_HOME). The Android Studio project is generated into src-tauri/gen/android by the
# Tauri CLI each time, so it is not kept in the repository; the only Android code of our own is the
# Keystore plugin in crates/tauri-plugin-nexora-keystore.
#
# A release build is signed only when these are set (otherwise it stops, because an unsigned APK
# cannot be installed):
#   ANDROID_KEYSTORE_FILE      path to the upload keystore (.jks)
#   ANDROID_KEYSTORE_PASSWORD  its password (also used for the key)
#   ANDROID_KEY_ALIAS          the key's alias
# Outputs are copied to src-tauri/gen/android/dist/.
set -euo pipefail

mode="${1:-debug}"
abis=(aarch64 armv7 x86_64)
project="src-tauri/gen/android"

export NDK_HOME="${NDK_HOME:-${ANDROID_NDK_LATEST_HOME:-${ANDROID_NDK_HOME:-}}}"
test -n "${ANDROID_HOME:-}" || { echo "ANDROID_HOME is not set (Android SDK)."; exit 1; }
test -n "$NDK_HOME" || { echo "NDK_HOME is not set (Android NDK)."; exit 1; }

if [ ! -d "$project" ]; then
  npx tauri android init --ci
fi
# The generated project starts with the Tauri logo; these are the app's own launcher icons.
cp -R src-tauri/icons/android/. "$project/app/src/main/res/"

out="$project/dist"
rm -rf "$out"
mkdir -p "$out"
version="$(node -p "require('./src-tauri/tauri.conf.json').version")"

case "$mode" in
  debug)
    npx tauri android build --debug --apk --ci --target "${abis[@]}"
    apk="$(find "$project/app/build/outputs/apk" -name '*-debug.apk' | head -n 1)"
    test -n "$apk" || { echo "No debug APK was produced."; exit 1; }
    cp "$apk" "$out/Nexora-AI_${version}_android-debug.apk"
    ;;
  release)
    : "${ANDROID_KEYSTORE_FILE:?Set ANDROID_KEYSTORE_FILE, ANDROID_KEYSTORE_PASSWORD and ANDROID_KEY_ALIAS to sign the release.}"
    : "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD is not set.}"
    : "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS is not set.}"
    npx tauri android build --apk --aab --ci --target "${abis[@]}"

    tools="$(find "$ANDROID_HOME/build-tools" -mindepth 1 -maxdepth 1 -type d | sort -V | tail -n 1)"
    unsigned="$(find "$project/app/build/outputs/apk" -name '*-release*.apk' | head -n 1)"
    test -n "$unsigned" || { echo "No release APK was produced."; exit 1; }
    signed="$out/Nexora-AI_${version}_android.apk"
    "$tools/zipalign" -f -p 4 "$unsigned" "$out/aligned.apk"
    "$tools/apksigner" sign --ks "$ANDROID_KEYSTORE_FILE" --ks-key-alias "$ANDROID_KEY_ALIAS" \
      --ks-pass env:ANDROID_KEYSTORE_PASSWORD --key-pass env:ANDROID_KEYSTORE_PASSWORD \
      --out "$signed" "$out/aligned.apk"
    rm -f "$out/aligned.apk" "$signed.idsig"
    "$tools/apksigner" verify --print-certs "$signed" | head -n 3

    bundle="$(find "$project/app/build/outputs/bundle" -name '*.aab' | head -n 1)"
    test -n "$bundle" || { echo "No app bundle was produced."; exit 1; }
    cp "$bundle" "$out/Nexora-AI_${version}_android.aab"
    jarsigner -keystore "$ANDROID_KEYSTORE_FILE" -storepass:env ANDROID_KEYSTORE_PASSWORD \
      -keypass:env ANDROID_KEYSTORE_PASSWORD "$out/Nexora-AI_${version}_android.aab" "$ANDROID_KEY_ALIAS" > /dev/null
    jarsigner -verify "$out/Nexora-AI_${version}_android.aab" | tail -n 1
    ;;
  *)
    echo "Usage: bash src-tauri/android/build.sh [debug|release]"
    exit 1
    ;;
esac

ls -lh "$out"
