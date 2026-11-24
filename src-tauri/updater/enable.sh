#!/usr/bin/env bash
# Turns auto-update on for a CI build, when the updater key pair is available.
#
# Reads from the environment:
#   TAURI_UPDATER_PUBKEY                 the public key (the app verifies every update against it)
#   TAURI_SIGNING_PRIVATE_KEY            the private key (signs the update packages)
#   TAURI_SIGNING_PRIVATE_KEY_PASSWORD   its password, if it has one
#
# With both keys it writes src-tauri/tauri.updater.conf.json (a config override that makes the
# build produce signed update packages), exports what the build needs through $GITHUB_ENV and sets
# the step output `args` to the flag that applies the override. Without them it changes nothing
# and the build is exactly what it was before auto-update existed.
set -euo pipefail

if [ -z "${TAURI_UPDATER_PUBKEY:-}" ] || [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  echo "No updater key pair is configured: building without auto-update."
  echo "args=" >> "$GITHUB_OUTPUT"
  exit 0
fi

node -e '
  const fs = require("fs");
  const override = {
    bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: process.env.TAURI_UPDATER_PUBKEY.trim() } },
  };
  fs.writeFileSync("src-tauri/tauri.updater.conf.json", JSON.stringify(override, null, 2) + "\n");
'

{
  # Baked into the app: the key it trusts, and the switch that makes it look for updates at all.
  echo "NEXORA_UPDATER_PUBKEY<<NEXORA_ENV_EOF"; printf '%s\n' "$TAURI_UPDATER_PUBKEY"; echo "NEXORA_ENV_EOF"
  echo "TAURI_SIGNING_PRIVATE_KEY<<NEXORA_ENV_EOF"; printf '%s\n' "$TAURI_SIGNING_PRIVATE_KEY"; echo "NEXORA_ENV_EOF"
  # Always set, even when empty: without it the signer stops and asks for a password.
  echo "TAURI_SIGNING_PRIVATE_KEY_PASSWORD<<NEXORA_ENV_EOF"; printf '%s\n' "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"; echo "NEXORA_ENV_EOF"
} >> "$GITHUB_ENV"

echo "args=--config src-tauri/tauri.updater.conf.json" >> "$GITHUB_OUTPUT"
echo "Auto-update is on: update packages will be signed."
