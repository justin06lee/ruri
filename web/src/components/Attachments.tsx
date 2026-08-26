import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../../../shared/protocol";
import { HTTP_BASE } from "../store";

/**
 * Prompt attachments: composer previews, the full-size viewer, and — for
 * images — drag-to-select region annotations whose crops ride along with the
 * prompt as extra images. Non-media files (pdf, text, source, …) get an
 * extension tile and, in the viewer, an inline pdf/text preview.
 */

export interface Region {
  /** Fractions of the image (0..1). */
  x: number;
  y: number;
  w: number;
  h: number;
  note: string;
}

export interface ComposerAttachment {
  id: string;
  file: File;
  kind: "image" | "video" | "file";
  mediaType: string;
  name: string;
  n: number;
  objectUrl: string;
  regions: Region[];
}

/** The file's extension, for the tile badge ("PDF", "TS", …). */
function extOf(name: string): string {
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return (ext || "file").slice(0, 5).toUpperCase();
}

const TEXT_EXT = new Set([
  "txt", "md", "markdown", "csv", "tsv", "log", "json", "jsonl", "xml", "yml", "yaml", "toml",
  "ini", "cfg", "conf", "env", "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "html",
  "svg", "py", "rs", "go", "c", "h", "cpp", "hpp", "java", "kt", "swift", "rb", "php", "sh",
  "zsh", "bash", "sql", "lock", "diff", "patch", "gitignore", "makefile",
]);

function isTextLike(name: string, mediaType?: string): boolean {
  if (mediaType?.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/javascript", "application/x-sh", "application/x-yaml"].includes(mediaType ?? "")) return true;
  return TEXT_EXT.has(name.split(".").pop()?.toLowerCase() ?? name.toLowerCase());
}

function isPdf(name: string, mediaType?: string): boolean {
  return mediaType === "application/pdf" || name.toLowerCase().endsWith(".pdf");
}

export async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    binary += String.fromCharCode(...buffer.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Render a region as its own image WITH spatial context: the crop takes
 * generous breathing room around the region, and the region itself is drawn
 * on it as a numbered white box (matching the composer's region UI) — a tight
 * crop of, say, empty space is meaningless without the surroundings.
 * Returns base64 PNG at natural resolution.
 */
export function cropRegion(objectUrl: string, region: Region, n: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const rx = region.x * img.naturalWidth;
      const ry = region.y * img.naturalHeight;
      const rw = Math.max(1, region.w * img.naturalWidth);
      const rh = Math.max(1, region.h * img.naturalHeight);
      // breathing room: at least 60% of the region's own size and 8% of the
      // image on every side, clamped to the image bounds
      const padX = Math.max(rw * 0.6, img.naturalWidth * 0.08);
      const padY = Math.max(rh * 0.6, img.naturalHeight * 0.08);
      const cx = Math.max(0, Math.round(rx - padX));
      const cy = Math.max(0, Math.round(ry - padY));
      const cw = Math.round(Math.min(img.naturalWidth, rx + rw + padX)) - cx;
      const ch = Math.round(Math.min(img.naturalHeight, ry + rh + padY)) - cy;
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, cx, cy, cw, ch, 0, 0, cw, ch);

      // the marker: white box with a dark rim, readable on any background
      const lw = Math.max(2, Math.round(Math.min(cw, ch) * 0.008));
      ctx.lineWidth = lw * 2;
      ctx.strokeStyle = "rgba(17, 17, 17, 0.9)";
      ctx.strokeRect(rx - cx, ry - cy, rw, rh);
      ctx.lineWidth = lw;
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(rx - cx, ry - cy, rw, rh);

      // numbered badge on the region's top-left corner (kept inside the crop)
      const r = Math.max(10, Math.round(Math.min(cw, ch) * 0.035));
      const bx = Math.min(Math.max(rx - cx, r + 1), cw - r - 1);
      const by = Math.min(Math.max(ry - cy, r + 1), ch - r - 1);
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.lineWidth = Math.max(1, Math.round(lw / 2));
      ctx.strokeStyle = "rgba(17, 17, 17, 0.9)";
      ctx.stroke();
      ctx.fillStyle = "#111";
      ctx.font = `700 ${Math.round(r * 1.1)}px "Space Grotesk", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(n), bx, by + Math.round(r * 0.06));

      resolve(canvas.toDataURL("image/png").split(",")[1] ?? "");
    };
    img.onerror = reject;
    img.src = objectUrl;
  });
}

/* ── viewer (full size + region editing for images) ──────────────── */

interface ViewTarget {
  kind: "image" | "video" | "file";
  src: string;
  label: string;
  /** Original filename — picks the preview mode for "file" kinds. */
  name?: string;
  mediaType?: string;
  /** Editable regions (composer); undefined = read-only view. */
  attachment?: ComposerAttachment;
}

/** Inline preview for a non-media file: pdf frame, text body, or a shrug. */
function FilePreview({ src, name, mediaType }: { src: string; name: string; mediaType?: string }) {
  const texty = !isPdf(name, mediaType) && isTextLike(name, mediaType);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!texty) return;
    let gone = false;
    fetch(src)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(`${res.status}`))))
      .then((body) => {
        if (gone) return;
        setText(body.length > 200_000 ? `${body.slice(0, 200_000)}\n… (truncated)` : body);
      })
      .catch(() => {
        if (!gone) setFailed(true);
      });
    return () => {
      gone = true;
    };
  }, [src, texty]);

  if (isPdf(name, mediaType)) return <iframe className="viewer-pdf" src={src} title={name} />;
  if (texty && text !== null) return <pre className="viewer-text">{text}</pre>;
  if (texty && !failed) return <div className="viewer-nopreview">loading…</div>;
  return <div className="viewer-nopreview">{name} — no preview for this file type</div>;
}

export function Viewer({
  target,
  onClose,
  onRegions,
}: {
  target: ViewTarget;
  onClose(): void;
  onRegions?(id: string, regions: Region[]): void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  // the drag rect also lives in a ref: mouse events can arrive faster than
  // React flushes state, and the commit must never read a stale closure
  const draftRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const regions = target.attachment?.regions ?? [];
  const editable = target.attachment !== undefined && target.kind === "image";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fraction = (e: React.MouseEvent) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!editable || e.button !== 0) return;
    startRef.current = fraction(e);
    draftRef.current = { ...startRef.current, w: 0, h: 0 };
    setDraft(draftRef.current);
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!startRef.current) return;
    const p = fraction(e);
    const s = startRef.current;
    draftRef.current = {
      x: Math.min(s.x, p.x),
      y: Math.min(s.y, p.y),
      w: Math.abs(p.x - s.x),
      h: Math.abs(p.y - s.y),
    };
    setDraft(draftRef.current);
  };
  const onMouseUp = () => {
    const rect = draftRef.current;
    if (!startRef.current || !rect) return;
    startRef.current = null;
    draftRef.current = null;
    if (rect.w > 0.02 && rect.h > 0.02 && target.attachment && onRegions) {
      onRegions(target.attachment.id, [...regions, { ...rect, note: "" }]);
    }
    setDraft(null);
  };

  const setNote = (i: number, note: string) => {
    if (!target.attachment || !onRegions) return;
    onRegions(
      target.attachment.id,
      regions.map((r, j) => (j === i ? { ...r, note } : r)),
    );
  };
  const removeRegion = (i: number) => {
    if (!target.attachment || !onRegions) return;
    onRegions(
      target.attachment.id,
      regions.filter((_, j) => j !== i),
    );
  };

  return (
    <div
      className="viewer-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="viewer-card">
        <div className="viewer-head">
          <span className="viewer-label">{target.label}</span>
          {editable && <span className="viewer-hint">drag on the image to mark a region</span>}
          <button className="icon-button" title="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        {target.kind === "image" ? (
          <div
            ref={stageRef}
            className={`viewer-stage ${editable ? "editable" : ""}`}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          >
            <img src={target.src} alt="" draggable={false} />
            {regions.map((r, i) => (
              <div
                key={i}
                className="region-box"
                style={{
                  left: `${r.x * 100}%`,
                  top: `${r.y * 100}%`,
                  width: `${r.w * 100}%`,
                  height: `${r.h * 100}%`,
                }}
              >
                <span className="region-index">{i + 1}</span>
              </div>
            ))}
            {draft && (
              <div
                className="region-box draft"
                style={{
                  left: `${draft.x * 100}%`,
                  top: `${draft.y * 100}%`,
                  width: `${draft.w * 100}%`,
                  height: `${draft.h * 100}%`,
                }}
              />
            )}
          </div>
        ) : target.kind === "video" ? (
          <div className="viewer-stage">
            <video src={target.src} controls />
          </div>
        ) : (
          <div className="viewer-stage file">
            <FilePreview
              src={target.src}
              name={target.name ?? target.label}
              {...(target.mediaType ? { mediaType: target.mediaType } : {})}
            />
          </div>
        )}

        {editable && regions.length > 0 && (
          <div className="region-list">
            {regions.map((r, i) => (
              <div key={i} className="region-row">
                <span className="region-index standalone">{i + 1}</span>
                <input
                  placeholder="What about this part?"
                  value={r.note}
                  autoFocus={i === regions.length - 1 && r.note === ""}
                  onChange={(e) => setNote(i, e.target.value)}
                />
                <button className="icon-button" title="Remove region" onClick={() => removeRegion(i)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── composer preview strip ──────────────────────────────────────── */

const SHORT_KIND = { image: "img", video: "vid", file: "file" } as const;

/** Thumbnail body for a non-media attachment: doc glyph + extension badge. */
function FileTile({ name }: { name: string }) {
  return (
    <div className="att-file">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 3v5h5M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      </svg>
      <span className="att-ext">{extOf(name)}</span>
    </div>
  );
}

export function AttachmentStrip({
  attachments,
  onRemove,
  onView,
}: {
  attachments: ComposerAttachment[];
  onRemove(id: string): void;
  onView(att: ComposerAttachment): void;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="att-strip">
      {attachments.map((att) => (
        <div key={att.id} className="att-thumb" title={att.name} onClick={() => onView(att)}>
          {att.kind === "image" ? (
            <img src={att.objectUrl} alt="" />
          ) : att.kind === "video" ? (
            <video src={att.objectUrl} muted />
          ) : (
            <FileTile name={att.name} />
          )}
          <span className="att-n">{`${SHORT_KIND[att.kind]} #${att.n}`}</span>
          {att.regions.length > 0 && <span className="att-regions">{att.regions.length}</span>}
          <button
            className="att-remove"
            title="Remove attachment"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(att.id);
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}

/* ── transcript thumbnails ───────────────────────────────────────── */

export function TranscriptAttachments({ attachments }: { attachments: Attachment[] }) {
  const [view, setView] = useState<ViewTarget | null>(null);
  return (
    <>
      <div className="att-strip in-msg">
        {attachments.map((att) => {
          const src = HTTP_BASE + (att.url ?? "");
          return (
            <div
              key={att.id}
              className="att-thumb"
              title={att.name}
              onClick={() =>
                setView({
                  kind: att.kind,
                  src,
                  label: `${att.kind} #${att.n} — ${att.name}`,
                  name: att.name,
                  mediaType: att.mediaType,
                })
              }
            >
              {att.kind === "image" ? (
                <img src={src} alt="" />
              ) : att.kind === "video" ? (
                <video src={src} muted />
              ) : (
                <FileTile name={att.name} />
              )}
              <span className="att-n">{`${SHORT_KIND[att.kind]} #${att.n}`}</span>
            </div>
          );
        })}
      </div>
      {view && <Viewer target={view} onClose={() => setView(null)} />}
    </>
  );
}
