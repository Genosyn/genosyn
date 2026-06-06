#!/usr/bin/env bash
# Regenerate the PWA PNG icons.
#
#   ./scripts/icons/gen.sh
#
# The brand mark is a white ring on the navy app square (see
# client/public/favicon.svg). We draw it with ImageMagick's native primitives
# rather than rasterizing an SVG, because IM's built-in SVG renderer silently
# drops the stroked circle without a librsvg delegate. Native drawing needs
# nothing but ImageMagick and renders identically everywhere. Masters are drawn
# at 2x and downscaled for clean anti-aliasing. The PNGs are committed because
# the runtime serves them statically and the manifest names them exactly.
set -euo pipefail

out="$(cd "$(dirname "$0")/../../client/public/icons" 2>/dev/null && pwd || true)"
if [ -z "$out" ]; then
  out="$(cd "$(dirname "$0")/../.." && pwd)/client/public/icons"
  mkdir -p "$out"
fi

if command -v magick >/dev/null 2>&1; then
  im() { magick "$@"; }
elif command -v convert >/dev/null 2>&1; then
  im() { convert "$@"; }
else
  echo "error: ImageMagick not found (need 'magick' or 'convert')" >&2
  exit 1
fi

navy="#0f172a"
white="#ffffff"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Masters are 1024px (2x). Geometry mirrors favicon.svg scaled to a 1024 canvas:
# corner radius 256, ring centered at 512,512. "any" keeps transparent corners;
# the maskable + apple masters are full-bleed so no mask exposes a clear corner.

# "any": rounded navy square + ring (r=288, stroke=76).
im -size 1024x1024 xc:none \
  -fill "$navy" -draw "roundrectangle 0,0 1023,1023 256,256" \
  -fill none -stroke "$white" -strokewidth 76 -draw "circle 512,512 512,224" \
  "PNG32:$tmp/any.png"

# "maskable": full-bleed navy + ring pulled into the safe zone (r=240, stroke=68).
im -size 1024x1024 "xc:$navy" \
  -fill none -stroke "$white" -strokewidth 68 -draw "circle 512,512 512,272" \
  "PNG32:$tmp/maskable.png"

# apple-touch: full-bleed navy + a comfortably sized ring (r=300, stroke=80).
im -size 1024x1024 "xc:$navy" \
  -fill none -stroke "$white" -strokewidth 80 -draw "circle 512,512 512,212" \
  "PNG32:$tmp/apple.png"

# resize <master> <size> <output.png>
resize() { im "$tmp/$1.png" -resize "${2}x${2}" "PNG32:$out/$3"; }

resize any      512 icon-512.png
resize any      192 icon-192.png
resize maskable 512 icon-maskable-512.png
resize maskable 192 icon-maskable-192.png
resize apple    180 apple-touch-icon.png

echo "Wrote PNG icons to $out:"
ls -1 "$out"
