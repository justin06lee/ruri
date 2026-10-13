import { blob, poly, type Pt, stroke, strokes, through, tile } from "./doodle";

/**
 * ruri's six features, one doodle each, as drawn for its website
 * (ruri.codes, src/drawings.ts) and kept here to be used in the app later —
 * nothing imports them yet. The marks' pen on the marks' 100-unit page: the
 * outline in the theme's ink (currentColor), the icon's lapis laid a hair
 * off it the way a cheap print misregisters, and the marks' turbulence
 * shaking every line. Each returns SVG markup; a React version would follow
 * Marks.tsx's Doodle/Line/Wash. The markup leans on two rules the site
 * carries and styles.css doesn't yet:
 *
 *   .pen .ink { fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; }
 *   .pen .dot { fill: currentColor; }
 *
 * A picture of them is assets/feature-doodles.png.
 */

/** Lapis (瑠璃, ruri): the icon's three blues, lightest first (scripts/draw-icon.ts). */
const BLUES = ["#4a78c9", "#1e50a2", "#163c80"] as const;

/** How far a colour is laid off its line, on the 100-unit page. */
const OFF = "translate(2.6 2.3)";

let filters = 0;

/** An SVG whose every line is shaken by the marks' turbulence. */
function pen(
  box: readonly [number, number, number, number],
  body: string,
  { seed = 5, shake = 2.4, cls = "" }: { seed?: number; shake?: number; cls?: string } = {},
): string {
  const id = `pen${++filters}`;
  const [x, y, w, h] = box;
  return (
    `<svg class="pen${cls ? ` ${cls}` : ""}" viewBox="${x} ${y} ${w} ${h}" aria-hidden="true" focusable="false">` +
    `<defs><filter id="${id}" filterUnits="userSpaceOnUse" x="${x - 12}" y="${y - 12}" width="${w + 24}" height="${h + 24}">` +
    `<feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed="${seed}" result="n"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="${shake}" xChannelSelector="R" yChannelSelector="G"/>` +
    `</filter></defs><g filter="url(#${id})">${body}</g></svg>`
  );
}

/** A line in the pen, `width` on the page it is drawn on. */
const ink = (d: string, width = 4.2, cls = "ink"): string =>
  `<path class="${cls}" d="${d}" stroke-width="${width}"/>`;

/** A flat colour, laid off its line. */
const wash = (d: string, fill: string, opacity?: number): string =>
  `<path d="${d}" fill="${fill}" transform="${OFF}"${opacity === undefined ? "" : ` opacity="${opacity}"`}/>`;

/** The theme's ink, faint: the marks' wash for the things that are only black. */
const grey = (d: string): string => wash(d, "currentColor", 0.16);

/** Two short strokes back from `tip`, the way it was heading. */
function arrowhead(tip: Pt, heading: number, size: number): string {
  const barb = (turn: number): string =>
    stroke(tip, [tip[0] - Math.cos(heading + turn) * size, tip[1] - Math.sin(heading + turn) * size], 0.3);
  return strokes(barb(0.5), barb(-0.5));
}

/** Projects are folders. */
function folder(): string {
  const back = poly(
    [
      [12, 24],
      [38, 24],
      [46, 33],
      [88, 33],
      [88, 80],
      [12, 80],
    ],
    { wobble: 0.7, seed: 3 },
  );
  return pen([0, 0, 100, 100], wash(back, BLUES[0]) + ink(back) + ink(stroke([12, 44], [88, 44], 0.9)), {
    seed: 3,
  });
}

/** Any harness: three shapes of thing, at home together. */
function harnesses(): string {
  const round = blob(30, 33, 17, 17, { seed: 4 });
  const three = poly(
    [
      [48, 52],
      [68, 87],
      [28, 87],
    ],
    { wobble: 0.6, seed: 5 },
  );
  const four = tile(55, 15, 32, 32, 7, { seed: 2, wobble: 0.5 });
  return pen(
    [0, 0, 100, 100],
    wash(round, BLUES[0]) +
      wash(three, BLUES[1]) +
      wash(four, BLUES[2]) +
      ink(round) +
      ink(three) +
      ink(four),
    { seed: 11 },
  );
}

/** A queue you can steer: three cards, the middle one being carried. */
function queue(): string {
  const top = tile(14, 14, 62, 18, 6, { seed: 1, wobble: 0.6 });
  const carried = tile(26, 41, 62, 18, 6, { seed: 2, wobble: 0.6 });
  const bottom = tile(14, 68, 62, 18, 6, { seed: 3, wobble: 0.6 });
  return pen(
    [0, 0, 100, 100],
    grey(top) + grey(bottom) + wash(carried, BLUES[0]) + ink(top) + ink(bottom) + ink(carried),
    { seed: 13 },
  );
}

/** Rewind: back along the line, to a checkpoint. */
function rewind(): string {
  const back: Pt[] = [
    [82, 58],
    [72, 30],
    [50, 20],
    [28, 30],
    [19, 56],
  ];
  const [a, b] = [back.at(-2)!, back.at(-1)!];
  const stops = [18, 50, 82].map((x, i) => blob(x, 76, 7, 7, { seed: 30 + i, wobble: 0.4 }));
  return pen(
    [0, 0, 100, 100],
    wash(stops[0]!, BLUES[1]) +
      grey(stops[1]!) +
      grey(stops[2]!) +
      ink(strokes(stroke([25, 76], [43, 76], 0.3), stroke([57, 76], [75, 76], -0.3)), 3.6) +
      ink(stops.join(""), 3.6) +
      ink(strokes(through(back), arrowhead(b, Math.atan2(b[1] - a[1], b[0] - a[0]), 12))),
    { seed: 17 },
  );
}

/** The bridge: a window, and a pointer in it. */
function bridge(): string {
  const pane = tile(8, 14, 84, 68, 8, { seed: 5, wobble: 0.6 });
  const pointer = poly(
    [
      [50, 40],
      [50, 70],
      [57, 63],
      [63, 75],
      [68, 73],
      [62, 61],
      [72, 61],
    ],
    { wobble: 0.4, seed: 9 },
  );
  const dots = [17, 25, 33].map((x, i) => blob(x, 22.5, 2.2, 2.2, { seed: 20 + i, wobble: 0.3 })).join("");
  return pen(
    [0, 0, 100, 100],
    grey(pane) +
      wash(pointer, BLUES[1]) +
      ink(pane) +
      ink(stroke([8, 31], [92, 31], 0.6)) +
      `<path class="dot" d="${dots}"/>` +
      ink(pointer, 3.6),
    { seed: 19 },
  );
}

/** A memory that grows: a notebook with a ribbon in it. */
function notebook(): string {
  const cover = tile(20, 10, 60, 80, 6, { seed: 7, wobble: 0.6 });
  const ribbon = poly(
    [
      [62, 10],
      [71, 10],
      [71, 30],
      [66.5, 25],
      [62, 30],
    ],
    { wobble: 0.3, seed: 2 },
  );
  const lines = strokes(
    stroke([40, 34], [70, 34], 0.5),
    stroke([40, 46], [68, 46], -0.5),
    stroke([40, 58], [62, 58], 0.4),
  );
  return pen(
    [0, 0, 100, 100],
    wash(cover, BLUES[0]) +
      wash(ribbon, BLUES[2]) +
      ink(cover) +
      ink(stroke([31, 10], [31, 90], 0.6)) +
      ink(lines, 3.4) +
      ink(ribbon, 3.4),
    { seed: 23 },
  );
}

/** Each feature's doodle, by the feature it stands for on the website. */
export const FEATURE_DOODLES = { folder, harnesses, queue, rewind, bridge, notebook } as const;
