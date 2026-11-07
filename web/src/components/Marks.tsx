import { type CSSProperties, type ReactNode, useId } from "react";
import { arc, arcPoints, blob, poly, type Pt, shaker, stroke, strokes, through, tile } from "../lib/doodle";
import type { Lab, MarkPick, ProjectIconName } from "../lib/marks";

/**
 * The marks over an empty chat: whoever made the model the chat runs on,
 * doodled — the lab's mark × its product's, as if in felt-tip in the margin
 * of a notebook. The outline is the theme's ink (currentColor); the brand
 * colours are flat fills laid a hair off it, the way a cheap print
 * misregisters; a turbulence filter shakes every line a little.
 *
 * Every mark is drawn on the same 100×100 page with the same pen, so any
 * two sit together as one set. Which pair a chat gets is lib/marks.ts.
 */

/* ── the pen ─────────────────────────────────────────────────────── */

/** The pen's width, in the page's units (a mark is 98px across 112). */
const INK = 4.2;

type Draw = (id: string) => ReactNode;

function Doodle({
  label,
  seed,
  tilt,
  children,
}: {
  label: string;
  seed: number;
  tilt: number;
  children: Draw;
}) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg
      className="mark"
      viewBox="-6 -6 112 112"
      aria-hidden
      data-mark={label}
      style={{ "--tilt": `${tilt}deg` } as CSSProperties}
    >
      <defs>
        <filter id={`${id}-w`} filterUnits="userSpaceOnUse" x="-12" y="-12" width="124" height="124">
          <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="2" seed={seed} result="n" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="n"
            scale="2.4"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
      <g filter={`url(#${id}-w)`}>{children(id)}</g>
    </svg>
  );
}

/**
 * What is drawn on a fill — an eye, a mouth — rather than round it: the
 * fill is the brand's colour whatever the theme, so these stay dark on it
 * rather than following the theme's ink into white on white.
 */
const FEATURE = "#1d1813";

/** A plain line in the pen — the theme's ink, or `color` for a feature. */
const Line = ({ d, width = INK, color }: { d: string; width?: number; color?: string }) => (
  <path
    className="ink"
    d={d}
    style={{ ...(width === INK ? {} : { strokeWidth: width }), ...(color ? { stroke: color } : {}) }}
  />
);

/** A flat fill, laid a hair off the lines. */
const Wash = ({ d, fill, opacity }: { d: string; fill: string; opacity?: number }) => (
  <path className="wash" d={d} fill={fill} {...(opacity === undefined ? {} : { opacity })} />
);

/**
 * A fat stroke, coloured, with the pen run round the outside of it — one
 * outline for everything in `d`, however its strokes cross, since the pen
 * round the lot is masked by the lot.
 */
function Band({
  id,
  d,
  width,
  color,
  cap = "round",
}: {
  id: string;
  d: string;
  width: number;
  color?: string;
  cap?: "round" | "butt";
}) {
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x="-30" y="-30" width="160" height="160">
        <rect x="-30" y="-30" width="160" height="160" fill="#fff" />
        <path
          d={d}
          fill="none"
          stroke="#000"
          strokeWidth={width}
          strokeLinecap={cap}
          strokeLinejoin="round"
        />
      </mask>
      {color && (
        <path
          className="wash"
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={width}
          strokeLinecap={cap}
          strokeLinejoin="round"
        />
      )}
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={width + INK * 2}
        strokeLinecap={cap}
        strokeLinejoin="round"
        mask={`url(#${id})`}
      />
    </>
  );
}

/**
 * Filled shapes, coloured, with one pen line round the outside of them all —
 * where two overlap, no line runs across the join.
 */
function Shapes({ id, parts }: { id: string; parts: Array<{ d: string; fill: string }> }) {
  return (
    <>
      <mask id={id} maskUnits="userSpaceOnUse" x="-30" y="-30" width="160" height="160">
        <rect x="-30" y="-30" width="160" height="160" fill="#fff" />
        {parts.map((p, i) => (
          <path key={i} d={p.d} fill="#000" />
        ))}
      </mask>
      {parts.map((p, i) => (
        <Wash key={i} d={p.d} fill={p.fill} />
      ))}
      {parts.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke="currentColor"
          strokeWidth={INK * 2}
          strokeLinejoin="round"
          mask={`url(#${id})`}
        />
      ))}
    </>
  );
}

/** A soft grey marker, for the brands that are only black. */
const GREY = "currentColor";
const GREY_WASH = 0.2;

/* ── Anthropic × Claude ──────────────────────────────────────────── */

/** Claude's spark: a dozen rays, each its own length, all from one middle. */
const CLAUDE_RAYS = (() => {
  const shake = shaker(7);
  const parts: string[] = [];
  for (let i = 0; i < 12; i++) {
    const angle = ((i * 30 + 8 + shake(6)) * Math.PI) / 180;
    const length = 34 + ((i * 5) % 3) * 3.5 + shake(2.5);
    const tip: Pt = [50 + Math.cos(angle) * length, 50 + Math.sin(angle) * length];
    parts.push(stroke([50, 50], tip, shake(1.6)));
  }
  return strokes(...parts);
})();

export const Claude = () => (
  <Doodle label="Claude" seed={3} tilt={4}>
    {(id) => <Band id={`${id}-r`} d={CLAUDE_RAYS} width={8.5} color="#D97757" />}
  </Doodle>
);

/** Anthropic's "A\": an A of two slabs and a bar, and a slash beside it. */
const ANTHROPIC_A = strokes(
  stroke([13, 84], [33, 17], 0.6),
  stroke([33, 17], [53, 84], -0.5),
  stroke([23, 60], [44, 60], 0.4),
  stroke([58, 17], [80, 84], 0.7),
);

export const Anthropic = () => (
  <Doodle label="Anthropic" seed={11} tilt={-5}>
    {(id) => <Band id={`${id}-a`} d={ANTHROPIC_A} width={10.5} color="#D4A27F" />}
  </Doodle>
);

/* ── OpenAI × ChatGPT ────────────────────────────────────────────── */

/**
 * OpenAI's blossom, as a marker draws it: six hooks round a little hexagon,
 * each turned 60° from the last. A hook runs up one side of the hexagon,
 * turns 60°, runs straight into a lobe and round it — and at both ends
 * slips under the hooks beside it, which is the weave: here, a gap.
 *
 * Worked out on the logo's own 24-unit grid (the knot 22.4 across, hooks
 * 1.3 thick, lobes of radius 5 whose centres sit 6.1 out); `radius` scales
 * it to the page.
 */
function blossom(cx: number, cy: number, radius: number, seed: number): string {
  const s = radius / 11.2;
  const shake = shaker(seed);
  const deg = Math.PI / 180;
  const hook: Pt[] = [
    [-3.15, 0.2],
    [-3.15, -2.6],
    [-3.15, -4.7],
    [-2.5, -5.78],
    [-0.55, -6.9],
    [2.05, -8.4],
  ];
  for (let a = 256; a < 366; a += 16)
    hook.push([4.55 + 5 * Math.cos(a * deg), -4.07 + 5 * Math.sin(a * deg)]);
  hook.push([4.55 + 5 * Math.cos(6 * deg), -4.07 + 5 * Math.sin(6 * deg)]);
  const parts: string[] = [];
  for (let k = 0; k < 6; k++) {
    const c = Math.cos(k * 60 * deg);
    const n = Math.sin(k * 60 * deg);
    parts.push(
      through(
        hook.map(([x, y]): Pt => [
          cx + (x * c - y * n) * s + shake(0.3),
          cy + (x * n + y * c) * s + shake(0.3),
        ]),
      ),
    );
  }
  return strokes(...parts);
}

const BLOSSOM = blossom(50, 50, 43, 5);

export const OpenAI = () => (
  <Doodle label="OpenAI" seed={17} tilt={-4}>
    {() => (
      <>
        <path
          className="wash knot"
          d={BLOSSOM}
          stroke="currentColor"
          opacity={GREY_WASH}
          style={{ strokeWidth: 5.4 }}
        />
        <Line d={BLOSSOM} width={5.2} />
      </>
    )}
  </Doodle>
);

const CHATGPT_TILE = tile(8, 8, 84, 84, 21, { seed: 4, wobble: 0.55 });
const SMALL_BLOSSOM = blossom(50, 50, 29, 9);

export const ChatGPT = () => (
  <Doodle label="ChatGPT" seed={23} tilt={5}>
    {() => (
      <>
        <Wash d={CHATGPT_TILE} fill="#10A37F" />
        <path className="wash knot" d={SMALL_BLOSSOM} stroke="#fff" style={{ strokeWidth: 3.6 }} />
        <Line d={CHATGPT_TILE} />
      </>
    )}
  </Doodle>
);

/* ── Google × Gemini ─────────────────────────────────────────────── */

const G_RED = arc(50, 50, 29, -42, -112, { seed: 1, wobble: 0.5 });
const G_YELLOW = arc(50, 50, 29, -154, -60, { seed: 2, wobble: 0.5 });
const G_GREEN = arc(50, 50, 29, -214, -110, { seed: 3, wobble: 0.5 });
const G_BLUE = strokes(arc(50, 50, 29, -324, -36, { seed: 4, wobble: 0.3 }), stroke([79, 50], [52, 50], 0.4));
const G_WHOLE = strokes(
  arc(50, 50, 29, -42, -318, { seed: 5, wobble: 0.5 }),
  stroke([79, 50], [52, 50], 0.4),
);

export const Google = () => (
  <Doodle label="Google" seed={29} tilt={-3}>
    {(id) => (
      <>
        {[
          [G_RED, "#EA4335"],
          [G_YELLOW, "#FBBC05"],
          [G_GREEN, "#34A853"],
          [G_BLUE, "#4285F4"],
        ].map(([d, color]) => (
          <path
            key={color}
            className="wash"
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={14}
            strokeLinecap="butt"
            strokeLinejoin="round"
          />
        ))}
        <Band id={`${id}-g`} d={G_WHOLE} width={14} />
      </>
    )}
  </Doodle>
);

/**
 * Gemini's sparkle: four sharp points, each side a circle's arc bowed in
 * toward the middle (its radius 1.19 of the sparkle's, as the logo has it).
 */
const SPARKLE = (() => {
  const shake = shaker(21);
  const r = 45;
  const bend = r * 1.19;
  const tips: Pt[] = [0, 1, 2, 3].map((i) => {
    const a = ((i * 90 - 90) * Math.PI) / 180;
    return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r];
  });
  let d = "";
  tips.forEach((p, i) => {
    const q = tips[(i + 1) % 4]!;
    const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const out = Math.hypot(mid[0] - 50, mid[1] - 50);
    const half = Math.hypot(q[0] - p[0], q[1] - p[1]) / 2;
    const reach = out + Math.sqrt(bend * bend - half * half);
    const o: Pt = [50 + ((mid[0] - 50) / out) * reach, 50 + ((mid[1] - 50) / out) * reach];
    const from = Math.atan2(p[1] - o[1], p[0] - o[0]);
    let to = Math.atan2(q[1] - o[1], q[0] - o[0]);
    if (to - from > Math.PI) to -= Math.PI * 2;
    if (from - to > Math.PI) to += Math.PI * 2;
    const points = Array.from({ length: 7 }, (_, k): Pt => {
      const t = from + ((to - from) * k) / 6;
      const nudge = k === 0 || k === 6 ? 0 : shake(0.7);
      return [o[0] + Math.cos(t) * (bend + nudge), o[1] + Math.sin(t) * (bend + nudge)];
    });
    const side = through(points);
    d += i === 0 ? side : side.replace(/^M[^C]*/, "");
  });
  return `${d}Z`;
})();

export const Gemini = () => (
  <Doodle label="Gemini" seed={31} tilt={6}>
    {(id) => (
      <>
        <defs>
          <linearGradient id={`${id}-g`} x1="0.1" y1="0.9" x2="0.9" y2="0.1">
            <stop offset="0.1" stopColor="#3D8BF6" />
            <stop offset="0.55" stopColor="#9A6CF0" />
            <stop offset="0.95" stopColor="#F0698C" />
          </linearGradient>
        </defs>
        <Wash d={SPARKLE} fill={`url(#${id}-g)`} />
        <Line d={SPARKLE} />
      </>
    )}
  </Doodle>
);

/* ── xAI × Grok ──────────────────────────────────────────────────── */

export const XAI = () => (
  <Doodle label="xAI" seed={37} tilt={-6}>
    {(id) => (
      <>
        <Band
          id={`${id}-x`}
          d={strokes(stroke([20, 16], [70, 84], 0.8), stroke([20, 84], [38, 60], -0.4))}
          width={10}
          color={GREY}
        />
        <Line d={stroke([58, 44], [84, 10], 0.6)} width={5} />
      </>
    )}
  </Doodle>
);

export const Grok = () => (
  <Doodle label="Grok" seed={41} tilt={4}>
    {() => (
      <>
        <Wash d={blob(50, 50, 27, 27, { seed: 6 })} fill={GREY} opacity={GREY_WASH} />
        <Line d={arc(50, 50, 32, -28, 142, { seed: 3 })} width={6} />
        <Line d={arc(50, 50, 32, 158, 110, { seed: 4 })} width={6} />
        <Line d={stroke([16, 88], [86, 12], 1)} width={6} />
      </>
    )}
  </Doodle>
);

/* ── Moonshot × Kimi ─────────────────────────────────────────────── */

/** Where two circles cross — for the crescent. */
function crossing(a: [number, number, number], b: [number, number, number]): [Pt, Pt] {
  const [x0, y0, r0] = a;
  const [x1, y1, r1] = b;
  const d = Math.hypot(x1 - x0, y1 - y0);
  const l = (r0 * r0 - r1 * r1 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r0 * r0 - l * l));
  const mx = x0 + (l * (x1 - x0)) / d;
  const my = y0 + (l * (y1 - y0)) / d;
  return [
    [mx + (h * (y1 - y0)) / d, my - (h * (x1 - x0)) / d],
    [mx - (h * (y1 - y0)) / d, my + (h * (x1 - x0)) / d],
  ];
}

const MOON = (() => {
  const [p, q] = crossing([46, 54, 34], [62, 40, 28]);
  const f = (n: number) => Math.round(n * 10) / 10;
  return `M${f(p[0])} ${f(p[1])}A34 34 0 1 0 ${f(q[0])} ${f(q[1])}A28 28 0 0 1 ${f(p[0])} ${f(p[1])}Z`;
})();

const TWINKLE = (x: number, y: number, s: number) =>
  through(
    [
      [x, y - s],
      [x + s * 0.18, y - s * 0.18],
      [x + s, y],
      [x + s * 0.18, y + s * 0.18],
      [x, y + s],
      [x - s * 0.18, y + s * 0.18],
      [x - s, y],
      [x - s * 0.18, y - s * 0.18],
    ],
    true,
  );

export const Moonshot = () => (
  <Doodle label="Moonshot AI" seed={43} tilt={-4}>
    {() => (
      <>
        <Wash d={MOON} fill="#F4D35E" />
        <Line d={MOON} />
        <Line d={TWINKLE(78, 22, 9)} width={3.4} />
      </>
    )}
  </Doodle>
);

const KIMI_TILE = tile(10, 10, 80, 80, 20, { seed: 8, wobble: 0.55 });

export const Kimi = () => (
  <Doodle label="Kimi" seed={47} tilt={5}>
    {() => (
      <>
        <Wash d={KIMI_TILE} fill="#18181B" />
        <path
          className="wash"
          d={strokes(
            stroke([36, 30], [36, 70], 0.3),
            stroke([61, 30], [38, 52], -0.4),
            stroke([44, 47], [63, 70], 0.4),
          )}
          fill="none"
          stroke="#fff"
          strokeWidth={8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle className="wash" cx={71} cy={27} r={5.5} fill="#2F7BFF" />
        <Line d={KIMI_TILE} />
      </>
    )}
  </Doodle>
);

/* ── Alibaba × Qwen ──────────────────────────────────────────────── */

const ALIBABA = strokes(
  through([
    [40, 24],
    [22, 24],
    [16, 30],
    [16, 70],
    [22, 76],
    [40, 76],
  ]),
  through([
    [60, 24],
    [78, 24],
    [84, 30],
    [84, 70],
    [78, 76],
    [60, 76],
  ]),
  stroke([38, 50], [62, 50], 0.3),
);

export const Alibaba = () => (
  <Doodle label="Alibaba Cloud" seed={53} tilt={-5}>
    {(id) => <Band id={`${id}-b`} d={ALIBABA} width={10} color="#FF6A00" />}
  </Doodle>
);

/**
 * Qwen's hexagon: three bent blades chasing each other round it — each
 * runs two of its sides and turns in toward the middle, leaving a gap
 * before the next.
 */
const QWEN = (() => {
  const shake = shaker(12);
  const corner = (i: number, r = 34): Pt => {
    const a = ((i * 60 - 90) * Math.PI) / 180;
    return [50 + Math.cos(a) * r + shake(0.5), 50 + Math.sin(a) * r + shake(0.5)];
  };
  const toward = (p: Pt, q: Pt, t: number): Pt => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
  const parts: string[] = [];
  for (let i = 0; i < 6; i += 2) {
    parts.push(
      through([
        toward(corner(i), corner(i + 1), 0.3),
        corner(i + 1),
        corner(i + 2),
        toward(corner(i + 2), [50, 50], 0.55),
      ]),
    );
  }
  return strokes(...parts);
})();

export const Qwen = () => (
  <Doodle label="Qwen" seed={59} tilt={5}>
    {(id) => <Band id={`${id}-q`} d={QWEN} width={11} color="#615CED" />}
  </Doodle>
);

/* ── Z.ai × GLM ──────────────────────────────────────────────────── */

const ZAI_TILE = tile(10, 10, 80, 80, 20, { seed: 13, wobble: 0.55 });

export const Zai = () => (
  <Doodle label="Z.ai" seed={61} tilt={-4}>
    {() => (
      <>
        <Wash d={ZAI_TILE} fill="#fff" />
        <path
          className="wash"
          d={strokes(
            stroke([31, 32], [69, 31], 0.4),
            stroke([69, 31], [31, 69], -0.5),
            stroke([31, 69], [70, 68], 0.4),
          )}
          fill="none"
          stroke="#111"
          strokeWidth={9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line d={ZAI_TILE} />
      </>
    )}
  </Doodle>
);

/* ── Mistral × Le Chat ───────────────────────────────────────────── */

const RAINBOW = ["#FFD800", "#FFAF00", "#FF8205", "#FA500F", "#E10500"];

/**
 * Blocks on a grid, a row to a colour. Each block squared off by hand and
 * outlined on its own — or, `whole`, one line round the lot, for a
 * silhouette that should read before its pixels do.
 */
function Blocks({
  id,
  rows,
  size = 15,
  whole = false,
  eyes = [],
}: {
  id: string;
  rows: string[];
  size?: number;
  whole?: boolean;
  eyes?: Pt[];
}) {
  const cols = Math.max(...rows.map((r) => r.length));
  const x0 = 50 - (cols * size) / 2;
  const y0 = 50 - (rows.length * size) / 2;
  const cells: Array<{ d: string; fill: string }> = [];
  rows.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c !== "#") return;
      // one line round the lot needs blocks that meet: a hair over, no shake
      const grow = whole ? 0.5 : 0;
      const px = x0 + x * size - grow;
      const py = y0 + y * size - grow;
      const side = size + grow * 2;
      cells.push({
        d: poly(
          [
            [px, py],
            [px + side, py],
            [px + side, py + side],
            [px, py + side],
          ],
          { seed: x * 7 + y * 13 + 1, wobble: whole ? 0 : 0.7 },
        ),
        fill: RAINBOW[Math.round((y * (RAINBOW.length - 1)) / Math.max(1, rows.length - 1))]!,
      });
    }),
  );
  return (
    <>
      {whole ? (
        <Shapes id={id} parts={cells} />
      ) : (
        <>
          {cells.map((c, i) => (
            <Wash key={i} d={c.d} fill={c.fill} />
          ))}
          {cells.map((c, i) => (
            <Line key={i} d={c.d} width={3.2} />
          ))}
        </>
      )}
      {eyes.map(([ex, ey], i) => (
        <rect
          key={i}
          x={x0 + ex * size - size * 0.32}
          y={y0 + ey * size - size * 0.4}
          width={size * 0.64}
          height={size * 0.8}
          rx={size * 0.28}
          fill={FEATURE}
        />
      ))}
    </>
  );
}

export const Mistral = () => (
  <Doodle label="Mistral AI" seed={67} tilt={-5}>
    {(id) => <Blocks id={`${id}-b`} rows={["#...#", "##.##", "#####", "#.#.#", "#...#"]} />}
  </Doodle>
);

/** Le Chat: the cat, in Mistral's blocks and colours. */
export const LeChat = () => (
  <Doodle label="Le Chat" seed={71} tilt={5}>
    {(id) => (
      <>
        <Blocks
          id={`${id}-b`}
          rows={["#....#", "##..##", "######", "######", "######", ".####."]}
          size={13}
          whole
          eyes={[
            [1.5, 3.4],
            [4.5, 3.4],
          ]}
        />
        <path
          d="M43.5 70q3.2 3.4 6.5 0q3.3 3.4 6.5 0"
          fill="none"
          stroke={FEATURE}
          strokeWidth={2.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Line d={strokes(stroke([1, 59], [13, 58], 0.4), stroke([1, 68], [13, 66], -0.4))} width={2.8} />
        <Line d={strokes(stroke([87, 58], [99, 59], -0.4), stroke([87, 66], [99, 68], 0.4))} width={2.8} />
      </>
    )}
  </Doodle>
);

/* ── Meta × Llama ────────────────────────────────────────────────── */

/** Meta's loop: an infinity sign drawn tall and round, one strand over
 *  the other where they cross. */
const loopAt = (t: number): Pt => [
  50 + 38 * Math.sin(t),
  50 - 23 * Math.sin(2 * t) * (1 - 0.12 * Math.cos(t)),
];
const INFINITY = through(
  Array.from({ length: 28 }, (_, i) => loopAt((i / 28) * Math.PI * 2)),
  true,
);
/** The strand on top at the crossing. */
const INFINITY_OVER = through(Array.from({ length: 5 }, (_, i) => loopAt(-0.32 + (i / 4) * 0.64)));

export const Meta = () => (
  <Doodle label="Meta" seed={73} tilt={-4}>
    {(id) => (
      <>
        <defs>
          <linearGradient id={`${id}-b`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#0064E0" />
            <stop offset="1" stopColor="#0082FB" />
          </linearGradient>
        </defs>
        <Band id={`${id}-m`} d={INFINITY} width={11} color={`url(#${id}-b)`} />
        <Band id={`${id}-o`} d={INFINITY_OVER} width={11} color={`url(#${id}-b)`} cap="butt" />
      </>
    )}
  </Doodle>
);

/** A llama in profile: long neck, banana ears, a fringe of wool, a blush. */
const LLAMA = through([
  [37, 94],
  [36, 64],
  [32, 46],
  [32, 32],
  [38, 24],
  [50, 21],
  [60, 23],
  [66, 30],
  [68, 40],
  [75, 47],
  [74, 56],
  [64, 59],
  [60, 66],
  [61, 94],
]);
const LLAMA_EARS = strokes(
  through([
    [38, 26],
    [31, 13],
    [33, 5],
    [42, 19],
  ]),
  through([
    [55, 22],
    [58, 9],
    [64, 4],
    [65, 21],
  ]),
);
/** The wool on its crown, in little scallops. */
const LLAMA_FRINGE = through([
  [36, 30],
  [39, 23],
  [44, 26],
  [47, 19],
  [52, 24],
  [56, 18],
  [60, 25],
  [64, 26],
]);

export const Llama = () => (
  <Doodle label="Llama" seed={79} tilt={5}>
    {() => (
      <>
        <Wash d={`${LLAMA}L37 94Z`} fill="#EDD9B7" />
        <circle className="wash" cx={58} cy={46} r={5} fill="#F2A7A0" />
        <Line d={LLAMA} />
        <Line d={LLAMA_EARS} />
        <Line d={LLAMA_FRINGE} width={3.4} color={FEATURE} />
        <circle cx={53} cy={37} r={3.4} fill={FEATURE} />
        <Line d={stroke([67, 53], [71, 53], 0.3)} width={3} color={FEATURE} />
        <Line
          d={through([
            [64, 43],
            [66, 45],
            [68, 44],
          ])}
          width={2.6}
          color={FEATURE}
        />
      </>
    )}
  </Doodle>
);

/* ── DeepSeek ────────────────────────────────────────────────────── */

const WHALE = through(
  [
    [10, 60],
    [16, 46],
    [30, 36],
    [48, 34],
    [64, 40],
    [74, 50],
    [80, 40],
    [84, 28],
    [94, 24],
    [90, 36],
    [96, 44],
    [84, 50],
    [80, 60],
    [66, 72],
    [44, 76],
    [24, 72],
  ],
  true,
);

export const DeepSeek = () => (
  <Doodle label="DeepSeek" seed={83} tilt={-5}>
    {() => (
      <>
        <Wash d={WHALE} fill="#4D6BFE" />
        <Line d={WHALE} />
        <circle cx={27} cy={52} r={3} fill={FEATURE} />
        <Line
          d={through([
            [16, 62],
            [24, 64],
            [32, 62],
          ])}
          width={3}
          color={FEATURE}
        />
      </>
    )}
  </Doodle>
);

/* ── MiniMax ─────────────────────────────────────────────────────── */

const WAVE = strokes(
  stroke([20, 42], [20, 58], 0.2),
  stroke([35, 26], [35, 74], -0.3),
  stroke([50, 14], [50, 86], 0.3),
  stroke([65, 30], [65, 70], -0.2),
  stroke([80, 40], [80, 60], 0.2),
);

export const MiniMax = () => (
  <Doodle label="MiniMax" seed={89} tilt={-4}>
    {(id) => (
      <>
        <defs>
          <linearGradient id={`${id}-p`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#E2167E" />
            <stop offset="1" stopColor="#FE603C" />
          </linearGradient>
        </defs>
        <Band id={`${id}-v`} d={WAVE} width={9} color={`url(#${id}-p)`} />
      </>
    )}
  </Doodle>
);

/* ── the harnesses, when no lab is known ─────────────────────────── */

export const OpenCode = () => (
  <Doodle label="OpenCode" seed={97} tilt={-5}>
    {(id) => (
      <>
        <Band
          id={`${id}-o`}
          d={poly(
            [
              [24, 20],
              [76, 20],
              [76, 80],
              [24, 80],
            ],
            { seed: 3, wobble: 0.8 },
          )}
          width={12}
          color="#CFCECD"
        />
        <Line d={stroke([40, 64], [60, 64], 0.2)} width={6} />
      </>
    )}
  </Doodle>
);

const GOOSE = [
  { d: blob(46, 72, 32, 16, { seed: 5 }), fill: "#fff" },
  {
    d: through(
      [
        [54, 70],
        [60, 50],
        [56, 36],
        [60, 26],
        [66, 34],
        [66, 52],
        [72, 66],
      ],
      true,
    ),
    fill: "#fff",
  },
  { d: blob(63, 28, 11, 10, { seed: 9 }), fill: "#fff" },
];

export const Goose = () => (
  <Doodle label="Goose" seed={101} tilt={5}>
    {(id) => (
      <>
        <Shapes id={`${id}-s`} parts={GOOSE} />
        <Wash
          d={through(
            [
              [72, 24],
              [88, 28],
              [72, 33],
            ],
            true,
          )}
          fill="#F39A2B"
        />
        <Line
          d={through([
            [73, 24],
            [88, 28],
            [73, 33],
          ])}
          width={3.4}
        />
        <circle cx={64} cy={25} r={2.6} fill={FEATURE} />
        <Line
          d={through([
            [28, 70],
            [40, 64],
            [52, 70],
          ])}
          width={3}
          color={FEATURE}
        />
      </>
    )}
  </Doodle>
);

/* ── the pair ────────────────────────────────────────────────────── */

/** The "×" between them, drawn in two strokes. */
function Times() {
  const id = `x${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className="mark-x" viewBox="0 0 40 40" aria-hidden>
      <defs>
        <filter id={id} filterUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed={5} result="n" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="n"
            scale="1.6"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>
      <path
        className="ink"
        filter={`url(#${id})`}
        d="M10.5 10.5Q19 18.5 30 31M29.5 9Q21 17 10 30.5"
        style={{ strokeWidth: 4.2 }}
      />
    </svg>
  );
}

/** A name lettered by hand, in the pen, over a smudge of the brand. */
export function Letters({ text, wash = "var(--ink-faint)" }: { text: string; wash?: string }) {
  return (
    <span className="mark-letters" style={{ "--wash": wash } as CSSProperties}>
      {text}
    </span>
  );
}

interface Pair {
  lab: string;
  product: string;
  Lab: () => ReactNode;
  Product: () => ReactNode;
}

const lettered = (text: string, wash: string) => () => <Letters text={text} wash={wash} />;

const PAIRS: Record<Lab, Pair> = {
  anthropic: { lab: "Anthropic", product: "Claude", Lab: Anthropic, Product: Claude },
  openai: { lab: "OpenAI", product: "ChatGPT", Lab: OpenAI, Product: ChatGPT },
  google: { lab: "Google", product: "Gemini", Lab: Google, Product: Gemini },
  xai: { lab: "xAI", product: "Grok", Lab: XAI, Product: Grok },
  moonshot: { lab: "Moonshot AI", product: "Kimi", Lab: Moonshot, Product: Kimi },
  alibaba: { lab: "Alibaba", product: "Qwen", Lab: Alibaba, Product: Qwen },
  zhipu: { lab: "Z.ai", product: "GLM", Lab: Zai, Product: lettered("GLM", "#3A6CF4") },
  mistral: { lab: "Mistral AI", product: "Le Chat", Lab: Mistral, Product: LeChat },
  meta: { lab: "Meta", product: "Llama", Lab: Meta, Product: Llama },
  deepseek: { lab: "DeepSeek", product: "DeepSeek", Lab: DeepSeek, Product: lettered("DeepSeek", "#4D6BFE") },
  minimax: { lab: "MiniMax", product: "MiniMax", Lab: MiniMax, Product: lettered("MiniMax", "#F0356B") },
};

/** The harnesses with a mark of their own to stand in for an unknown lab. */
const HARNESS_MARKS: Record<string, { name: string; Mark: () => ReactNode }> = {
  opencode: { name: "OpenCode", Mark: OpenCode },
  goose: { name: "Goose", Mark: Goose },
};

/** The same name, near enough — "Goose" is goose's own default model. */
const same = (a: string, b: string) =>
  a.toLowerCase().replace(/[^a-z0-9]/g, "") === b.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A name worth lettering: short enough to read in one glance. */
const clip = (name: string) => (name.length > 22 ? `${name.slice(0, 21).trimEnd()}…` : name);

/**
 * The one mark a model wears in a list — the model pickers, Settings'
 * catalog: its product's, or its lab's where the product is only a name
 * (DeepSeek, GLM, MiniMax), or its harness's when no lab is known. Where
 * there is none, an empty box the same size, so the names still line up.
 */
const ICONS: Record<Lab, () => ReactNode> = {
  anthropic: Claude,
  openai: ChatGPT,
  google: Gemini,
  xai: Grok,
  moonshot: Kimi,
  alibaba: Qwen,
  zhipu: Zai,
  mistral: LeChat,
  meta: Llama,
  deepseek: DeepSeek,
  minimax: MiniMax,
};

export function ModelIcon({ pick }: { pick: MarkPick }) {
  const Mark = pick.lab ? ICONS[pick.lab] : HARNESS_MARKS[pick.harness]?.Mark;
  return <span className="model-icon">{Mark && <Mark />}</span>;
}

/** The lab's mark × its product's, for whatever `markFor` made of the model. */
export function MarkPair({ pick }: { pick: MarkPick }) {
  if (pick.lab) {
    const pair = PAIRS[pick.lab];
    const label = pair.lab === pair.product ? pair.lab : `${pair.lab} × ${pair.product}`;
    return (
      <div className="marks" role="img" aria-label={label} title={label}>
        <pair.Lab />
        <Times />
        <pair.Product />
      </div>
    );
  }
  const harness = HARNESS_MARKS[pick.harness];
  if (harness && same(pick.name, harness.name)) {
    return (
      <div className="marks" role="img" aria-label={harness.name} title={harness.name}>
        <harness.Mark />
      </div>
    );
  }
  return (
    <div className="marks" role="img" aria-label={pick.name} title={pick.name}>
      {harness && (
        <>
          <harness.Mark />
          <Times />
        </>
      )}
      <Letters text={clip(pick.name)} />
    </div>
  );
}

/* ── the composer's other pickers: permissions and effort ───────────
   Drawn with the same pen on the same page as the marks, ink only, a
   little heavier so they hold up at a menu row's size. */

const PICK_INK = 7.5;

const ASK_FIRST = strokes(
  through([[50, 14], [82, 22], [92, 42], [80, 60], [50, 68], [22, 60], [10, 42], [20, 22]], true),
  stroke([30, 62], [18, 88], 0.6),
  stroke([18, 88], [46, 67], -0.6),
  through([[38, 32], [50, 24], [62, 32], [52, 42], [50, 50]]),
  stroke([50, 58], [50.4, 58.6], 0),
);

const ACCEPT_EDITS = strokes(
  stroke([36, 66], [80, 22], 0.5),
  stroke([24, 54], [68, 10], -0.5),
  stroke([80, 22], [68, 10], 0.3),
  stroke([72, 30], [60, 18], 0.3),
  stroke([36, 66], [12, 78], 0.3),
  stroke([12, 78], [24, 54], 0.3),
  stroke([50, 78], [62, 90], 0.4),
  stroke([62, 90], [92, 58], -0.8),
);

const PLAN_MODE = strokes(
  stroke([20, 12], [80, 14], 0.8),
  stroke([80, 14], [82, 90], -0.8),
  stroke([82, 90], [18, 88], 0.8),
  stroke([18, 88], [20, 12], -0.8),
  stroke([34, 36], [68, 35], 0.6),
  stroke([34, 52], [66, 53], -0.6),
  stroke([34, 69], [54, 68], 0.5),
);

const BYPASS = strokes(
  stroke([60, 6], [24, 54], 0.4),
  stroke([24, 54], [50, 53], 0.3),
  stroke([50, 53], [36, 94], -0.4),
  stroke([36, 94], [78, 40], 0.4),
  stroke([78, 40], [52, 41], -0.3),
  stroke([52, 41], [60, 6], -0.4),
);

/** Effort as tally marks: one for low up to the struck five for max. */
const tally = (n: number): string => {
  const marks: string[] = [];
  for (let i = 0; i < Math.min(n, 4); i++) {
    const x = 22 + i * 18;
    marks.push(stroke([x, 18 + (i % 2) * 3], [x + 2, 84 - (i % 2) * 2], i % 2 ? -1.6 : 1.6));
  }
  if (n >= 5) marks.push(stroke([8, 74], [94, 30], 2));
  return strokes(...marks);
};

const PICK_ART: Record<string, { d: string; seed: number; tilt: number }> = {
  "permission:default": { d: ASK_FIRST, seed: 21, tilt: -4 },
  "permission:acceptEdits": { d: ACCEPT_EDITS, seed: 22, tilt: 3 },
  "permission:plan": { d: PLAN_MODE, seed: 23, tilt: -3 },
  "permission:bypassPermissions": { d: BYPASS, seed: 24, tilt: 5 },
  "effort:minimal": { d: tally(1), seed: 30, tilt: -3 },
  "effort:low": { d: tally(1), seed: 31, tilt: -3 },
  "effort:medium": { d: tally(2), seed: 32, tilt: 2 },
  "effort:high": { d: tally(3), seed: 33, tilt: -2 },
  "effort:xhigh": { d: tally(4), seed: 34, tilt: 3 },
  "effort:max": { d: tally(5), seed: 35, tilt: -2 },
};

/** A permission mode's or an effort level's own drawing, sized like a
 *  model's mark beside its name; nothing for a value it has no drawing for. */
export function PickIcon({ kind, value }: { kind: "permission" | "effort"; value: string }) {
  const art = PICK_ART[`${kind}:${value}`];
  if (!art) return null;
  return (
    <span className="model-icon">
      <Doodle label={value} seed={art.seed} tilt={art.tilt}>
        {() => <Line d={art.d} width={PICK_INK} />}
      </Doodle>
    </span>
  );
}

/* ── project icons ───────────────────────────────────────────────────
   A small drawing for each project's sidebar row, from the same pen on the
   same page: things from a notebook margin. A project gets one from its id
   until the user picks another (the row's right-click). */

/** Straight strokes from point to point, each with a slight bow. */
const path = (points: Pt[], bow = 0.5, closed = false): string => {
  const parts: string[] = [];
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) {
    parts.push(stroke(points[i]!, points[(i + 1) % points.length]!, i % 2 ? -bow : bow));
  }
  return strokes(...parts);
};

/** Points round a ring, every other one pulled in: a star, a sun's rays. */
const ring = (n: number, outer: number, inner: number, turn = -90): Pt[] =>
  Array.from({ length: n * 2 }, (_, i) => {
    const a = ((turn + (i * 180) / n) * Math.PI) / 180;
    const r = i % 2 ? inner : outer;
    return [50 + Math.cos(a) * r, 50 + Math.sin(a) * r] as Pt;
  });

/** A dot: a tiny loop the pen fills in by its own width. */
const dot = (x: number, y: number, r = 2.5) => blob(x, y, r, r, { wobble: 0.2, seed: Math.round(x + y) });

const sunRays = Array.from({ length: 8 }, (_, i) => {
  const a = (i * 45 * Math.PI) / 180;
  return stroke([50 + Math.cos(a) * 29, 50 + Math.sin(a) * 29], [50 + Math.cos(a) * 42, 50 + Math.sin(a) * 42], 0.3);
});

/** A ring round a planet, tilted, only the half that passes in front. */
const planetRing = (() => {
  const tilt = (-18 * Math.PI) / 180;
  const points: Pt[] = [];
  for (let d = -20; d <= 200; d += 20) {
    const a = (d * Math.PI) / 180;
    const x = Math.cos(a) * 45;
    const y = Math.sin(a) * 12;
    points.push([50 + x * Math.cos(tilt) - y * Math.sin(tilt), 52 + x * Math.sin(tilt) + y * Math.cos(tilt)]);
  }
  return through(points);
})();

const snailShell = (() => {
  const points: Pt[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    const a = ((90 + t * 660) * Math.PI) / 180;
    const r = 30 * (1 - t * 0.85);
    points.push([44 + Math.cos(a) * r, 50 + Math.sin(a) * r]);
  }
  return through(points);
})();

const petals = strokes(
  ...Array.from({ length: 5 }, (_, i) => {
    const a = ((-90 + i * 72) * Math.PI) / 180;
    return blob(50 + Math.cos(a) * 23, 50 + Math.sin(a) * 23, 13, 13, { wobble: 0.6, seed: 40 + i });
  }),
  blob(50, 50, 8, 8, { wobble: 0.3, seed: 46 }),
);

const cloud = through(
  [
    ...arcPoints(30, 60, 14, 14, 100, 160, { wobble: 0.4, seed: 51 }),
    ...arcPoints(52, 44, 20, 20, 200, 140, { wobble: 0.4, seed: 52 }),
    ...arcPoints(74, 58, 16, 16, 250, 200, { wobble: 0.4, seed: 53 }),
  ],
  true,
);

/** Every project icon, by the name a person would call it. */
const PROJECT_ART: Record<ProjectIconName, string> = {
  moon: strokes(arc(50, 50, 38, 60, 240, { wobble: 0.5, seed: 61 }), arc(90, 50, 39, 122, 116, { wobble: 0.4, seed: 62 })),
  star: path(ring(5, 42, 18), 0.6, true),
  leaf: strokes(
    through([[20, 82], [26, 44], [56, 20], [84, 16]]),
    through([[84, 16], [80, 48], [54, 76], [20, 82]]),
    stroke([20, 82], [64, 36], 2),
    stroke([20, 82], [10, 92], 0.4),
  ),
  mushroom: strokes(
    through([[10, 54], [20, 26], [50, 12], [80, 26], [90, 54]]),
    stroke([90, 54], [10, 54], -2),
    through([[38, 54], [35, 72], [40, 88]]),
    through([[62, 54], [65, 72], [60, 88]]),
    stroke([40, 88], [60, 88], 1),
    dot(38, 36, 4),
    dot(62, 32, 3),
  ),
  fish: strokes(
    through([[16, 50], [38, 30], [64, 34], [78, 50], [64, 66], [38, 70]], true),
    path([[78, 50], [94, 32], [92, 68], [78, 50]], 0.8),
    dot(32, 46),
  ),
  cat: strokes(
    path([[18, 64], [22, 16], [40, 32], [60, 32], [78, 16], [82, 64]], 0.8),
    through([[82, 64], [70, 84], [50, 90], [30, 84], [18, 64]]),
    dot(37, 56, 3),
    dot(63, 56, 3),
    path([[46, 68], [50, 72], [54, 68]], 0.3),
  ),
  cloud,
  key: strokes(
    blob(28, 50, 16, 16, { wobble: 0.6, seed: 71 }),
    stroke([44, 50], [92, 50], 0.6),
    stroke([78, 50], [78, 66], 0.3),
    stroke([90, 50], [90, 62], 0.3),
  ),
  flame: strokes(
    through([[50, 6], [62, 30], [78, 52], [74, 76], [50, 92], [26, 76], [22, 54], [36, 34], [44, 44], [50, 6]]),
    through([[50, 50], [60, 64], [58, 78], [50, 84], [42, 78], [40, 64], [50, 50]]),
  ),
  mountain: strokes(
    path([[6, 86], [38, 24], [58, 62]], 0.6),
    path([[50, 46], [68, 30], [94, 86]], 0.6),
    stroke([94, 86], [6, 86], 0.8),
    through([[29, 42], [35, 48], [41, 42], [47, 46]]),
  ),
  cup: strokes(
    stroke([16, 38], [22, 86], 0.6),
    through([[22, 86], [42, 92], [62, 86]]),
    stroke([62, 86], [68, 38], 0.6),
    stroke([68, 38], [16, 38], -0.8),
    arc(70, 60, 13, -70, 160, { wobble: 0.4, seed: 81 }),
    through([[34, 28], [30, 18], [36, 8]]),
    through([[50, 28], [46, 18], [52, 8]]),
  ),
  sun: strokes(blob(50, 50, 19, 19, { wobble: 0.6, seed: 91 }), ...sunRays),
  house: strokes(
    path([[10, 50], [50, 12], [90, 50]], 0.5),
    stroke([22, 40], [22, 88], 0.6),
    stroke([78, 40], [78, 88], -0.6),
    stroke([22, 88], [78, 88], 0.6),
    path([[42, 88], [42, 64], [58, 64], [58, 88]], 0.3),
  ),
  pine: strokes(
    path(
      [[50, 6], [30, 34], [40, 34], [20, 58], [34, 58], [12, 80], [88, 80], [66, 58], [80, 58], [60, 34], [70, 34]],
      0.4,
      true,
    ),
    stroke([44, 80], [44, 94], 0.2),
    stroke([56, 80], [56, 94], -0.2),
  ),
  anchor: strokes(
    blob(50, 14, 8, 8, { wobble: 0.3, seed: 101 }),
    stroke([50, 22], [50, 90], 0.4),
    stroke([32, 36], [68, 36], 0.4),
    arc(50, 58, 33, 20, 140, { wobble: 0.6, seed: 102 }),
    stroke([12, 62], [19, 72], 0.2),
    stroke([88, 62], [81, 72], 0.2),
  ),
  heart: strokes(
    through([[50, 30], [40, 14], [22, 14], [10, 32], [18, 54], [50, 88]]),
    through([[50, 88], [82, 54], [90, 32], [78, 14], [60, 14], [50, 30]]),
  ),
  flower: petals,
  rocket: strokes(
    through([[50, 6], [64, 24], [66, 64], [34, 64], [36, 24], [50, 6]]),
    blob(50, 36, 7, 7, { wobble: 0.3, seed: 111 }),
    path([[34, 50], [20, 74], [36, 68]], 0.4),
    path([[66, 50], [80, 74], [64, 68]], 0.4),
    through([[42, 70], [50, 94], [58, 70]]),
  ),
  umbrella: strokes(
    arc(50, 52, 40, 180, 180, { wobble: 0.6, seed: 121 }),
    through([[10, 52], [23, 44], [36, 52], [50, 44], [64, 52], [77, 44], [90, 52]]),
    stroke([50, 48], [50, 84], 0.3),
    arc(42, 84, 8, 0, 180, { wobble: 0.2, seed: 122 }),
    stroke([50, 12], [50, 5], 0.2),
  ),
  bell: strokes(
    through([[18, 74], [28, 62], [30, 36], [50, 16], [70, 36], [72, 62], [82, 74]]),
    stroke([82, 74], [18, 74], 0.8),
    dot(50, 84, 6),
    stroke([50, 16], [50, 7], 0.2),
  ),
  planet: strokes(blob(50, 52, 24, 24, { wobble: 0.6, seed: 131 }), planetRing),
  ghost: strokes(
    through([[20, 86], [18, 40], [32, 16], [50, 10], [68, 16], [82, 40], [80, 86]]),
    path([[80, 86], [69, 76], [58, 86], [50, 76], [42, 86], [31, 76], [20, 86]], 0.3),
    dot(40, 42, 4),
    dot(60, 42, 4),
  ),
  snail: strokes(
    snailShell,
    stroke([8, 82], [80, 82], 1),
    through([[66, 82], [82, 74], [86, 58]]),
    stroke([84, 60], [78, 42], 0.4),
    stroke([88, 60], [96, 44], -0.4),
  ),
  wave: strokes(
    through([[6, 72], [24, 58], [40, 38], [60, 24], [80, 28], [88, 42], [78, 50], [68, 42]]),
    through([[6, 88], [22, 80], [38, 88], [54, 80], [70, 88], [86, 80], [96, 86]]),
  ),
  plane: strokes(
    path([[6, 46], [94, 12], [64, 88], [44, 58]], 0.3, true),
    stroke([44, 58], [94, 12], 0.3),
    path([[44, 58], [42, 82], [54, 70]], 0.3),
  ),
  gem: strokes(
    path([[24, 18], [76, 18], [94, 40], [50, 90], [6, 40]], 0.4, true),
    stroke([6, 40], [94, 40], 0.4),
    path([[24, 18], [36, 40], [50, 90], [64, 40], [76, 18]], 0.3),
  ),
  cactus: strokes(
    through([[40, 88], [40, 20], [50, 10], [60, 20], [60, 88]]),
    through([[40, 64], [24, 62], [18, 48], [20, 34], [26, 30], [30, 36], [30, 50], [40, 52]]),
    through([[60, 50], [74, 48], [80, 36], [80, 24], [74, 20], [70, 26], [70, 38], [60, 40]]),
    stroke([20, 88], [80, 88], 0.6),
  ),
  bolt: BYPASS,
};

/** One project icon, drawn to fill whatever holds it. */
export function ProjectIcon({ name }: { name: string }) {
  const d = PROJECT_ART[name as ProjectIconName] ?? PROJECT_ART.star;
  let seed = 0;
  for (const ch of name) seed = (seed * 31 + ch.charCodeAt(0)) % 997;
  return (
    <Doodle label={name} seed={seed} tilt={(seed % 9) - 4}>
      {() => <Line d={d} width={PICK_INK} />}
    </Doodle>
  );
}
