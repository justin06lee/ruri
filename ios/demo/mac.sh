#!/bin/sh
# The iPhone app on this Mac, without Xcode: built with the command-line
# tools as a Mac Catalyst app, in a window the size of an iPhone. The same
# SwiftUI and UIKit as on the phone, so it is how to compile and look at a
# change when there is no simulator. It has no software keyboard, no camera
# and no notifications, and Xcode's asset catalog and previews are left out.
#
#   ios/demo/mac.sh check          type-check only, as the phone's build would
#   ios/demo/mac.sh test           run the unit tests (RuriTests), with the
#                                  command-line tools' Swift Testing
#   ios/demo/mac.sh build          build/mac/Ruri.app
#   ios/demo/mac.sh run [link]     build, then open it (paired by a ruri://pair
#                                  link, when given one)
#   ios/demo/mac.sh demo <screen>  build, then open it on made-up data: home,
#                                  project, chat, pair, pair-another or mac
set -eu
cd "$(dirname "$0")/.."

SDK=$(xcrun --sdk macosx --show-sdk-path)
SUPPORT="$SDK/System/iOSSupport"
[ -d "$SUPPORT/System/Library/Frameworks/UIKit.framework" ] || {
  echo "this macOS SDK has no Mac Catalyst support: $SDK" >&2
  exit 1
}
OUT=build/mac
APP=$OUT/Ruri.app
ID=com.justin06lee.ruri.phone.mac
# all of the app but Xcode's previews, which need its own macro plugin, and
# the camera's scanner, which Mac Catalyst doesn't have — with what stands in
# for it and the rest this build needs (demo/mac/)
SOURCES=$( (find Ruri -name '*.swift' ! -name Previews.swift ! -name QRScanner.swift; find demo/mac -name '*.swift') | sort)
FLAGS="-target arm64-apple-ios18.0-macabi -sdk $SDK
  -Fsystem $SUPPORT/System/Library/Frameworks -I $SUPPORT/usr/lib/swift -L $SUPPORT/usr/lib/swift
  -swift-version 6 -parse-as-library -module-name Ruri -D DEBUG"

check() {
  echo "type-checking $(echo "$SOURCES" | wc -l | tr -d ' ') files…"
  # shellcheck disable=SC2086
  swiftc -typecheck $FLAGS $SOURCES
  echo "checked"
}

# The unit tests, built into one binary with the app: the module's @main
# gives way to Swift Testing's runner, and `@testable import Ruri` goes,
# the tests being in the module themselves. (The UI tests need Xcode.)
test() {
  TESTING=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
  PLUGINS=/Library/Developer/CommandLineTools/usr/lib/swift/host/plugins/testing
  [ -d "$TESTING/Testing.framework" ] || {
    echo "no Swift Testing in the command-line tools: $TESTING" >&2
    exit 1
  }
  WORK=$OUT/tests
  rm -rf "$WORK"
  mkdir -p "$WORK/src"
  for f in $SOURCES; do sed 's/^@main$//' "$f" >"$WORK/src/$(echo "$f" | tr / _)"; done
  for f in RuriTests/*.swift; do sed '/@testable import Ruri/d' "$f" >"$WORK/src/test_$(basename "$f")"; done
  cat >"$WORK/src/zz_main.swift" <<'SWIFT'
import Foundation
import Testing

@main
enum Tests {
    static func main() async {
        let failed: CInt = await Testing.__swiftPMEntryPoint(passing: nil)
        exit(failed)
    }
}
SWIFT
  echo "building $(ls RuriTests/*.swift | wc -l | tr -d ' ') test files with the app…"
  # shellcheck disable=SC2086
  swiftc $FLAGS -Onone -F "$TESTING" -plugin-path "$PLUGINS" \
    -Xlinker -rpath -Xlinker "$TESTING" -Xlinker -rpath -Xlinker /Library/Developer/CommandLineTools/Library/Developer/usr/lib \
    "$WORK"/src/*.swift -o "$WORK/run" 2>&1 | grep -v -e warning -e '^ *[0-9]* |' -e '^ *|' -e note: || true
  [ -x "$WORK/run" ] || {
    echo "the tests didn't build" >&2
    exit 1
  }
  echo "running…"
  "$WORK/run"
}

build() {
  echo "building $APP…"
  rm -rf "$APP"
  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
  # shellcheck disable=SC2086
  swiftc $FLAGS -Onone -g $SOURCES -o "$APP/Contents/MacOS/Ruri"
  # what the asset catalog would hold, loose: the mark, and the fonts
  cp Ruri/Assets.xcassets/Mark.imageset/mark@2x.png "$APP/Contents/Resources/Mark@2x.png"
  cp Ruri/Assets.xcassets/Mark.imageset/mark@3x.png "$APP/Contents/Resources/Mark@3x.png"
  find Ruri -name '*.ttf' -exec cp {} "$APP/Contents/Resources/" \;
  cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleIdentifier</key><string>$ID</string>
	<key>CFBundleExecutable</key><string>Ruri</string>
	<key>CFBundleName</key><string>ruri phone</string>
	<key>CFBundleDisplayName</key><string>ruri phone</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
	<key>LSMinimumSystemVersion</key><string>15.0</string>
	<key>UIDeviceFamily</key><array><integer>2</integer></array>
	<key>UIApplicationSceneManifest</key>
	<dict><key>UIApplicationSupportsMultipleScenes</key><false/></dict>
	<key>UILaunchScreen</key><dict/>
	<key>NSAppTransportSecurity</key>
	<dict><key>NSAllowsArbitraryLoads</key><true/></dict>
	<key>NSLocalNetworkUsageDescription</key>
	<string>ruri reaches your Mac on your network to show what it's working on.</string>
</dict>
</plist>
PLIST
  codesign --force --sign - "$APP" 2>/dev/null
  echo "built $APP"
}

case "${1:-run}" in
check) check ;;
test) test ;;
build) build ;;
run)
  build
  defaults delete "$ID" demo 2>/dev/null || true
  if [ -n "${2:-}" ]; then defaults write "$ID" pairLink "$2"; fi
  open -g "$APP"
  ;;
demo)
  build
  defaults write "$ID" demo "${2:-home}"
  open -g "$APP"
  ;;
*)
  sed -n '2,16p' "$0" >&2
  exit 2
  ;;
esac
