#!/bin/sh
# Record the tour: a scratch ruri (scratch-server.ts), the app paired with it
# on a simulator, and the UI test (RuriUITests/TourTests) walking through it
# while real turns run — as a video.
#
#   ios/demo/record.sh [out.mp4]      (SIM="iPhone 17" by default)
set -eu
cd "$(dirname "$0")/.."
OUT=${1:-"$PWD/build/tour.mp4"}
SIM=${SIM:-iPhone 17}
DERIVED=build
mkdir -p "$(dirname "$OUT")"

LOG=$(mktemp -t ruri-scratch)
(cd .. && exec bun ios/demo/scratch-server.ts) >"$LOG" 2>&1 &
SERVER=$!
REC=""
stop() {
  [ -n "$REC" ] && kill -INT "$REC" 2>/dev/null && wait "$REC" 2>/dev/null || true
  kill -TERM "$SERVER" 2>/dev/null && wait "$SERVER" 2>/dev/null || true
}
trap stop EXIT INT TERM

echo "starting a scratch ruri…"
until grep -q '^ruri://pair' "$LOG"; do
  kill -0 "$SERVER" 2>/dev/null || { cat "$LOG"; exit 1; }
  sleep 1
done
LINK=$(grep -m1 '^ruri://pair' "$LOG")
CUE=$(sed -n 's/^touch \(.*\/go\) to start the turns$/\1/p' "$LOG")

echo "building…"
xcodebuild -project Ruri.xcodeproj -scheme Ruri -derivedDataPath "$DERIVED" -quiet \
  -destination "platform=iOS Simulator,name=$SIM" build-for-testing
xcrun simctl bootstatus "$SIM" -b >/dev/null
xcrun simctl uninstall "$SIM" com.justin06lee.ruri.phone 2>/dev/null || true
xcrun simctl ui "$SIM" appearance light

echo "recording $OUT…"
xcrun simctl io "$SIM" recordVideo --codec h264 --force "$OUT" &
REC=$!
sleep 2
TEST_RUNNER_RURI_PAIR_LINK="$LINK" TEST_RUNNER_RURI_DEMO_CUE="$CUE" \
  xcodebuild -project Ruri.xcodeproj -scheme Ruri -derivedDataPath "$DERIVED" -quiet \
  -destination "platform=iOS Simulator,name=$SIM" -only-testing:RuriUITests/TourTests test-without-building
sleep 1
stop
REC=""
echo "wrote $OUT"
