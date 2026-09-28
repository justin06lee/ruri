/**
 * Draw the app icon: build/icon.svg, which `make icon` (scripts/make-icon.sh)
 * turns into build/icon.png and build/icon.icns.
 *
 * ruri's own mark, drawn with the pen the model makers' marks are drawn with
 * (components/Marks.tsx, lib/doodle.ts): three sideways diamonds, one sitting
 * in the notch between the other two, each outlined in the paper theme's ink
 * with its colour laid a hair off the line, the way a cheap print
 * misregisters, and every line shaken a little. The colours are ruri's own —
 * 瑠璃, lapis lazuli: three blues, lightest on top.
 *
 * Deterministic: the same seeds shake the same way, so running this again
 * without changing it writes the same file.
 *
 *   bun scripts/draw-icon.ts [out.svg]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { type Pt, shaker } from "../web/src/lib/doodle.js";

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** The paper theme's page and ink (styles.css, :root). */
const PAPER = "#f6f1e6";
const INK = "#191510";
/** The pen the marks drawn in several parts use (Marks.tsx, Blocks), on
 *  their 100-unit page — the single-shape marks' 4.2 is heavy on a diamond
 *  a third their size. */
const PEN = 3.2;

/** Lapis: top, left, right — the light on the top face, the deepest last. */
const BLUES = ["#4a78c9", "#1e50a2", "#163c80"];

/** Half the width and half the height of a diamond: lying on its side. */
const HALF_W = 19;
const HALF_H = 13;
/** How far each diamond is drawn in from the tiling, so the three read as
 *  three rather than one shape with lines across it. */
const INSET = 2.4;

/**
 * A diamond drawn by hand: four edges, each bowed a little its own way, the
 * corners a hair off true.
 */
function diamond(cx: number, cy: number, halfW: number, halfH: number, seed: number): string {
  const shake = shaker(seed);
  const corners: Pt[] = (
    [
      [cx, cy - halfH],
      [cx + halfW, cy],
      [cx, cy + halfH],
      [cx - halfW, cy],
    ] as Pt[]
  ).map(([x, y]) => [x + shake(0.5), y + shake(0.5)]);
  let d = `M${r1(corners[0]![0])} ${r1(corners[0]![1])}`;
  corners.forEach((a, i) => {
    const b = corners[(i + 1) % 4]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const bow = shake(0.9);
    const mx = (a[0] + b[0]) / 2 + (-(b[1] - a[1]) / len) * bow;
    const my = (a[1] + b[1]) / 2 + ((b[0] - a[0]) / len) * bow;
    d += `Q${r1(mx)} ${r1(my)} ${r1(b[0])} ${r1(b[1])}`;
  });
  return `${d}Z`;
}

/**
 * The three, on the marks' 100-unit page, centred on it: a diamond's
 * lower-left edge is its left neighbour's upper-right, so the one on top
 * sits in the notch between the two below — a larger diamond with its
 * bottom quarter gone.
 */
function mark(): Array<{ d: string; fill: string }> {
  // the whole spans 4 half-widths and 3 half-heights; its middle on the page's
  const y0 = 50 + HALF_H / 2;
  const shrink = 1 - INSET / ((HALF_W * HALF_H) / Math.hypot(HALF_W, HALF_H));
  const w = HALF_W * shrink;
  const h = HALF_H * shrink;
  const centres: Pt[] = [
    [50, y0 - HALF_H],
    [50 - HALF_W, y0],
    [50 + HALF_W, y0],
  ];
  return centres.map(([x, y], n) => ({ d: diamond(x, y, w, h, 11 + n * 17), fill: BLUES[n]! }));
}

/** The shaky-line filter the marks carry (components/Marks.tsx, Doodle). */
const WOBBLE = `<filter id="wobble" filterUnits="userSpaceOnUse" x="-12" y="-12" width="124" height="124">
      <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="5" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="2.4" xChannelSelector="R" yChannelSelector="G"/>
    </filter>`;

export function iconSvg(): string {
  const faces = mark();
  // the page, scaled so the mark spans about three quarters of the tile,
  // set a hair above the middle (where the eye puts the middle), and tipped
  // the degree or two a mark sits at
  const scale = 8.6;
  const place = `translate(512 ${r1(512 - 1.5 * scale)}) rotate(-2) scale(${scale}) translate(-50 -50)`;
  const washes = faces
    .map((f) => `<path d="${f.d}" fill="${f.fill}" transform="translate(2.6 2.3)"/>`)
    .join("\n        ");
  const lines = faces.map((f) => `<path d="${f.d}"/>`).join("\n        ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="ruri">
  <!-- the app icon, written by scripts/draw-icon.ts: ruri's three diamonds in
       the model makers' marks' pen, on the paper theme's page, in the macOS
       icon grid's rounded square -->
  <defs>
    ${WOBBLE}
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="${PAPER}"/>
  <g transform="${place}">
    <g filter="url(#wobble)">
      <g>
        ${washes}
      </g>
      <g fill="none" stroke="${INK}" stroke-width="${PEN}" stroke-linejoin="round" stroke-linecap="round">
        ${lines}
      </g>
    </g>
  </g>
</svg>
`;
}

if (import.meta.main) {
  const out = path.resolve(process.argv[2] ?? path.join(import.meta.dir, "..", "build", "icon.svg"));
  fs.writeFileSync(out, iconSvg());
  console.log(`wrote ${out}`);
}
