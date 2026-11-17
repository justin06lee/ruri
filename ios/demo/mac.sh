#!/bin/sh
# The iPhone app on this Mac, without Xcode: built with the command-line
# tools as a Mac Catalyst app, in a window the size of an iPhone. The same
# SwiftUI and UIKit as on the phone, so it is how to compile and look at a
# change when there is no simulator. It has no software keyboard, no camera
# and no notifications, and Xcode's asset catalog and previews are left out.
#
#   ios/demo/mac.sh check          type-check only, as the phone's build would
#   ios/demo/mac.sh build          build/mac/Ruri.app
#   ios/demo/mac.sh run [link]     build, then open it (paired by a ruri://pair
#                                  link, when given one)
#   ios/demo/mac.sh demo <screen>  build, then open it on made-up data: home,
#                                  project, chat, pair or mac
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
  sed -n '2,14p' "$0" >&2
  exit 2
  ;;
esac
