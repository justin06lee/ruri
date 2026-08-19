#!/bin/sh
# Regenerate build/icon.icns from build/icon.svg (macOS only).
# Renders via rsvg-convert if available, else qlmanage; then sips + iconutil.
set -eu
cd "$(dirname "$0")/.."

SRC=build/icon.svg
PNG=build/icon-1024.png
SET=build/icon.iconset

if command -v rsvg-convert >/dev/null 2>&1; then
  rsvg-convert -w 1024 -h 1024 "$SRC" -o "$PNG"
else
  qlmanage -t -s 1024 -o build "$SRC" >/dev/null
  mv "build/$(basename "$SRC").png" "$PNG"
fi

rm -rf "$SET" && mkdir -p "$SET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$PNG" --out "$SET/icon_${size}x${size}.png" >/dev/null
  dbl=$((size * 2))
  sips -z "$dbl" "$dbl" "$PNG" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o build/icon.icns
rm -rf "$SET" "$PNG"
echo "wrote build/icon.icns"
