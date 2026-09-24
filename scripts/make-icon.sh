#!/bin/sh
# Regenerate the app icon from build/icon.svg (macOS only): build/icon.png
# at 1024x1024, then build/icon.icns from it. The SVG is the thinking
# indicator's dragon (web/src/components/Thinking.tsx) on a paper tile.
set -eu
cd "$(dirname "$0")/.."

SVG=build/icon.svg
PNG=build/icon.png
SET=build/icon.iconset

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SVG" -o "$PNG"
else
  # Quick Look draws SVG too, on any Mac, without the transparent corners
  # rsvg keeps — install librsvg (brew install librsvg) for the real thing
  qlmanage -t -s 1024 -o build "$SVG" >/dev/null
  mv "build/$(basename "$SVG").png" "$PNG"
fi

rm -rf "$SET" && mkdir -p "$SET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$PNG" --out "$SET/icon_${size}x${size}.png" >/dev/null
  dbl=$((size * 2))
  sips -z "$dbl" "$dbl" "$PNG" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o build/icon.icns
rm -rf "$SET"
echo "wrote $PNG and build/icon.icns"
