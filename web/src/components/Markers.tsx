import { useEffect, useMemo, useRef, useState } from "react";

/**
 * The [image #1] markers and the /commands in the composer, as things
 * rather than words.
 *
 * The prompt is a plain textarea, and a marker in it is text: the caret
 * runs through it, a double-click selects half of it, and moving it means
 * retyping it. This lays a mirror of the prompt over the textarea — the
 * same text in the same font at the same width, so it wraps in exactly the
 * same places — with the plain words invisible and each marker drawn as a
 * chip. The chips are the only part that takes the mouse: hover one and it
 * lights (and the composer lights the attachment it stands for), drag one
 * and it goes where you drop it, click one and the composer opens what it
 * stands for — or, for a command, takes it out. Everything else falls
 * through to the textarea, which is still what you type in.
 *
 * A chip is the marker's own characters with the brackets made invisible —
 * never wider or narrower than the text it stands on, or the mirror would
 * wrap differently from the textarea beneath it and the chips would drift
 * off their words. For the same reason the space inside a marker is a
 * non-breaking one: a plain space is a place the textarea may wrap, and a
 * marker wrapped in half is two chip fragments, one of them cut off at the
 * edge of the box. The composer writes markers with that space and reads
 * either; the prompt that goes out has plain spaces again.
 */

/** A marker as written in the prompt. */
export interface Marker {
  kind: "image" | "video" | "file" | "region" | "command";
  /** The attachment's number; 0 for a command. */
  n: number;
  start: number;
  end: number;
  /** The marker's own characters. */
  text: string;
}

/** The space inside a marker, as the composer writes it. */
export const MARKER_SPACE = " ";

/**
 * An attachment marker with either space inside, or a slash command: a
 * word starting with "/" that stands on its own — not a path ("/tmp/x"
 * has a second slash), not a quoted mention ('/compact' has a quote against
 * the slash, not whitespace), not the tail of a URL.
 */
const MARKER = /\[(image|video|file|region)[  ]#(\d+)\]|(?<=^|\s)\/([a-z0-9][\w:.-]*)(?=\s|$)/g;

export function findMarkers(text: string): Marker[] {
  const out: Marker[] = [];
  for (const match of text.matchAll(MARKER)) {
    if (match[3] !== undefined) {
      out.push({ kind: "command", n: 0, start: match.index, end: match.index + match[0].length, text: match[0] });
      continue;
    }
    out.push({
      kind: match[1] as Marker["kind"],
      n: Number(match[2]),
      start: match.index,
      end: match.index + match[0].length,
      text: match[0],
    });
  }
  return out;
}

/** The marker text for an attachment, spaced so the textarea never wraps it in half. */
export function markerText(kind: "image" | "video" | "file" | "region", n: number): string {
  return `[${kind}${MARKER_SPACE}#${n}]`;
}

/** Markers that arrived with plain spaces (a rewound prompt, a queued one,
 *  a saved draft from before this), made unbreakable. Same length, so no
 *  caret moves. */
export function holdMarkers(text: string): string {
  return text.replace(/\[(image|video|file|region) #(\d+)\]/g, `[$1${MARKER_SPACE}#$2]`);
}

/** The prompt as it goes out: markers with plain spaces, the way every
 *  reader of them expects. */
export function releaseMarkers(text: string): string {
  return text.replace(/\[(image|video|file|region) #(\d+)\]/g, "[$1 #$2]");
}

/**
 * The prompt with one marker taken out, along with the one space that
 * separated it from its neighbour, so the words either side close up
 * cleanly. Returns the new text and where the caret belongs: where the
 * marker was.
 */
export function removeMarker(text: string, marker: Marker): { text: string; caret: number } {
  const spaceAfter = text[marker.end] === " ";
  const spaceBefore = !spaceAfter && text[marker.start - 1] === " ";
  const cutStart = spaceBefore ? marker.start - 1 : marker.start;
  const cutEnd = spaceAfter ? marker.end + 1 : marker.end;
  return { text: text.slice(0, cutStart) + text.slice(cutEnd), caret: cutStart };
}

/** The prompt with every marker `drop` says yes to taken out. */
export function stripMarkers(text: string, drop: (marker: Marker) => boolean): string {
  let out = text;
  // from the end, so the earlier markers' positions stay true
  for (const marker of findMarkers(text).filter(drop).reverse()) out = removeMarker(out, marker).text;
  return out;
}

/**
 * The prompt with one marker moved: taken out where it was (with the one
 * space that separated it from its neighbour) and put down at `to`, with a
 * space on whichever side needs one — the same spacing a fresh marker gets.
 * Returns the new text and where the caret belongs: right after the chip.
 */
export function moveMarker(
  text: string,
  marker: Marker,
  to: number,
): { text: string; caret: number } {
  const word = text.slice(marker.start, marker.end);
  const spaceAfter = text[marker.end] === " ";
  const spaceBefore = !spaceAfter && text[marker.start - 1] === " ";
  const cutStart = spaceBefore ? marker.start - 1 : marker.start;
  const cutEnd = spaceAfter ? marker.end + 1 : marker.end;
  const cut = text.slice(0, cutStart) + text.slice(cutEnd);
  let at = to <= cutStart ? to : to >= cutEnd ? to - (cutEnd - cutStart) : cutStart;
  // a drop inside a word lands at the word's nearer edge: a chip between
  // "he" and "re" is never what was meant
  if (/\S/.test(cut[at - 1] ?? " ") && /\S/.test(cut[at] ?? " ")) {
    let left = at;
    while (left > 0 && /\S/.test(cut[left - 1]!)) left -= 1;
    let right = at;
    while (right < cut.length && /\S/.test(cut[right]!)) right += 1;
    at = at - left <= right - at ? left : right;
  }
  const before = cut.slice(0, at);
  const after = cut.slice(at);
  const lead = before && !/\s$/.test(before) ? " " : "";
  const tail = after && !/^\s/.test(after) ? " " : "";
  return {
    text: `${before}${lead}${word}${tail}${after}`,
    caret: before.length + lead.length + word.length,
  };
}

type Segment = { start: number; text: string; marker?: Marker };

/** The prompt cut into plain runs and markers, in order. */
function segments(text: string, markers: Marker[]): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const marker of markers) {
    if (marker.start > at) out.push({ start: at, text: text.slice(at, marker.start) });
    out.push({ start: marker.start, text: text.slice(marker.start, marker.end), marker });
    at = marker.end;
  }
  if (at < text.length || out.length === 0) out.push({ start: at, text: text.slice(at) });
  return out;
}

/** The text index under a point: in the textarea, or in the mirror over it. */
function indexAt(area: HTMLTextAreaElement, mirror: HTMLElement, x: number, y: number): number | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  let node: Node | undefined;
  let offset = 0;
  try {
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    } else {
      const range = document.caretRangeFromPoint(x, y);
      if (range) {
        node = range.startContainer;
        offset = range.startOffset;
      }
    }
  } catch {
    return null;
  }
  if (!node) return null;
  if (node === area || area.contains(node)) return Math.min(offset, area.value.length);
  if (!mirror.contains(node)) return null;
  // a point over a chip or over the mirror's own text: the segment it sits
  // in knows where in the prompt it starts
  const element = node instanceof Element ? node : node.parentElement;
  const seg = element?.closest<HTMLElement>("[data-start]");
  if (!seg) return null;
  const start = Number(seg.dataset["start"]);
  if (seg.classList.contains("marker-chip")) {
    // no dropping inside another chip — before or after it, by halves
    const rect = seg.getBoundingClientRect();
    return x < rect.left + rect.width / 2 ? start : start + (seg.textContent?.length ?? 0);
  }
  return start + (node.nodeType === Node.TEXT_NODE ? offset : 0);
}

export function MarkerMirror({
  areaRef,
  text,
  present,
  onMove,
  onOpen,
  onHover,
}: {
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  /** Whether a marker still stands for an attachment in the strip — one
   *  whose file was removed is words again, and stays words. */
  present: (marker: Marker) => boolean;
  /** A chip was dropped somewhere else in the prompt. */
  onMove: (next: { text: string; caret: number }) => void;
  /** A chip was clicked, not dragged: open what it stands for (an
   *  attachment's preview), or take it out (a command). */
  onOpen: (marker: Marker) => void;
  /** The pointer is over a chip (or has left the last one). */
  onHover: (marker: Marker | null) => void;
}) {
  const mirrorRef = useRef<HTMLDivElement>(null);
  const markers = useMemo(() => findMarkers(text).filter(present), [text, present]);
  const parts = useMemo(() => segments(text, markers), [text, markers]);
  const [drag, setDrag] = useState<{ marker: Marker; to: number | null; moved: boolean } | null>(null);

  // The mirror follows the textarea's scroll, and its width follows the
  // textarea's text width — a scrollbar that appears takes a few pixels
  // off the wrapping width, and the mirror has to give up the same few.
  useEffect(() => {
    const area = areaRef.current;
    const mirror = mirrorRef.current;
    if (!area || !mirror) return;
    const sync = () => {
      mirror.scrollTop = area.scrollTop;
      mirror.style.right = `${area.offsetWidth - area.clientWidth}px`;
    };
    sync();
    area.addEventListener("scroll", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    return () => {
      area.removeEventListener("scroll", sync);
      observer.disconnect();
    };
  }, [areaRef, text]);

  const startDrag = (e: React.PointerEvent<HTMLSpanElement>, marker: Marker) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ marker, to: null, moved: false });
  };

  const onPointerMove = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!drag) return;
    const area = areaRef.current;
    const mirror = mirrorRef.current;
    if (!area || !mirror) return;
    const to = indexAt(area, mirror, e.clientX, e.clientY);
    setDrag((d) => (d ? { ...d, to, moved: true } : d));
  };

  const endDrag = (e: React.PointerEvent<HTMLSpanElement>) => {
    if (!drag) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const { marker, to, moved } = drag;
    setDrag(null);
    if (!moved) {
      onHover(null);
      onOpen(marker);
      return;
    }
    if (to === null || (to >= marker.start && to <= marker.end)) return;
    onMove(moveMarker(text, marker, to));
  };

  // the drop caret: the plain run the pointer is over, split where it is
  const dropAt = drag?.moved ? drag.to : null;

  return (
    <div className={`composer-mirror ${drag?.moved ? "dragging" : ""}`} ref={mirrorRef} aria-hidden>
      {parts.map((seg) =>
        seg.marker ? (
          <span
            key={seg.start}
            className={`marker-chip ${seg.marker.kind} ${drag?.marker.start === seg.start ? "lifted" : ""}`}
            data-start={seg.start}
            title={
              seg.marker.kind === "command"
                ? "A command — runs before the prompt. Click to take it out, drag to move it"
                : "Click to see it, drag to move it in the prompt"
            }
            onPointerDown={(e) => startDrag(e, seg.marker!)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={() => setDrag(null)}
            onPointerEnter={() => onHover(seg.marker!)}
            onPointerLeave={() => onHover(null)}
          >
            {seg.marker.kind === "command" ? (
              seg.text
            ) : (
              <>
                <span className="marker-bracket">[</span>
                {seg.text.slice(1, -1)}
                <span className="marker-bracket">]</span>
              </>
            )}
          </span>
        ) : dropAt !== null && dropAt >= seg.start && dropAt <= seg.start + seg.text.length ? (
          <span key={seg.start} data-start={seg.start}>
            {seg.text.slice(0, dropAt - seg.start)}
            <span className="drop-caret" />
            {seg.text.slice(dropAt - seg.start)}
          </span>
        ) : (
          <span key={seg.start} data-start={seg.start}>
            {seg.text}
          </span>
        ),
      )}
      {/* a prompt ending in a newline needs something on its last line for
          the mirror to stand as tall as the textarea does */}
      {"​"}
    </div>
  );
}
