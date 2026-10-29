#!/bin/sh
# Notarize a Developer ID–signed .app with Apple and staple the ticket to it,
# so it opens on any Mac without "Open Anyway" — even offline.
#
#   sh scripts/notarize.sh dist-app/mac-arm64/ruri.app
#
# Uses the notarytool keychain profile NOTARY_PROFILE (default "notary"),
# stored once with `xcrun notarytool store-credentials notary …`. Exits
# non-zero, with Apple's log, when the app is not accepted.
set -eu

app=${1:?usage: notarize.sh <path to .app>}
profile=${NOTARY_PROFILE:-notary}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
zip="$tmp/$(basename "$app" .app).zip"

ditto -c -k --keepParent "$app" "$zip"
echo "notarizing $(basename "$app") (this takes a few minutes)…"
out=$(xcrun notarytool submit "$zip" --keychain-profile "$profile" --wait --output-format json) || true
id=$(printf '%s' "$out" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
status=$(printf '%s' "$out" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')

if [ "$status" != "Accepted" ]; then
  echo "notarization: ${status:-no answer} ${id:+(submission $id)}" >&2
  [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$profile" >&2 || printf '%s\n' "$out" >&2
  exit 1
fi

xcrun stapler staple -q "$app"
spctl -a -t exec "$app"
echo "notarized and stapled (submission $id)"
