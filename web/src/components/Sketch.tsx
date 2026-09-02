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
 */

type Point = [number, number];

type Shape =
  | { kind: "pen"; points: Point[]; color: string; width: number }
  | { kind: "arrow" | "line"; x1: number; y1: number; x2: number; y2: number; color: string; width: number }
  | { kind: "rect" | "ellipse"; x: number; y: number; w: number; h: number; color: string; width: number }
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number };

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

/** The blank pad's size; a picture's is the picture's own. */
const BLANK = { w: 1400, h: 900 };
/** A picture bigger than this is drawn at this, so the pad stays quick. */
const MAX_SIDE = 2400;
const PAPER = "#f6f1e6";

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
    case "text":
      return { x: shape.x, y: shape.y - shape.size, w: shape.text.length * shape.size * 0.6, h: shape.size * 1.2 };
  }
}

function draw(ctx: CanvasRenderingContext2D, shape: Shape): void {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (shape.kind === "text") {
    ctx.font = `600 ${shape.size}px "Space Grotesk Variable", -apple-system, sans-serif`;
    ctx.textBaseline = "alphabetic";
    // a paper halo so the words read on a busy picture
    ctx.lineWidth = Math.max(3, shape.size / 6);
    ctx.strokeStyle = shape.color === PAPER ? "#191510" : PAPER;
    ctx.strokeText(shape.text, shape.x, shape.y);
    ctx.fillStyle = shape.color;
    ctx.fillText(shape.text, shape.x, shape.y);
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

export function Sketch({
  channelId,
  background,
  onClose,
}: {
  channelId: string;
  background?: SketchBackground;
  onClose(): void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<Tool>(background ? "arrow" : "pen");
  const [color, setColor] = useState(background ? COLORS[1]!.value : COLORS[0]!.value);
  const [width, setWidth] = useState(4);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [history, setHistory] = useState<Shape[][]>([]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const draftRef = useRef<Shape | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [size, setSize] = useState(BLANK);
  const [typing, setTyping] = useState<{ x: number; y: number; value: string } | null>(null);
  /** Where a label was asked for: placed on the release, not the press —
   *  an input opened on the press loses focus to the release that follows
   *  it, blurs, and takes itself down again empty. */
  const labelAt = useRef<Point | null>(null);
  const [name, setName] = useState(background?.name ?? "");

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
  }, [background, loadImage]);

  // everything is redrawn from the shapes, so undo is exact
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
  }, [shapes, draft, image, size]);

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
  const scaleUp = Math.max(1, Math.max(size.w, size.h) / 1400);
  const stroke = width * scaleUp;
  const textSize = Math.round(28 * scaleUp);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const [x, y] = at(e);
    if (tool === "text") {
      labelAt.current = [x, y];
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
    const wanted = labelAt.current;
    labelAt.current = null;
    if (wanted) {
      setTyping({ x: wanted[0], y: wanted[1], value: "" });
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
    commit(current);
  };

  const commitText = () => {
    if (!typing) return;
    const text = typing.value.trim();
    setTyping(null);
    if (text) commit({ kind: "text", x: typing.x, y: typing.y, text, color, size: textSize });
  };

  // keys: undo, tools, close — never while typing a label
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (typing) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Escape") onClose();
      const byKey: Record<string, Tool> = { p: "pen", a: "arrow", l: "line", r: "rect", e: "ellipse", t: "text", x: "erase" };
      const pick = byKey[e.key.toLowerCase()];
      if (pick) setTool(pick);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [typing, undo, onClose]);

  const attach = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.toBlob((blob) => {
      if (!blob) return;
      const stem = (name || "sketch").replace(/\.[a-z0-9]+$/i, "");
      const file = new File([blob], `${stem}.png`, { type: "image/png" });
      if (background?.id) replaceAttachmentFile(channelId, background.id, file);
      else attachFile(channelId, file, "image");
      onClose();
    }, "image/png");
  };

  const openPicture = (files: FileList | null) => {
    const file = files?.[0];
    if (!file || !file.type.startsWith("image/")) return;
    setName(file.name);
    setShapes([]);
    setHistory([]);
    loadImage(URL.createObjectURL(file));
  };

  // where the label box goes on screen: the pad point, in the canvas's
  // displayed size
  const typingStyle = (() => {
    if (!typing || !canvasRef.current || !stageRef.current) return undefined;
    const rect = canvasRef.current.getBoundingClientRect();
    const stage = stageRef.current.getBoundingClientRect();
    const scale = rect.width / size.w;
    return {
      left: rect.left - stage.left + typing.x * scale,
      top: rect.top - stage.top + typing.y * scale - textSize * scale,
      fontSize: Math.max(12, textSize * scale),
      color,
    };
  })();

  return (
    <section className="sketch-page">
      <div className="sketch-tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`icon-button ${tool === t.id ? "active" : ""}`}
            title={t.title}
            onClick={() => setTool(t.id)}
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
        <button type="button" className="icon-button" title="Close (Esc)" onClick={onClose}>
          <Icon d="M6 6l12 12M18 6L6 18" />
        </button>
      </div>
      <div className="sketch-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          width={size.w}
          height={size.h}
          className={`sketch-canvas tool-${tool}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        {typing && typingStyle && (
          <input
            className="sketch-label"
            autoFocus
            style={typingStyle}
            value={typing.value}
            placeholder="label…"
            onChange={(e) => setTyping({ ...typing, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") setTyping(null);
            }}
            onBlur={commitText}
          />
        )}
      </div>
    </section>
  );
}
