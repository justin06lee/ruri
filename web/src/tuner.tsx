import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HERO_COUNT, heroUrl } from "./hero";
import { HERO_CENTER, type HeroFrame, type Peek, PEEKS, HERO_FRAMES } from "./peek";
import "@fontsource-variable/space-grotesk";
import "./styles.css";
import "./tuner.css";

/**
 * The art tuner: place the peeking heads in the titlebar band, and frame each
 * hero face inside its circle — by dragging the actual things, at the actual
 * sizes, on the actual background.
 *
 * `make tuner` opens it. Save writes straight back to src/peek.ts, which is
 * the file the app reads, so what you set here is what ships. It's a dev
 * tool: it only exists on the dev server and never enters the app bundle.
 */

const BAND_W = 264;
const BAND_H = 46;

/* ── the peek band ────────────────────────────────────────────────── */

function PeekBand({
  peeks,
  setPeeks,
  selected,
  setSelected,
  hovering,
  stamp,
}: {
  peeks: Peek[];
  setPeeks(next: Peek[]): void;
  selected: number;
  setSelected(n: number): void;
  hovering: boolean;
  /** Bumped when a head is replaced, so the browser re-fetches it. */
  stamp: number;
}) {
  const bandRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ n: number; dx: number; dy: number } | null>(null);

  const update = (n: number, patch: Partial<Peek>) =>
    setPeeks(peeks.map((p) => (p.n === n ? { ...p, ...patch } : p)));

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const held = drag.current;
      const band = bandRef.current;
      if (!held || !band) return;
      const box = band.getBoundingClientRect();
      update(held.n, {
        x: Math.round(e.clientX - box.left - held.dx),
        drop: Math.round(e.clientY - box.top - held.dy),
      });
    };
    const up = () => {
      drag.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  });

  return (
    <div className="band-stage">
      <div className="band" ref={bandRef} style={{ width: BAND_W, height: BAND_H }}>
        {peeks.map((p) => (
          <img
            key={p.n}
            className={`peek-head ${selected === p.n ? "picked" : ""}`}
            src={`/peek/u${p.n}.png?v=${stamp}`}
            alt=""
            draggable={false}
            style={{
              left: p.x,
              width: p.w,
              top: p.drop,
              transform: hovering ? `translateY(${p.lift}px)` : undefined,
            }}
            onMouseDown={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              const band = bandRef.current!.getBoundingClientRect();
              drag.current = {
                n: p.n,
                dx: e.clientX - box.left,
                dy: e.clientY - box.top + (hovering ? p.lift : 0),
              };
              void band;
              setSelected(p.n);
            }}
            onWheel={(e) => {
              update(p.n, { w: Math.max(16, Math.round(p.w - e.deltaY * 0.25)) });
              setSelected(p.n);
            }}
          />
        ))}
      </div>
      <p className="hint">
        drag a head to move it · scroll over it to resize · the band is the real 264×46 titlebar
      </p>
    </div>
  );
}

/* ── one hero face in its circle ──────────────────────────────────── */

/** The circle's real size in the app — a drag is stored as percent of it. */
const CIRCLE = 132;

function HeroCircle({
  n,
  frame,
  picked,
  onPick,
  onChange,
}: {
  n: number;
  frame: HeroFrame;
  picked: boolean;
  onPick(): void;
  onChange(next: HeroFrame): void;
}) {
  const dragging = useRef(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const tenth = (v: number) => Math.round(v * 10) / 10;

  /** The zoom at which this picture stops fitting and starts filling. */
  const fillZoom = (): number => {
    const img = imgRef.current;
    if (!img?.naturalWidth || !img.naturalHeight) return 1;
    const long = Math.max(img.naturalWidth, img.naturalHeight);
    const short = Math.min(img.naturalWidth, img.naturalHeight);
    return Number((long / short).toFixed(2));
  };

  return (
    <div className={`hero-cell ${picked ? "picked" : ""}`} onMouseDown={onPick}>
      <div
        className="hero-frame tuner-frame"
        onMouseDown={() => {
          dragging.current = true;
        }}
        onMouseUp={() => {
          dragging.current = false;
        }}
        onMouseLeave={() => {
          dragging.current = false;
        }}
        onMouseMove={(e) => {
          if (!dragging.current) return;
          // the picture goes where the cursor takes it
          onChange({
            ...frame,
            x: tenth(frame.x + (e.movementX / CIRCLE) * 100),
            y: tenth(frame.y + (e.movementY / CIRCLE) * 100),
          });
        }}
        onWheel={(e) => {
          onChange({
            ...frame,
            zoom: Math.max(0.2, Math.min(4, Number((frame.zoom - e.deltaY * 0.002).toFixed(2)))),
          });
        }}
        onDoubleClick={() => onChange({ ...HERO_CENTER })}
      >
        <img
          ref={imgRef}
          className="hero-face"
          src={heroUrl(n)}
          alt=""
          draggable={false}
          style={{
            left: `calc(50% + ${frame.x}%)`,
            top: `calc(50% + ${frame.y}%)`,
            transform: `translate(-50%, -50%) scale(${frame.zoom})`,
          }}
        />
      </div>
      <span className="hero-label">v{n}</span>
      <div className="hero-nums">
        {(["x", "y", "zoom"] as const).map((field) => (
          <label key={field}>
            {field}
            <input
              type="number"
              step={field === "zoom" ? 0.05 : 1}
              value={frame[field]}
              onChange={(e) => onChange({ ...frame, [field]: Number(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <div className="hero-buttons">
        <button onClick={() => onChange({ ...HERO_CENTER })}>fit</button>
        <button onClick={() => onChange({ x: 0, y: 0, zoom: fillZoom() })}>fill</button>
      </div>
    </div>
  );
}


/* ── cutting a head out of a page ─────────────────────────────────── */

/** The width the band's heads are stored at — the existing five are 300px. */
const HEAD_W = 300;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A raw page with a box you drag over the head you want. The crop is taken at
 * the page's real resolution, scaled to the width the other heads use, and
 * white is dropped to transparent so the head sits on the band's screentone
 * rather than on a white card.
 */
function PageCutter({ name, onSaved }: { name: string; onSaved(): void }) {
  const [box, setBox] = useState<Box | null>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [cutWhite, setCutWhite] = useState(true);
  const [slot, setSlot] = useState(1);
  const [note, setNote] = useState<string | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);

  const src = `/__tuner/source/${name}`;

  /** Page pixels per rendered pixel. */
  const ratio = () => {
    const img = imgRef.current;
    if (!img || !size) return 1;
    return size[0] / img.getBoundingClientRect().width;
  };

  const preview = async (): Promise<string | null> => {
    const img = imgRef.current;
    if (!img || !box || !size) return null;
    const r = ratio();
    const sx = Math.max(0, Math.round(box.x * r));
    const sy = Math.max(0, Math.round(box.y * r));
    const sw = Math.max(1, Math.round(box.w * r));
    const sh = Math.max(1, Math.round(box.h * r));
    const scale = HEAD_W / sw;
    const canvas = document.createElement("canvas");
    canvas.width = HEAD_W;
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    // the page at its own resolution, not the one it's shown at
    const full = new Image();
    full.src = src;
    await full.decode();
    ctx.drawImage(full, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    if (cutWhite) {
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const lum = 0.299 * px[i]! + 0.587 * px[i + 1]! + 0.114 * px[i + 2]!;
        // a soft ramp, so the ink's edge keeps its antialiasing
        if (lum >= 250) px[i + 3] = 0;
        else if (lum > 232) px[i + 3] = Math.round(255 * (1 - (lum - 232) / 18));
      }
      ctx.putImageData(data, 0, 0);
    }
    return canvas.toDataURL("image/png");
  };

  const save = async () => {
    const data = await preview();
    if (!data) return;
    const res = await fetch("/__tuner/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "peek", n: slot, data }),
    });
    setNote(res.ok ? `written to peek/u${slot}.png` : `failed (${res.status})`);
    onSaved();
    setTimeout(() => setNote(null), 2600);
  };

  return (
    <div className="cutter">
      <div className="cutter-stage">
        <img
          ref={imgRef}
          src={src}
          alt={name}
          draggable={false}
          onLoad={(e) => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])}
          onMouseDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            start.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            setBox({ x: start.current.x, y: start.current.y, w: 0, h: 0 });
          }}
          onMouseMove={(e) => {
            const from = start.current;
            if (!from) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            setBox({
              x: Math.min(from.x, x),
              y: Math.min(from.y, y),
              w: Math.abs(x - from.x),
              h: Math.abs(y - from.y),
            });
          }}
          onMouseUp={() => {
            start.current = null;
          }}
          onMouseLeave={() => {
            start.current = null;
          }}
        />
        {box && box.w > 2 && (
          <div className="cutter-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} />
        )}
      </div>
      <div className="cutter-controls">
        <span className="row-name">{name}</span>
        <label className="check">
          <input type="checkbox" checked={cutWhite} onChange={(e) => setCutWhite(e.target.checked)} />
          drop white to transparent
        </label>
        <label>
          into
          <select value={slot} onChange={(e) => setSlot(Number(e.target.value))}>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                u{n}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!box || box.w < 8} onClick={() => void save()}>
          cut & write
        </button>
        {note && <span className="saved">{note}</span>}
      </div>
    </div>
  );
}

/* ── the page ─────────────────────────────────────────────────────── */

function fileText(peeks: Peek[], frames: Record<number, HeroFrame>): string {
  const framed = Object.entries(frames)
    .filter(([, f]) => f.x !== 0 || f.y !== 0 || f.zoom !== 1)
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return [
    ...peeks.map((p) => `  { n: ${p.n}, x: ${p.x}, w: ${p.w}, drop: ${p.drop}, lift: ${p.lift} },`),
    "@@",
    ...framed.map(([n, f]) => `  ${n}: { x: ${f.x}, y: ${f.y}, zoom: ${f.zoom} },`),
  ].join("\n");
}

function Tuner() {
  const [peeks, setPeeks] = useState<Peek[]>(PEEKS);
  const [frames, setFrames] = useState<Record<number, HeroFrame>>(() => {
    const all: Record<number, HeroFrame> = {};
    for (let n = 1; n <= HERO_COUNT; n++) all[n] = HERO_FRAMES[n] ?? { ...HERO_CENTER };
    return all;
  });
  const [selected, setSelected] = useState(1);
  /** The arrows nudge whichever list was touched last. */
  const [aim, setAim] = useState<"peek" | "hero">("peek");
  const [heroPick, setHeroPick] = useState(1);
  const [hovering, setHovering] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  /** Bumped when a head is replaced, so every <img> of it reloads. */
  const [stamp, setStamp] = useState(0);
  const [sources, setSources] = useState<{ dir: string; names: string[] }>({ dir: "", names: [] });

  useEffect(() => {
    void fetch("/__tuner/sources")
      .then((r) => r.json())
      .then(setSources)
      .catch(() => setSources({ dir: "(dev server not running)", names: [] }));
  }, []);

  const pick = peeks.find((p) => p.n === selected);
  const pickHead = (n: number) => {
    setSelected(n);
    setAim("peek");
  };

  const save = async () => {
    const body = JSON.stringify({ peeks, frames });
    try {
      const res = await fetch("/__tuner/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      setSaved(res.ok ? "written to src/peek.ts" : `save failed (${res.status})`);
    } catch {
      setSaved("save failed — is the dev server running?");
    }
    setTimeout(() => setSaved(null), 2600);
  };

  // arrows nudge whatever was touched last, so a placement can be made exact
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!e.key.startsWith("Arrow")) return;
      if (document.activeElement instanceof HTMLInputElement) return;
      const step = e.shiftKey ? 5 : 1;
      if (aim === "hero") {
        const frame = frames[heroPick] ?? HERO_CENTER;
        e.preventDefault();
        const patch =
          e.key === "ArrowLeft"
            ? { x: frame.x - step }
            : e.key === "ArrowRight"
              ? { x: frame.x + step }
              : e.key === "ArrowUp"
                ? { y: frame.y - step }
                : { y: frame.y + step };
        setFrames({ ...frames, [heroPick]: { ...frame, ...patch } });
        return;
      }
      if (!pick) return;
      e.preventDefault();
      const patch =
        e.key === "ArrowLeft"
          ? { x: pick.x - step }
          : e.key === "ArrowRight"
            ? { x: pick.x + step }
            : e.key === "ArrowUp"
              ? { drop: pick.drop - step }
              : { drop: pick.drop + step };
      setPeeks(peeks.map((p) => (p.n === pick.n ? { ...p, ...patch } : p)));
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [aim, pick, peeks, frames, heroPick]);

  return (
    <div className="tuner">
      <header className="tuner-head">
        <h1>art tuner</h1>
        <div className="tuner-actions">
          <button onClick={() => setHovering(!hovering)}>
            {hovering ? "resting" : "hover lift"}
          </button>
          <button onClick={() => void navigator.clipboard.writeText(fileText(peeks, frames))}>
            copy values
          </button>
          <button className="primary" onClick={() => void save()}>
            save to peek.ts
          </button>
          {saved && <span className="saved">{saved}</span>}
        </div>
      </header>

      <section>
        <h2>the hero faces in their circles</h2>
        <p className="hint">
          drag a face to move it · scroll over it to resize · arrows nudge the picked one ·
          fit shows the whole picture, fill covers the circle · double-click resets
        </p>
        <div className="hero-grid">
          {Array.from({ length: HERO_COUNT }, (_, i) => i + 1).map((n) => (
            <HeroCircle
              key={n}
              n={n}
              frame={frames[n] ?? HERO_CENTER}
              picked={heroPick === n}
              onPick={() => {
                setHeroPick(n);
                setAim("hero");
              }}
              onChange={(next) => setFrames({ ...frames, [n]: next })}
            />
          ))}
        </div>
      </section>
      <section>
        <h2>the titlebar heads</h2>
        <PeekBand
          peeks={peeks}
          setPeeks={setPeeks}
          selected={selected}
          setSelected={pickHead}
          hovering={hovering}
          stamp={stamp}
        />
        <div className="rows">
          {peeks.map((p) => (
            <div className={`row ${selected === p.n ? "picked" : ""}`} key={p.n} onClick={() => pickHead(p.n)}>
              <img src={`/peek/u${p.n}.png?v=${stamp}`} alt="" className="row-thumb" />
              <span className="row-name">u{p.n}</span>
              {(["x", "w", "drop", "lift"] as const).map((field) => (
                <label key={field}>
                  {field}
                  <input
                    type="number"
                    value={p[field]}
                    onChange={(e) =>
                      setPeeks(
                        peeks.map((q) =>
                          q.n === p.n ? { ...q, [field]: Number(e.target.value) } : q,
                        ),
                      )
                    }
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section>
        <details>
          <summary>
            <h2>the raw pages — cut a head out of one</h2>
          </summary>
          <p className="hint">
            drag a box over a head · it's cut at the page's own resolution, scaled to {HEAD_W}px wide,
            and written straight into web/public/peek. {sources.dir}
          </p>
          <div className="cutters">
            {sources.names.map((name) => (
              <PageCutter key={name} name={name} onSaved={() => setStamp(Date.now())} />
            ))}
            {sources.names.length === 0 && (
              <p className="hint">no ruri*.png pages found in {sources.dir} — set RURI_ART to point elsewhere</p>
            )}
          </div>
        </details>
      </section>

    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Tuner />);
