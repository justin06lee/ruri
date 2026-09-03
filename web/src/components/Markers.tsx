import { useLayoutEffect, useMemo, useRef, useState } from "react";

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
 *
 * The pill is painted a little outside those characters, which is what
 * makes it a pill rather than a highlight — so the mirror is given room on
 * either side to paint into (a chip at the start of a line would otherwise
 * be cut down its left edge), and two chips side by side are held further
 * apart than two words are, since a single space leaves their pills all but
 * touching — solid ink needs more air between it than letters do. That
 * extra space is the composer's, not the prompt's: it goes out as one.
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

/** How far outside its characters a chip's pill is painted — the mirror
 *  keeps this much room on either side so the pill is never cut off at the
 *  edge of the box. Matches the ring in `.marker-chip`, with a pixel over. */
export const CHIP_BLEED = 3;

/**
 * An attachment marker with either space inside, or a slash command: a
 * word starting with "/" that stands on its own — not a path ("/tmp/x"
 * has a second slash), not a quoted mention ('/compact' has a quote against
 * the slash, not whitespace), not the tail of a URL — and not one still
 * being typed: a command is a chip once a space (or a line break) follows
 * it, so "/comm" on its way to "/commit" stays words under the caret.
 */
const MARKER = /\[(image|video|file|region)[  ]#(\d+)\]|(?<=^|\s)\/([a-z0-9][\w:.-]*)(?=\s)/g;

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

/** Markers with plain spaces inside, made unbreakable. Same length, so no
 *  caret moves. */
function bindMarkers(text: string): string {
  return text.replace(/\[(image|video|file|region) #(\d+)\]/g, `[$1${MARKER_SPACE}#$2]`);
}

/** Punctuation that may sit against a chip: "see [image #2]." reads as a
 *  sentence, "see [image #2] ." does not. */
const CLOSERS = ".,;:!?)";
const OPENERS = "(";

/** Spaces between two chips standing side by side. One leaves their pills
 *  0.6px apart, which reads as a single wide chip; this is what looks like
 *  two things. Anything wider that is already there is left alone. */
const CHIP_GAP = 3;

/**
 * The prompt with the right amount of space around every chip: one space
 * between a chip and a word against it — a word touching a chip reads as
 * being inside it — and `CHIP_GAP` between chip and chip. Only ever adds;
 * what is already there is left alone.
 *
 * Returns the new text and where a caret at `caret` now stands: a space put
 * in ahead of it moves it along, one put in behind it (between a word just
 * typed and the chip after it) does not.
 */
export function spaceMarkers(text: string, caret = 0): { text: string; caret: number } {
  const markers = findMarkers(text);
  if (markers.length === 0) return { text, caret };
  const starts = new Set(markers.map((marker) => marker.start));
  /** How many spaces to put in at a position. Two chips with nothing at all
   *  between them are one boundary asked about from both sides, so the
   *  larger answer is the one that stands. */
  const inserts = new Map<number, number>();
  const want = (at: number, n: number) => {
    if (n > 0) inserts.set(at, Math.max(inserts.get(at) ?? 0, n));
  };
  for (const marker of markers) {
    // the run of spaces on each side of the chip, and what stands past it
    let left = marker.start;
    while (text[left - 1] === " ") left -= 1;
    let right = marker.end;
    while (text[right] === " ") right += 1;
    const before = text[left - 1];
    const after = text[right];
    // a command is the words the person typed — nothing is ever pushed
    // into the middle of one being written
    if (marker.kind !== "command" && before !== undefined && !/\s/.test(before) && !OPENERS.includes(before)) {
      want(marker.start, 1 - (marker.start - left));
    }
    if (after !== undefined && !/\s/.test(after)) {
      const need = starts.has(right)
        ? CHIP_GAP
        : marker.kind === "command"
          ? 0
          : CLOSERS.includes(after)
            ? 0
            : 1;
      want(marker.end, need - (right - marker.end));
    }
  }
  if (inserts.size === 0) return { text, caret };
  let out = "";
  let at = 0;
  let moved = caret;
  for (const cut of [...inserts.keys()].sort((a, b) => a - b)) {
    const n = inserts.get(cut)!;
    out += text.slice(at, cut) + " ".repeat(n);
    at = cut;
    if (caret > cut) moved += n;
  }
  return { text: out + text.slice(at), caret: moved };
}

/** The prompt as it is sent: the space a chip was held apart from its
 *  neighbour by is the composer's doing, not something typed, so a run
 *  between two chips comes back down to the one space it reads as. */
function closeMarkerGaps(text: string): string {
  const markers = findMarkers(text);
  let out = "";
  let at = 0;
  for (let i = 0; i < markers.length - 1; i += 1) {
    const gap = text.slice(markers[i]!.end, markers[i + 1]!.start);
    if (gap.length < 2 || /[^ ]/.test(gap)) continue;
    out += text.slice(at, markers[i]!.end) + " ";
    at = markers[i + 1]!.start;
  }
  return out + text.slice(at);
}

/** Markers as the composer keeps them: the space inside each made
 *  unbreakable (a rewound prompt, a queued one, a saved draft from before
 *  this arrive with plain ones), and a space kept between a marker and the
 *  word against it. */
export function holdMarkers(text: string): string {
  return spaceMarkers(bindMarkers(text)).text;
}

/** The same for text the caret is in: what it becomes, and where the caret
 *  belongs in it. */
export function holdMarkersAt(text: string, caret: number): { text: string; caret: number } {
  return spaceMarkers(bindMarkers(text), caret);
}

/** The prompt as it goes out: markers with plain spaces, the way every
 *  reader of them expects. */
export function releaseMarkers(text: string): string {
  return closeMarkerGaps(text).replace(/\[(image|video|file|region) #(\d+)\]/g, "[$1 #$2]");
}

/**
 * The prompt with one marker taken out, along with the space that separated
 * it from its neighbour — all of it, since a chip beside a chip is held
 * apart by more than one — so the words either side close up cleanly.
 * Returns the new text and where the caret belongs: where the marker was.
 */
export function removeMarker(text: string, marker: Marker): { text: string; caret: number } {
  let cutEnd = marker.end;
  while (text[cutEnd] === " ") cutEnd += 1;
  let cutStart = marker.start;
  if (cutEnd === marker.end) while (text[cutStart - 1] === " ") cutStart -= 1;
  return { text: text.slice(0, cutStart) + text.slice(cutEnd), caret: cutStart };
}

/** The prompt with every marker `drop` says yes to taken out. */
export function stripMarkers(text: string, drop: (marker: Marker) => boolean): string {
  let out = text;
  // from the end, so the earlier markers' positions stay true — and the
  // spacing is settled once at the end, for the same reason
  for (const marker of findMarkers(text).filter(drop).reverse()) out = removeMarker(out, marker).text;
  return spaceMarkers(out).text;
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
  let cutEnd = marker.end;
  while (text[cutEnd] === " ") cutEnd += 1;
  let cutStart = marker.start;
  if (cutEnd === marker.end) while (text[cutStart - 1] === " ") cutStart -= 1;
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
  // the chip has landed among words that may be chips themselves; the
  // spacing rules settle what stands either side of it
  return spaceMarkers(`${before}${lead}${word}${tail}${after}`, before.length + lead.length + word.length);
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

/** What shapes text — read off the textarea at run time and set on the
 *  mirror, so the mirror wraps where the textarea wraps whatever the
 *  stylesheet, or the browser's own sheet for textareas, says. Shorthands
 *  before their longhands, so a longhand the browser knows wins. */
const SHAPING = [
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-stretch",
  "font-variant",
  "font-kerning",
  "font-feature-settings",
  "font-variation-settings",
  "font-optical-sizing",
  "font-size-adjust",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-transform",
  "text-indent",
  "text-rendering",
  "tab-size",
  "white-space",
  "white-space-collapse",
  "text-wrap-mode",
  "text-wrap-style",
  "overflow-wrap",
  "word-break",
  "hyphens",
  "direction",
  "text-align",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
] as const;

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
  const textRef = useRef<HTMLDivElement>(null);
  const markers = useMemo(() => findMarkers(text).filter(present), [text, present]);
  const parts = useMemo(() => segments(text, markers), [text, markers]);
  const [drag, setDrag] = useState<{ marker: Marker; to: number | null; moved: boolean } | null>(null);

  // The mirror stands on the textarea's padding box — inside its border,
  // as wide as its text, a scrollbar's width off both — and its text is
  // shaped by the textarea's own computed style, read here rather than
  // copied in the stylesheet: whatever the textarea ends up with, the
  // browser's own sheet for textareas included, the mirror has too. It
  // follows the textarea's scroll by translation: a mirror that scrolled on
  // its own could only go as far as its own content let it, and one line
  // of disagreement became a lasting offset. After every render, and on
  // every scroll, focus, resize, and font arrival, since any of those can
  // move the words; and if after all that the two still disagree on how
  // many lines the prompt is, the chips come off rather than stand on the
  // wrong words.
  useLayoutEffect(() => {
    const area = areaRef.current;
    const mirror = mirrorRef.current;
    const inner = textRef.current;
    if (!area || !mirror || !inner) return;
    let frame = 0;
    const check = () => {
      frame = 0;
      mirror.classList.toggle("off", Math.abs(inner.offsetHeight - area.scrollHeight) > 2);
    };
    const sync = () => {
      const style = getComputedStyle(area);
      for (const prop of SHAPING) {
        const value = style.getPropertyValue(prop);
        if (value && inner.style.getPropertyValue(prop) !== value) inner.style.setProperty(prop, value);
      }
      const width = `${area.clientWidth}px`;
      // the box is the textarea's padding box grown by the pill's bleed on
      // either side (content-box, so the padding is that room) — the words
      // still start exactly where the textarea's do
      mirror.style.left = `${area.offsetLeft + area.clientLeft - CHIP_BLEED}px`;
      mirror.style.top = `${area.offsetTop + area.clientTop}px`;
      mirror.style.width = width;
      mirror.style.height = `${area.clientHeight}px`;
      inner.style.width = width;
      inner.style.transform = `translate(${-area.scrollLeft}px, ${-area.scrollTop}px)`;
      // the line count is compared a frame later, once the box has been
      // fitted to the text (that happens after this, in the composer)
      if (!frame) frame = requestAnimationFrame(check);
    };
    sync();
    area.addEventListener("scroll", sync);
    area.addEventListener("focus", sync);
    document.addEventListener("selectionchange", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    void document.fonts?.ready.then(sync);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      area.removeEventListener("scroll", sync);
      area.removeEventListener("focus", sync);
      document.removeEventListener("selectionchange", sync);
      observer.disconnect();
    };
  });

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
      <div className="composer-mirror-text" ref={textRef}>
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
    </div>
  );
}
