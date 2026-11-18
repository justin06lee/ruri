#!/bin/sh
# Notarize a Developer ID–signed .app with Apple and staple the ticket to it,
# so it opens on any Mac without "Open Anyway" — even offline.
#
#   sh scripts/notarize.sh dist-app/mac-arm64/ruri.app
#
# Signs in to Apple's notary service with the notarytool keychain profile
# NOTARY_PROFILE (default "notary"; stored once with `xcrun notarytool
# store-credentials notary …`) when the keychain has it, and otherwise with
# the App Store Connect API key the iPhone app's TestFlight upload uses
# (ios/Makefile: ASC_KEY_ID, ASC_ISSUER, ASC_KEY — the key itself is never
# in this repo). Exits non-zero, with Apple's log, when the app is not
# accepted, or when there is neither to sign in with.
set -eu

app=${1:?usage: notarize.sh <path to .app>}
profile=${NOTARY_PROFILE:-notary}
key_id=${ASC_KEY_ID:-Y688NH26RQ}
issuer=${ASC_ISSUER:-fd10fb1e-e9c4-4570-bda4-e93f2e10c8ff}
key=${ASC_KEY:-$HOME/.appstoreconnect/private_keys/AuthKey_$key_id.p8}

# the profile is asked for by name: one that isn't there, or that Apple no
# longer takes, gives way to the key
if xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
  set -- --keychain-profile "$profile"
  echo "signing in to Apple with the keychain profile '$profile'"
elif [ -f "$key" ]; then
  set -- --key "$key" --key-id "$key_id" --issuer "$issuer"
  echo "signing in to Apple with the App Store Connect key $key_id"
else
  echo "notarization: nothing to sign in to Apple with — no '$profile' keychain profile (xcrun notarytool store-credentials $profile) and no API key at $key" >&2
  exit 1
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/$(basename "$app" .app).zip"

ditto -c -k --keepParent "$app" "$zip"
echo "notarizing $(basename "$app") (this takes a few minutes)…"
out=$(xcrun notarytool submit "$zip" "$@" --wait --output-format json) || true
id=$(printf '%s' "$out" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
status=$(printf '%s' "$out" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')

if [ "$status" != "Accepted" ]; then
  echo "notarization: ${status:-no answer} ${id:+(submission $id)}" >&2
  [ -n "$id" ] && xcrun notarytool log "$id" "$@" >&2 || printf '%s\n' "$out" >&2
  exit 1
fi

xcrun stapler staple -q "$app"
spctl -a -t exec "$app"
echo "notarized and stapled (submission $id)"
