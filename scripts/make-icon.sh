#!/bin/sh
# Regenerate build/icon.icns from build/icon.png (1024x1024, macOS only).
set -eu
cd "$(dirname "$0")/.."

PNG=build/icon.png
SET=build/icon.iconset

rm -rf "$SET" && mkdir -p "$SET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$PNG" --out "$SET/icon_${size}x${size}.png" >/dev/null
  dbl=$((size * 2))
  sips -z "$dbl" "$dbl" "$PNG" --out "$SET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o build/icon.icns
rm -rf "$SET"
echo "wrote build/icon.icns"
