import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HOME_ID } from "../../../shared/protocol";
import { attachFile, replaceAttachmentFile, useRuri } from "../store";
import { MOD } from "../lib/keys";

/**
 * The sketch pad: draw a thing to show the model, or draw on a picture to
 * point at something in it.
 *
 * Half of what is hard to say about an interface is easy to draw — a box
 * here, an arrow there, "this one" — and a model reads a picture of a
 * layout better than three paragraphs about it. So this is a page: a
 * canvas as wide as the pane, a pen, arrows, boxes, ellipses, text, five
 * colours, three widths, undo. Attach puts the drawing in the composer as
 * an image like any other, marker and all; opened on an attached picture,
 * Attach puts the drawn-on picture back in its place.
 *
 * Everything drawn is kept as shapes and redrawn, never as pixels, so undo
 * is exact and the export is drawn fresh at the picture's own size.
 *
 * Nothing here is lost by accident. Every stroke is saved as it lands,
 * per channel and per picture, and the pad only closes when its own close
 * button is pressed — not on Escape, which is the key you press to get out
 * of a text box, and used to take the whole drawing with it. Leave for
 * another channel, come back, and the drawing is where it was.
 *
 * Text is written in a box first and placed second: the text tool opens a
 * box to write in (several lines, a font, a size), and Place hangs the
 * words on the pointer to be stamped wherever the next click lands.
 */

type Point = [number, number];

type Shape =
  | { kind: "pen"; points: Point[]; color: string; width: number }
  | { kind: "arrow" | "line"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number; color: string; width: number }
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number; font?: string };

type Tool = "pen" | "arrow" | "line" | "rect" | "ellipse" | "text" | "erase";

/** A picture the pad opens on: an attachment's, so Attach can replace it. */
export interface SketchBackground {
  /** The composer attachment this is, when it is one. */
  id?: string;
  url: string;
  name: string;
}

const TOOLS: Array<{ id: Tool; title: string; d: string }> = [
  { id: "pen", title: "Pen (P)", d: "M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" },
  { id: "arrow", title: "Arrow (A)", d: "M4 20L20 4M20 4h-8M20 4v8" },
  { id: "line", title: "Line (L)", d: "M4 20L20 4" },
  { id: "rect", title: "Box (R)", d: "M4 5h16v14H4z" },
  { id: "ellipse", title: "Ellipse (E)", d: "M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z" },
  { id: "text", title: "Text (T)", d: "M5 5h14M12 5v14M9 19h6" },
  {
    id: "erase",
    title: "Eraser — drag across what should go (X)",
    d: "M21 21H8a2 2 0 0 1-1.42-.59l-4-4a2 2 0 0 1 0-2.82l10-10a2 2 0 0 1 2.83 0l6 6a2 2 0 0 1 0 2.82L12.83 21M5.08 11.09l8.83 8.83",
  },
];

/**
 * The five colours, by name. A shape keeps the name, not the colour, and
 * the name is painted in the theme on screen: ink and paper are the
 * theme's own, read off the page, so on dark and ember the pad is the
 * theme's paper and the pen writes in its ink — light on dark — instead of
 * a cream sheet with black on it; the three accents are lifted on the dark
 * themes so they still read there. The picture that goes in the prompt is
 * drawn the same way, so it looks like the pad did.
 */
type Swatch = "ink" | "red" | "blue" | "green" | "paper";

const SWATCHES: Swatch[] = ["ink", "red", "blue", "green", "paper"];

type Palette = Record<Swatch, string>;

const ACCENTS: Record<"light" | "dark" | "ember", Pick<Palette, "red" | "blue" | "green">> = {
  light: { red: "#ff3b30", blue: "#007aff", green: "#34c759" },
  dark: { red: "#ff453a", blue: "#0a84ff", green: "#30d158" },
  ember: { red: "#ff453a", blue: "#0a84ff", green: "#30d158" },
};

/** The light theme's colours as older pads kept them, by hex — they are
 *  the swatches they were picked as, and follow the theme like the rest. */
const KEPT_AS_HEX: Record<string, Swatch> = {
  "#191510": "ink",
  "#f6f1e6": "paper",
  "#d0342c": "red",
  "#2b6cb0": "blue",
  "#2f855a": "green",
};

function readPalette(): Palette {
  const root = document.documentElement;
  const theme = root.dataset["theme"];
  const css = getComputedStyle(root);
  const own = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ink: own("--ink", "#191510"),
    paper: own("--paper", "#f6f1e6"),
    ...ACCENTS[theme === "dark" || theme === "ember" ? theme : "light"],
  };
}

/** The palette of the theme on screen, repainted when the theme turns. */
function usePalette(): Palette {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const observer = new MutationObserver(() => setPalette(readPalette()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return palette;
}

/** A shape's colour as drawn: a swatch in the theme's palette, or — for
 *  anything that is neither a swatch nor one kept as hex — as written. */
function paint(color: string, palette: Palette): string {
  const swatch = Object.hasOwn(palette, color) ? (color as Swatch) : KEPT_AS_HEX[color.toLowerCase()];
  return swatch ? palette[swatch] : color;
}

const WIDTHS = [2, 4, 8];

/** The faces text can be set in. The first is the app's own. */
const FONTS: Array<{ id: string; label: string; family: string }> = [
  { id: "grotesk", label: "Sans", family: '-apple-system, system-ui, "Inter", sans-serif' },
  { id: "mono", label: "Mono", family: 'ui-monospace, "SF Mono", Menlo, monospace' },
  { id: "serif", label: "Serif", family: 'Georgia, "Times New Roman", serif' },
  { id: "hand", label: "Hand", family: '"Bradley Hand", "Comic Sans MS", "Segoe Print", cursive' },
];

/** Text sizes, in pad pixels on a blank pad; a big picture scales them up. */
const SIZES: Array<{ id: string; label: string; px: number }> = [
  { id: "s", label: "S", px: 20 },
  { id: "m", label: "M", px: 28 },
  { id: "l", label: "L", px: 40 },
  { id: "xl", label: "XL", px: 56 },
];

/** The blank pad's size; a picture's is the picture's own. */
const BLANK = { w: 1400, h: 900 };
/** A picture bigger than this is drawn at this, so the pad stays quick. */
const MAX_SIDE = 2400;
/** Lines of a label, as a fraction of its size. */
const LINE = 1.25;

/* ── what the pad remembers ──────────────────────────────────────── */

/** A pad's whole state, as it is kept between openings. */
interface PadState {
  shapes: Shape[];
  history: Shape[][];
  name: string;
  size: { w: number; h: number };
  /** A picture opened from disk into the pad (an object URL — good for
   *  this window's life, which is the case that matters: the attachment
   *  case brings its own picture back through the composer). */
  pictureUrl?: string;
}

/** One pad per channel per picture, for as long as the window lives. */
const pads = new Map<string, PadState>();

/** How many steps back undo goes — past that the oldest are let go. */
const UNDO_MAX = 50;

function remember(history: Shape[][], shapes: Shape[]): Shape[][] {
  return [...history, shapes].slice(-UNDO_MAX);
}

/** The same, minus the picture and the undo stack, across launches. */
function stored(key: string): Pick<PadState, "shapes" | "name" | "size"> | undefined {
  try {
    const raw = localStorage.getItem(`ruri:sketch:${key}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<PadState>;
    if (!Array.isArray(parsed.shapes)) return undefined;
    return {
      shapes: parsed.shapes,
      name: typeof parsed.name === "string" ? parsed.name : "",
      size:
        parsed.size && typeof parsed.size.w === "number" && typeof parsed.size.h === "number"
          ? parsed.size
          : BLANK,
    };
  } catch {
    return undefined;
  }
}

function store(key: string, state: PadState): void {
  pads.set(key, state);
  try {
    if (state.shapes.length === 0 && !state.name) localStorage.removeItem(`ruri:sketch:${key}`);
    else
      localStorage.setItem(
        `ruri:sketch:${key}`,
        JSON.stringify({ shapes: state.shapes, name: state.name, size: state.size }),
      );
  } catch {
    // a full store loses nothing the window still holds
  }
}

function forget(key: string): void {
  pads.delete(key);
  try {
    localStorage.removeItem(`ruri:sketch:${key}`);
  } catch {
    // nothing to remove
  }
}

// a chat gone from the workspace takes its pads with it
useRuri.subscribe((s, prev) => {
  if (s.projects === prev.projects) return;
  const alive = new Set([HOME_ID, ...s.projects.flatMap((p) => p.sessions.map((x) => x.id))]);
  for (const key of [...pads.keys()]) if (!alive.has(key.slice(0, key.indexOf("|")))) forget(key);
});

/* ── drawing ─────────────────────────────────────────────────────── */

function bounds(shape: Shape): { x: number; y: number; w: number; h: number } {
  switch (shape.kind) {
    case "pen": {
      const xs = shape.points.map((p) => p[0]);
      const ys = shape.points.map((p) => p[1]);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    case "arrow":
    case "line": {
      const x = Math.min(shape.x1, shape.x2);
      const y = Math.min(shape.y1, shape.y2);
      return { x, y, w: Math.abs(shape.x2 - shape.x1), h: Math.abs(shape.y2 - shape.y1) };
    }
    case "rect":
    case "ellipse":
      return {
        x: Math.min(shape.x, shape.x + shape.w),
        y: Math.min(shape.y, shape.y + shape.h),
        w: Math.abs(shape.w),
        h: Math.abs(shape.h),
      };
    case "text": {
      const lines = shape.text.split("\n");
      const longest = Math.max(...lines.map((line) => line.length));
      return {
        x: shape.x,
        y: shape.y - shape.size,
        w: longest * shape.size * 0.6,
        h: lines.length * shape.size * LINE,
      };
    }
  }
}

/** How far a point is from the segment a–b. */
function toSegment(x: number, y: number, a: Point, b: Point): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = dx * dx + dy * dy;
  const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / len));
  return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
}

/** Whether the eraser at x,y touches the shape's ink — the stroke itself,
 *  not the box around it, so a ring erases from its rim and not its middle. */
function touches(shape: Shape, x: number, y: number, reach: number): boolean {
  if (shape.kind === "text") {
    const b = bounds(shape);
    return x >= b.x - reach && x <= b.x + b.w + reach && y >= b.y - reach && y <= b.y + b.h + reach;
  }
  const r = reach + shape.width / 2;
  switch (shape.kind) {
    case "pen": {
      const pts = shape.points;
      if (pts.length === 1) return Math.hypot(x - pts[0]![0], y - pts[0]![1]) <= r;
      for (let i = 1; i < pts.length; i++) if (toSegment(x, y, pts[i - 1]!, pts[i]!) <= r) return true;
      return false;
    }
    case "line":
    case "arrow":
      return toSegment(x, y, [shape.x1, shape.y1], [shape.x2, shape.y2]) <= r;
    case "rect": {
      const a: Point = [shape.x, shape.y];
      const b: Point = [shape.x + shape.w, shape.y];
      const c: Point = [shape.x + shape.w, shape.y + shape.h];
      const d: Point = [shape.x, shape.y + shape.h];
      return [toSegment(x, y, a, b), toSegment(x, y, b, c), toSegment(x, y, c, d), toSegment(x, y, d, a)].some(
        (dist) => dist <= r,
      );
    }
    case "ellipse": {
      const rx = Math.abs(shape.w / 2);
      const ry = Math.abs(shape.h / 2);
      const cx = shape.x + shape.w / 2;
      const cy = shape.y + shape.h / 2;
      if (rx < 1 || ry < 1) return Math.hypot(x - cx, y - cy) <= r + Math.max(rx, ry);
      const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
      return Math.abs(k - 1) * Math.min(rx, ry) <= r;
    }
  }
}

/** A pen's next point, eased toward the pointer: a little of the hand's
 *  tremble smoothed out, and samples closer than a pixel dropped. */
function follow(points: Point[], x: number, y: number, ease: number): Point[] {
  const last = points[points.length - 1];
  if (!last) return [[x, y]];
  const next: Point = [last[0] + (x - last[0]) * ease, last[1] + (y - last[1]) * ease];
  if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 0.75) return points;
  return [...points, next];
}

function draw(ctx: CanvasRenderingContext2D, shape: Shape, palette: Palette): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const color = paint(shape.color, palette);
  if (shape.kind === "text") {
    ctx.font = `600 ${shape.size}px ${shape.font ?? FONTS[0]!.family}`;
    ctx.textBaseline = "alphabetic";
    // a paper halo so the words read on a busy picture
    ctx.lineWidth = Math.max(3, shape.size / 6);
    ctx.strokeStyle = color === palette.paper ? palette.ink : palette.paper;
    ctx.fillStyle = color;
    shape.text.split("\n").forEach((line, i) => {
      const y = shape.y + i * shape.size * LINE;
      ctx.strokeText(line, shape.x, y);
      ctx.fillText(line, shape.x, y);
    });
    ctx.restore();
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = shape.width;
  switch (shape.kind) {
    case "pen": {
      const [first, ...rest] = shape.points;
      if (!first) break;
      ctx.beginPath();
      ctx.moveTo(first[0], first[1]);
      if (rest.length === 0) ctx.lineTo(first[0] + 0.1, first[1]);
      // a curve through the midpoints, each point its control: no corners
      // where the samples were, the way a stroke in Notes comes out
      for (let i = 0; i < rest.length - 1; i++) {
        const p = rest[i]!;
        const q = rest[i + 1]!;
        ctx.quadraticCurveTo(p[0], p[1], (p[0] + q[0]) / 2, (p[1] + q[1]) / 2);
      }
      const last = rest[rest.length - 1];
      if (last) ctx.lineTo(last[0], last[1]);
      ctx.stroke();
      break;
    }
    case "line":
    case "arrow": {
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
      if (shape.kind === "arrow") {
        const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
        const head = 8 + shape.width * 3;
        for (const turn of [-0.5, 0.5]) {
          ctx.beginPath();
          ctx.moveTo(shape.x2, shape.y2);
          ctx.lineTo(shape.x2 - head * Math.cos(angle + turn), shape.y2 - head * Math.sin(angle + turn));
          ctx.stroke();
        }
      }
      break;
    }
    case "rect":
      ctx.strokeRect(shape.x, shape.y, shape.w, shape.h);
      break;
    case "ellipse":
      ctx.beginPath();
      ctx.ellipse(
        shape.x + shape.w / 2,
        shape.y + shape.h / 2,
        Math.abs(shape.w / 2),
        Math.abs(shape.h / 2),
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  );
}

/** What is being written, before it is placed. */
interface TextDraft {
  value: string;
  font: string;
  size: string;
}

export function Sketch({
  channelId,
  background,
  onClose,
}: {
  channelId: string;
  background?: SketchBackground;
  onClose(): void;
}) {
  const key = `${channelId}|${background?.id ?? "blank"}`;
  const kept = pads.get(key) ?? stored(key);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>(background ? "arrow" : "pen");
  const palette = usePalette();
  const [color, setColor] = useState<Swatch>(background ? "red" : "ink");
  const [width, setWidth] = useState(4);
  const [shapes, setShapes] = useState<Shape[]>(kept?.shapes ?? []);
  const [history, setHistory] = useState<Shape[][]>((kept as PadState | undefined)?.history ?? []);
  const [draft, setDraft] = useState<Shape | null>(null);
  const draftRef = useRef<Shape | null>(null);
  /** A drag of the eraser under way, and the shapes as they were before it. */
  const erasing = useRef<{ before: Shape[] } | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState(kept?.size ?? BLANK);
  const [name, setName] = useState(background?.name ?? kept?.name ?? "");
  const [pictureUrl, setPictureUrl] = useState<string | undefined>(
    (kept as PadState | undefined)?.pictureUrl,
  );
  /** The text box, open. Its last font and size are remembered for the next. */
  const [writing, setWriting] = useState<TextDraft | null>(null);
  const lastText = useRef<Pick<TextDraft, "font" | "size">>({ font: FONTS[0]!.id, size: "m" });
  /** Words hung on the pointer, waiting for the click that stamps them. */
  const [placing, setPlacing] = useState<{ text: string; font: string; size: number } | null>(null);
  const [placeAt, setPlaceAt] = useState<Point | null>(null);

  // the picture, when there is one: drawn at its own size, capped
  const loadImage = useCallback((url: string) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      setSize({ w: Math.round(img.naturalWidth * scale), h: Math.round(img.naturalHeight * scale) });
      setImage(img);
    };
    img.src = url;
  }, []);
  useEffect(() => {
    if (background) loadImage(background.url);
    else if (pictureUrl) loadImage(pictureUrl);
  }, [background, pictureUrl, loadImage]);

  // Every change lands in the pad's memory as it happens — the whole
  // point is that nothing is a step away from being lost.
  useEffect(() => {
    store(key, { shapes, history, name, size, ...(pictureUrl ? { pictureUrl } : {}) });
  }, [key, shapes, history, name, size, pictureUrl]);

  // everything is redrawn from the shapes, so undo is exact
  const scaleUp = Math.max(1, Math.max(size.w, size.h) / 1400);
  const hanging = useMemo<Shape | null>(
    () =>
      placing && placeAt
        ? {
            kind: "text",
            x: placeAt[0],
            y: placeAt[1] + placing.size * 0.35,
            text: placing.text,
            color,
            size: placing.size,
            font: placing.font,
          }
        : null,
    [placing, placeAt, color],
  );
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, size.w, size.h);
    if (image) ctx.drawImage(image, 0, 0, size.w, size.h);
    else {
      ctx.fillStyle = palette.paper;
      ctx.fillRect(0, 0, size.w, size.h);
    }
    for (const shape of shapes) draw(ctx, shape, palette);
    if (draft) draw(ctx, draft, palette);
    if (hanging) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      draw(ctx, hanging, palette);
      ctx.restore();
    }
  }, [shapes, draft, image, size, hanging, palette]);

  /** Where a pointer falls on the pad, in its own pixels. */
  const at = (e: { clientX: number; clientY: number }): Point => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(size.w, ((e.clientX - rect.left) / rect.width) * size.w)),
      Math.max(0, Math.min(size.h, ((e.clientY - rect.top) / rect.height) * size.h)),
    ];
  };

  const commit = (shape: Shape) => {
    setHistory((h) => remember(h, shapes));
    setShapes((s) => [...s, shape]);
  };

  const undo = useCallback(() => {
    setHistory((h) => {
      const prev = h[h.length - 1];
      if (!prev) return h;
      setShapes(prev);
      return h.slice(0, -1);
    });
  }, []);

  const clear = () => {
    if (shapes.length === 0) return;
    setHistory((h) => remember(h, shapes));
    setShapes([]);
  };

  // widths are in pad pixels; a big picture wants a proportionally bigger pen
  const stroke = width * scaleUp;

  /** Open the text box, empty or with what was being placed. */
  const openText = useCallback((value = "") => {
    setPlacing(null);
    setPlaceAt(null);
    setWriting({ value, ...lastText.current });
  }, []);

  /** A tool from the bar or the keys; the text tool opens its box at once. */
  const pickTool = useCallback(
    (next: Tool) => {
      setTool(next);
      if (next === "text") openText();
    },
    [openText],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const [x, y] = at(e);
    if (placing) {
      // the click that stamps the words
      commit({
        kind: "text",
        x,
        y: y + placing.size * 0.35,
        text: placing.text,
        color,
        size: placing.size,
        font: placing.font,
      });
      setPlacing(null);
      setPlaceAt(null);
      return;
    }
    if (tool === "text") {
      openText();
      return;
    }
    if (tool === "erase") {
      // a drag, as Markup's eraser is: whatever it passes over goes, and
      // the whole drag is one undo
      e.currentTarget.setPointerCapture(e.pointerId);
      erasing.current = { before: shapes };
      eraseAt(x, y);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    const started: Shape =
      tool === "pen"
        ? { kind: "pen", points: [[x, y]], color, width: stroke }
        : tool === "arrow" || tool === "line"
          ? { kind: tool, x1: x, y1: y, x2: x, y2: y, color, width: stroke }
          : { kind: tool, x, y, w: 0, h: 0, color, width: stroke };
    draftRef.current = started;
    setDraft(started);
  };

  /** The eraser at x,y: every shape it touches leaves. */
  const eraseAt = (x: number, y: number) => {
    const reach = 8 * scaleUp;
    setShapes((s) => {
      const kept = s.filter((shape) => !touches(shape, x, y, reach));
      return kept.length === s.length ? s : kept;
    });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (placing) {
      setPlaceAt(at(e));
      return;
    }
    // every sample the pointer made since the last frame, not just the
    // last one: a quick stroke keeps its curve instead of going polygonal
    const samples = e.nativeEvent.getCoalescedEvents?.() ?? [];
    const points = (samples.length > 0 ? samples : [e]).map(at);
    if (erasing.current) {
      for (const [x, y] of points) eraseAt(x, y);
      return;
    }
    const current = draftRef.current;
    if (!current) return;
    const [x, y] = points[points.length - 1]!;
    let next: Shape;
    switch (current.kind) {
      case "pen": {
        let trail = current.points;
        for (const [px, py] of points) trail = follow(trail, px, py, 0.6);
        if (trail === current.points) return;
        next = { ...current, points: trail };
        break;
      }
      case "arrow":
      case "line":
        next = { ...current, x2: x, y2: y };
        break;
      case "rect":
      case "ellipse":
        next = { ...current, w: x - current.x, h: y - current.y };
        break;
      default:
        return;
    }
    draftRef.current = next;
    setDraft(next);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const erased = erasing.current;
    if (erased) {
      erasing.current = null;
      if (shapes !== erased.before) setHistory((h) => remember(h, erased.before));
      return;
    }
    const current = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!current) return;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    const b = bounds(current);
    // a click is not a shape — except with the pen, where a dot is a dot
    if (current.kind !== "pen" && b.w < 2 && b.h < 2) return;
    // the pen's last stretch: the eased trail lags the pointer, so it is
    // finished where the pointer let go
    if (current.kind === "pen") {
      const end = at(e);
      const last = current.points[current.points.length - 1]!;
      if (Math.hypot(end[0] - last[0], end[1] - last[1]) >= 0.75) {
        commit({ ...current, points: [...current.points, end] });
        return;
      }
    }
    commit(current);
  };

  /** Place: the words leave the box and hang on the pointer. */
  const place = () => {
    if (!writing) return;
    const text = writing.value.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    lastText.current = { font: writing.font, size: writing.size };
    setWriting(null);
    if (!text.trim()) return;
    const font = FONTS.find((f) => f.id === writing.font)?.family ?? FONTS[0]!.family;
    const px = (SIZES.find((s) => s.id === writing.size)?.px ?? 28) * scaleUp;
    setPlacing({ text, font, size: Math.round(px) });
  };

  // keys: undo, tools — never while writing in the box. Escape puts down
  // whatever is hanging on the pointer and reopens the box with it, so the
  // words are not lost; it never closes the pad.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (writing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") {
        if (placing) openText(placing.text);
        return;
      }
      const byKey: Record<string, Tool> = {
        p: "pen",
        a: "arrow",
        l: "line",
        r: "rect",
        e: "ellipse",
        t: "text",
        x: "erase",
      };
      const pick = byKey[e.key.toLowerCase()];
      if (pick) {
        // T opens the text box, and the box takes focus before the key's
        // own letter lands — so the letter is stopped here
        e.preventDefault();
        pickTool(pick);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [writing, placing, undo, openText, pickTool]);

  const attach = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const stem = (name || "sketch").replace(/\.[a-z0-9]+$/i, "");
      const file = new File([blob], `${stem}.png`, { type: "image/png" });
      if (background?.id) replaceAttachmentFile(channelId, background.id, file);
      else attachFile(channelId, file, "image");
      // the drawing is in the prompt now; the next pad starts clean
      forget(key);
      onClose();
    }, "image/png");
  };

  const openPicture = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    setName(file.name);
    setShapes([]);
    setHistory([]);
    setPictureUrl(URL.createObjectURL(file));
  };

  const writingFont = FONTS.find((f) => f.id === writing?.font) ?? FONTS[0]!;
  const writingSize = SIZES.find((s) => s.id === writing?.size) ?? SIZES[1]!;

  return (
    <section className="sketch-page">
      {/* a Mac toolbar: close and the name on the left, the tools in the
          middle as segmented controls, and the one blue button on the right */}
      <div className="sketch-tools">
        <button
          type="button"
          className="icon-button"
          title="Close the pad — the drawing is kept"
          onClick={onClose}
        >
          <Icon d="M6 6l12 12M18 6L6 18" />
        </button>
        <span className="sketch-name">{name || "Sketch"}</span>
        <div className="sketch-middle">
          <div className="seg sketch-seg">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`seg-option ${tool === t.id ? "active" : ""}`}
                title={t.title}
                onClick={() => pickTool(t.id)}
              >
                <Icon d={t.d} />
              </button>
            ))}
          </div>
          <div className="sketch-swatches">
            {SWATCHES.map((swatch) => (
              <button
                key={swatch}
                type="button"
                className={`sketch-swatch ${color === swatch ? "active" : ""}`}
                style={{ background: palette[swatch] }}
                title={swatch}
                onClick={() => setColor(swatch)}
              />
            ))}
          </div>
          <div className="seg sketch-seg">
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className={`seg-option sketch-width ${width === w ? "active" : ""}`}
                title={`${w}px`}
                onClick={() => setWidth(w)}
              >
                <span style={{ height: w }} />
              </button>
            ))}
          </div>
        </div>
        <button
          type="button"
          className="icon-button"
          title={`Undo (${MOD}Z)`}
          disabled={history.length === 0}
          onClick={undo}
        >
          <Icon d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4" />
        </button>
        <button
          type="button"
          className="icon-button"
          title="Clear the pad"
          disabled={shapes.length === 0}
          onClick={clear}
        >
          <Icon d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        </button>
        <label className="icon-button sketch-open" title="Open a picture to draw on">
          <Icon d="M4 5h16v14H4zM8 15l3-4 3 3 2-2 3 3" />
          <input type="file" accept="image/*" onChange={(e) => openPicture(e.target.files)} />
        </label>
        <button
          type="button"
          className="primary sketch-attach"
          title="Put it in the prompt as an image"
          onClick={attach}
        >
          {background?.id ? "Put Back" : "Attach"}
        </button>
      </div>
      <div className="sketch-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          width={size.w}
          height={size.h}
          className={`sketch-canvas tool-${tool} ${placing ? "placing" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={() => {
            if (placing) setPlaceAt(null);
          }}
        />
        {placing && (
          <div className="sketch-placing">
            Click on the pad to place the words · Esc to go back and edit them
          </div>
        )}
      </div>
      {writing && (
        <div
          className="confirm-overlay sketch-text-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setWriting(null);
          }}
        >
          <div className="confirm-card sketch-text-card">
            <textarea
              className="sketch-text-box"
              autoFocus
              rows={5}
              placeholder="What to write on the pad…"
              style={{
                fontFamily: writingFont.family,
                fontSize: Math.round(Math.max(14, Math.min(34, writingSize.px * 0.75))),
                // the words as they will land: in their colour, on the pad's
                // paper, haloed the way the pad halos them
                color: paint(color, palette),
                background: palette.paper,
                ...(color === "paper"
                  ? { textShadow: `0 0 2px ${palette.ink}, 0 0 1px ${palette.ink}` }
                  : {}),
              }}
              value={writing.value}
              onChange={(e) => setWriting({ ...writing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setWriting(null);
                              } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  place();
                }
              }}
            />
            <div className="sketch-font-row">
              <div className="seg">
                {FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`seg-option ${writing.font === f.id ? "active" : ""}`}
                    style={{ fontFamily: f.family }}
                    onClick={() => setWriting({ ...writing, font: f.id })}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="seg">
                {SIZES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`seg-option ${writing.size === s.id ? "active" : ""}`}
                    onClick={() => setWriting({ ...writing, size: s.id })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="confirm-actions sketch-text-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setWriting(null);
                              }}
              >
                Cancel
              </button>
              <button type="button" className="primary" disabled={!writing.value.trim()} onClick={place}>
                Place…
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
