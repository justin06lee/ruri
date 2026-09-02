import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { attachFile, replaceAttachmentFile } from "../store";

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
  { id: "erase", title: "Erase a shape (X)", d: "M4 15l7-7 8 8-4 4H8l-4-4zM11 8l8 8" },
];

const COLORS = [
  { id: "ink", value: "#191510" },
  { id: "red", value: "#d0342c" },
  { id: "blue", value: "#2b6cb0" },
  { id: "green", value: "#2f855a" },
  { id: "paper", value: "#f6f1e6" },
];

const WIDTHS = [2, 4, 8];

/** The faces text can be set in. The first is the app's own. */
const FONTS: Array<{ id: string; label: string; family: string }> = [
  { id: "grotesk", label: "Grotesk", family: '"Space Grotesk Variable", -apple-system, sans-serif' },
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
const PAPER = "#f6f1e6";
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
    else localStorage.setItem(`ruri:sketch:${key}`, JSON.stringify({ shapes: state.shapes, name: state.name, size: state.size }));
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
      return { x: Math.min(shape.x, shape.x + shape.w), y: Math.min(shape.y, shape.y + shape.h), w: Math.abs(shape.w), h: Math.abs(shape.h) };
    case "text": {
      const lines = shape.text.split("\n");
      const longest = Math.max(...lines.map((line) => line.length));
      return { x: shape.x, y: shape.y - shape.size, w: longest * shape.size * 0.6, h: lines.length * shape.size * LINE };
    }
  }
}

function draw(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (shape.kind === "text") {
    ctx.font = `600 ${shape.size}px ${shape.font ?? FONTS[0]!.family}`;
    ctx.textBaseline = "alphabetic";
    // a paper halo so the words read on a busy picture
    ctx.lineWidth = Math.max(3, shape.size / 6);
    ctx.strokeStyle = shape.color === PAPER ? "#191510" : PAPER;
    ctx.fillStyle = shape.color;
    shape.text.split("\n").forEach((line, i) => {
      const y = shape.y + i * shape.size * LINE;
      ctx.strokeText(line, shape.x, y);
      ctx.fillText(line, shape.x, y);
    });
    ctx.restore();
    return;
  }
  ctx.strokeStyle = shape.color;
  ctx.lineWidth = shape.width;
  switch (shape.kind) {
    case "pen": {
      const [first, ...rest] = shape.points;
      if (!first) break;
      ctx.beginPath();
      ctx.moveTo(first[0], first[1]);
      if (rest.length === 0) ctx.lineTo(first[0] + 0.1, first[1]);
      for (const p of rest) ctx.lineTo(p[0], p[1]);
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
      ctx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w / 2), Math.abs(shape.h / 2), 0, 0, Math.PI * 2);
      ctx.stroke();
      break;
  }
  ctx.restore();
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
  const [color, setColor] = useState(background ? COLORS[1]!.value : COLORS[0]!.value);
  const [width, setWidth] = useState(4);
  const [shapes, setShapes] = useState<Shape[]>(kept?.shapes ?? []);
  const [history, setHistory] = useState<Shape[][]>((kept as PadState | undefined)?.history ?? []);
  const [draft, setDraft] = useState<Shape | null>(null);
  const draftRef = useRef<Shape | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState(kept?.size ?? BLANK);
  const [name, setName] = useState(background?.name ?? kept?.name ?? "");
  const [pictureUrl, setPictureUrl] = useState<string | undefined>((kept as PadState | undefined)?.pictureUrl);
  /** The text box, open. Its last font and size are remembered for the next. */
  const [writing, setWriting] = useState<TextDraft | null>(null);
  const [fontRow, setFontRow] = useState(false);
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
  const hanging: Shape | null =
    placing && placeAt
      ? { kind: "text", x: placeAt[0], y: placeAt[1] + placing.size * 0.35, text: placing.text, color, size: placing.size, font: placing.font }
      : null;
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, size.w, size.h);
    if (image) ctx.drawImage(image, 0, 0, size.w, size.h);
    else {
      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, size.w, size.h);
    }
    for (const shape of shapes) draw(ctx, shape);
    if (draft) draw(ctx, draft);
    if (hanging) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      draw(ctx, hanging);
      ctx.restore();
    }
  }, [shapes, draft, image, size, hanging]);

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
    setHistory((h) => [...h, shapes]);
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
    setHistory((h) => [...h, shapes]);
    setShapes([]);
  };

  // widths are in pad pixels; a big picture wants a proportionally bigger pen
  const stroke = width * scaleUp;

  /** Open the text box, empty or with what was being placed. */
  const openText = (value = "") => {
    setPlacing(null);
    setPlaceAt(null);
    setWriting({ value, ...lastText.current });
  };

  /** A tool from the bar or the keys; the text tool opens its box at once. */
  const pickTool = (next: Tool) => {
    setTool(next);
    if (next === "text") openText();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const [x, y] = at(e);
    if (placing) {
      // the click that stamps the words
      commit({ kind: "text", x, y: y + placing.size * 0.35, text: placing.text, color, size: placing.size, font: placing.font });
      setPlacing(null);
      setPlaceAt(null);
      return;
    }
    if (tool === "text") {
      openText();
      return;
    }
    if (tool === "erase") {
      const pad = 12 * scaleUp;
      for (let i = shapes.length - 1; i >= 0; i--) {
        const b = bounds(shapes[i]!);
        if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) {
          setHistory((h) => [...h, shapes]);
          setShapes(shapes.filter((_, j) => j !== i));
          break;
        }
      }
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

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (placing) {
      setPlaceAt(at(e));
      return;
    }
    const current = draftRef.current;
    if (!current) return;
    const [x, y] = at(e);
    let next: Shape;
    switch (current.kind) {
      case "pen":
        next = { ...current, points: [...current.points, [x, y]] };
        break;
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
    commit(current);
  };

  /** Place: the words leave the box and hang on the pointer. */
  const place = () => {
    if (!writing) return;
    const text = writing.value.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
    lastText.current = { font: writing.font, size: writing.size };
    setWriting(null);
    setFontRow(false);
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
      const byKey: Record<string, Tool> = { p: "pen", a: "arrow", l: "line", r: "rect", e: "ellipse", t: "text", x: "erase" };
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [writing, placing, undo]);

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
      <div className="sketch-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`icon-button ${tool === t.id ? "active" : ""}`}
            title={t.title}
            onClick={() => pickTool(t.id)}
          >
            <Icon d={t.d} />
          </button>
        ))}
        <span className="sketch-sep" />
        {COLORS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`sketch-swatch ${color === c.value ? "active" : ""}`}
            style={{ background: c.value }}
            title={c.id}
            onClick={() => setColor(c.value)}
          />
        ))}
        <span className="sketch-sep" />
        {WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            className={`sketch-width ${width === w ? "active" : ""}`}
            title={`${w}px`}
            onClick={() => setWidth(w)}
          >
            <span style={{ width: w + 2, height: w + 2 }} />
          </button>
        ))}
        <span className="sketch-sep" />
        <button type="button" className="icon-button" title="Undo (⌘Z)" disabled={history.length === 0} onClick={undo}>
          <Icon d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-4" />
        </button>
        <button type="button" className="icon-button" title="Clear the pad" disabled={shapes.length === 0} onClick={clear}>
          <Icon d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        </button>
        <label className="icon-button sketch-open" title="Open a picture to draw on">
          <Icon d="M4 5h16v14H4zM8 15l3-4 3 3 2-2 3 3" />
          <input type="file" accept="image/*" onChange={(e) => openPicture(e.target.files)} />
        </label>
        <span className="sketch-name">{name || "a sketch"}</span>
        <button type="button" className="primary sketch-attach" title="Put it in the prompt as an image" onClick={attach}>
          {background?.id ? "Put it back" : "Attach"}
        </button>
        <button type="button" className="icon-button" title="Close the pad — the drawing is kept" onClick={onClose}>
          <Icon d="M6 6l12 12M18 6L6 18" />
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
        <div className="confirm-overlay sketch-text-overlay" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setWriting(null);
        }}>
          <div className="confirm-card sketch-text-card">
            <textarea
              className="sketch-text-box"
              autoFocus
              rows={5}
              placeholder="What to write on the pad…"
              style={{ fontFamily: writingFont.family, fontSize: Math.round(Math.max(14, Math.min(34, writingSize.px * 0.75))), color }}
              value={writing.value}
              onChange={(e) => setWriting({ ...writing, value: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setWriting(null);
                  setFontRow(false);
                } else if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  place();
                }
              }}
            />
            {fontRow && (
              <div className="sketch-font-row">
                {FONTS.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={`sketch-font ${writing.font === f.id ? "active" : ""}`}
                    style={{ fontFamily: f.family }}
                    onClick={() => setWriting({ ...writing, font: f.id })}
                  >
                    {f.label}
                  </button>
                ))}
                <span className="sketch-sep" />
                {SIZES.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    className={`sketch-font ${writing.size === s.id ? "active" : ""}`}
                    onClick={() => setWriting({ ...writing, size: s.id })}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
            <div className="confirm-actions sketch-text-actions">
              <button type="button" className="ghost" onClick={() => setFontRow(!fontRow)}>
                Font…
              </button>
              <span className="sketch-text-gap" />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setWriting(null);
                  setFontRow(false);
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
