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

# the simulator's recorder can't write to every volume: /tmp first
TAKE=/tmp/ruri-tour-$$.mp4
echo "recording ${OUT}…"
xcrun simctl io "$SIM" recordVideo --codec h264 --force "$TAKE" &
REC=$!
sleep 2
set +e
TEST_RUNNER_RURI_PAIR_LINK="$LINK" TEST_RUNNER_RURI_DEMO_CUE="$CUE" \
  xcodebuild -project Ruri.xcodeproj -scheme Ruri -derivedDataPath "$DERIVED" -quiet \
  -destination "platform=iOS Simulator,name=$SIM" -only-testing:RuriUITests/TourTests test-without-building
STATUS=$?
sleep 1
stop
REC=""
mv "$TAKE" "$OUT"
# the tour's screenshots, out of its result bundle
SHOTS="$(dirname "$OUT")/shots"
rm -rf "$SHOTS" && mkdir -p "$SHOTS"
RESULT=$(ls -td "$DERIVED"/Logs/Test/*.xcresult | head -1)
xcrun xcresulttool export attachments --path "$RESULT" --output-path "$SHOTS" >/dev/null
python3 -I - "$SHOTS" <<'PY'
import json, os, sys
shots = sys.argv[1]
for test in json.load(open(os.path.join(shots, "manifest.json"))):
    for a in test["attachments"]:
        name = a.get("suggestedHumanReadableName", "").split("_0_")[0]
        if name:
            os.rename(os.path.join(shots, a["exportedFileName"]), os.path.join(shots, name + ".png"))
os.remove(os.path.join(shots, "manifest.json"))
PY
xcrun simctl shutdown "$SIM" || true
echo "wrote $OUT and $SHOTS"
exit $STATUS
