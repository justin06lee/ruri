/**
 * Paths that look drawn by hand: a smooth line through points, arcs and
 * blobs that aren't quite round, straight lines with a little bow, tiles
 * whose corners don't quite match — each wobbling the same way
 * every time for the same seed. The marks over an empty chat are built
 * from them (components/Marks.tsx). Pure: numbers in, SVG path data out.
 */

export type Pt = readonly [number, number];

const r1 = (n: number): number => Math.round(n * 10) / 10;

/** A small, repeatable jitter: the same seed shakes the same way. */
export function shaker(seed: number): (amount: number) => number {
  let s = (seed * 2654435761) >>> 0 || 1;
  return (amount) => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return ((s / 2 ** 32) * 2 - 1) * amount;
  };
}

/** A smooth curve through every point (Catmull-Rom, as cubic Béziers). */
export function through(points: readonly Pt[], closed = false): string {
  const n = points.length;
  if (n === 0) return "";
  const at = (i: number): Pt => (closed ? points[(i + n) % n]! : points[Math.max(0, Math.min(n - 1, i))]!);
  const [x0, y0] = points[0]!;
  let d = `M${r1(x0)} ${r1(y0)}`;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${r1(c1x)} ${r1(c1y)} ${r1(c2x)} ${r1(c2y)} ${r1(p2[0])} ${r1(p2[1])}`;
  }
  return closed ? `${d}Z` : d;
}

/** Points along an ellipse from `from`° through `sweep`° (clockwise, 0° is
 *  east), each nudged in or out by up to `wobble`. */
export function arcPoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  sweep: number,
  { wobble = 0.8, seed = 1, step = 24 }: { wobble?: number; seed?: number; step?: number } = {},
): Pt[] {
  const shake = shaker(seed);
  const count = Math.max(2, Math.round(Math.abs(sweep) / step));
  const points: Pt[] = [];
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const angle = ((from + sweep * t) * Math.PI) / 180;
    const nudge = i === 0 || i === count ? 0 : shake(wobble);
    points.push([cx + Math.cos(angle) * (rx + nudge), cy + Math.sin(angle) * (ry + nudge)]);
  }
  return points;
}

/** An arc, open at both ends. */
export function arc(
  cx: number,
  cy: number,
  r: number,
  from: number,
  sweep: number,
  options: { wobble?: number; seed?: number; step?: number } = {},
): string {
  return through(arcPoints(cx, cy, r, r, from, sweep, options));
}

/** A closed shape round the ellipse — for a fill, which must not overshoot. */
export function blob(
  cx: number,
  cy: number,
  rx: number,
  ry = rx,
  { wobble = 0.9, seed = 1 }: { wobble?: number; seed?: number } = {},
): string {
  return through(arcPoints(cx, cy, rx, ry, 0, 345, { wobble, seed, step: 23 }), true);
}

/** A straight line that isn't quite: bowed to one side by `bow`. */
export function stroke(a: Pt, b: Pt, bow = 0.8): string {
  const mx = (a[0] + b[0]) / 2;
  const my = (a[1] + b[1]) / 2;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const nx = -(b[1] - a[1]) / len;
  const ny = (b[0] - a[0]) / len;
  return `M${r1(a[0])} ${r1(a[1])}Q${r1(mx + nx * bow)} ${r1(my + ny * bow)} ${r1(b[0])} ${r1(b[1])}`;
}

/** Several strokes as one path. */
export const strokes = (...parts: string[]): string => parts.join("");

/** A rounded rectangle drawn by hand: every corner its own, edges bowed. */
export function tile(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  { wobble = 0.9, seed = 1 }: { wobble?: number; seed?: number } = {},
): string {
  const shake = shaker(seed);
  const corners: Array<[number, number, number]> = [
    [x + w - radius, y + radius, -90],
    [x + w - radius, y + h - radius, 0],
    [x + radius, y + h - radius, 90],
    [x + radius, y + radius, 180],
  ];
  const points: Pt[] = [];
  corners.forEach(([cx, cy, start], i) => {
    const r = radius + shake(wobble);
    for (const step of [0, 45, 90]) {
      const angle = ((start + step) * Math.PI) / 180;
      points.push([
        cx + Math.cos(angle) * r + shake(wobble * 0.4),
        cy + Math.sin(angle) * r + shake(wobble * 0.4),
      ]);
    }
    // the middle of the edge to the next corner, so a long side stays a
    // side rather than ballooning between its corners
    const [nx, ny, nStart] = corners[(i + 1) % 4]!;
    const a = ((start + 90) * Math.PI) / 180;
    const b = (nStart * Math.PI) / 180;
    points.push([
      (cx + Math.cos(a) * r + nx + Math.cos(b) * radius) / 2 + shake(wobble),
      (cy + Math.sin(a) * r + ny + Math.sin(b) * radius) / 2 + shake(wobble),
    ]);
  });
  return through(points, true);
}

/** A polygon with softened corners, each point nudged — for slabs and blocks. */
export function poly(
  points: readonly Pt[],
  { wobble = 0.6, seed = 1 }: { wobble?: number; seed?: number } = {},
): string {
  const shake = shaker(seed);
  return `${points.map(([px, py], i) => `${i === 0 ? "M" : "L"}${r1(px + shake(wobble))} ${r1(py + shake(wobble))}`).join("")}Z`;
}
