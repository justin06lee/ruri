import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { findMarkers, moveMarker, fittedHeight, CHIP_BLEED, type Marker } from "../lib/markers";

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

type Segment = { start: number; text: string; marker?: Marker };

/** A prompt ending in a newline has an empty last line, which the mirror
 *  needs something on to stand as tall as the textarea does. A zero-width
 *  space, and only here: anywhere else it would sit after a line's trailing
 *  spaces and stop them hanging off the edge the way the textarea's do. */
function lineEnd(at: number): React.ReactNode {
  return (
    <span key={`end-${at}`} className="line-end" data-start={at}>
      {"\u200b"}
    </span>
  );
}

/** How many times (400ms apart) the mirror looks again on its own while it
 *  and the textarea disagree, before it waits for something to change. */
const MIRROR_RETRIES = 8;

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
  // the mark holding an empty last line open stands for no character: a
  // point over it is the end of the prompt
  if (seg.classList.contains("line-end")) return start;
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
  refit,
  onMove,
  onOpen,
  onHover,
}: {
  areaRef: React.RefObject<HTMLTextAreaElement | null>;
  text: string;
  /** Whether a marker still stands for an attachment in the strip — one
   *  whose file was removed is words again, and stays words. */
  present: (marker: Marker) => boolean;
  /** Fit the box to its text again. The mirror asks for this when the two
   *  disagree on how many lines the prompt is, since much the likeliest
   *  reason is a box left taller than its words. */
  refit?: () => void;
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
  // every scroll, focus, resize, font arrival, and return to the window,
  // since any of those can move the words; and if after all that the two
  // still disagree on how many lines the prompt is, the chips come off
  // rather than stand on the wrong words.
  /** The sync as this render made it — the listeners below, registered
   *  once, call whichever is current. Null while there are no chips. */
  const syncRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const area = areaRef.current;
    const mirror = mirrorRef.current;
    const inner = textRef.current;
    if (!area || !mirror || !inner) return;
    // No chips, nothing to line up. An empty prompt — every chat's, most of
    // the time — has no line box in the mirror at all, so the two could
    // only ever disagree, and the check below used to go round every 400ms
    // for as long as the chat was open, measuring and restyling for nothing.
    // The first chip re-renders this and it starts looking.
    if (markers.length === 0) {
      syncRef.current = null;
      return;
    }
    let frame = 0;
    let retry = 0;
    let refitted = false;
    /** Looks taken on its own since the last time the two agreed. */
    let tries = 0;
    const check = () => {
      frame = 0;
      // against the text's true height as last fitted, never `scrollHeight`
      // straight off the textarea — see `fitBox` for the lie it tells
      if (Math.abs(inner.offsetHeight - (fittedHeight(area) ?? area.scrollHeight)) <= 2) {
        refitted = false;
        tries = 0;
        mirror.classList.remove("off");
        return;
      }
      // Taking the chips off is the last answer, not the first. A textarea
      // taller than its own text reports its height as the text's, so a box
      // left unfitted — a window resized with no keystroke after it — reads
      // exactly like a mirror wrapping wrongly. Fit the box and look once
      // more; only a disagreement that survives that is the real thing.
      if (refit && !refitted) {
        refitted = true;
        refit();
        frame = requestAnimationFrame(check);
        return;
      }
      mirror.classList.add("off");
      // Off is not final. A disagreement is often a moment's — a box mid-
      // transition, a font landing, a layout still settling — and nothing
      // else may come along to look again until the next keystroke. So
      // while the chips are off, the mirror keeps looking on its own — for
      // a few seconds, not for ever: one that outlasts those is settled,
      // and a keystroke, a resize, a scroll or the window coming back will
      // look again.
      if (tries >= MIRROR_RETRIES) return;
      retry = window.setTimeout(() => {
        retry = 0;
        refitted = false;
        tries += 1;
        sync();
      }, 400);
    };
    const sync = () => {
      if (retry) {
        clearTimeout(retry);
        retry = 0;
      }
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
    syncRef.current = sync;
    sync();
    return () => {
      syncRef.current = null;
      if (frame) cancelAnimationFrame(frame);
      if (retry) clearTimeout(retry);
    };
  });

  // Every scroll, focus, resize, font arrival and return to the window can
  // move the words, so each looks again — through whichever sync stands,
  // so the listeners are registered once, not on every keystroke.
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const sync = () => syncRef.current?.();
    area.addEventListener("scroll", sync);
    area.addEventListener("focus", sync);
    document.addEventListener("selectionchange", sync);
    // An app in the background paints no frames, so the check that rides on
    // one never runs while ruri is behind another window — and whatever the
    // window did in the meantime (a resize, a display change) is only
    // measurable on the way back. Coming back is a moment to look again.
    window.addEventListener("focus", sync);
    document.addEventListener("visibilitychange", sync);
    const observer = new ResizeObserver(sync);
    observer.observe(area);
    void document.fonts?.ready.then(sync);
    return () => {
      area.removeEventListener("scroll", sync);
      area.removeEventListener("focus", sync);
      document.removeEventListener("selectionchange", sync);
      window.removeEventListener("focus", sync);
      document.removeEventListener("visibilitychange", sync);
      observer.disconnect();
    };
  }, [areaRef]);

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

  // a plain run: the same characters, invisible, so the chips after it
  // stand where the textarea's words do; split where a dragged chip would
  // land, to show the caret
  const plain = (seg: Segment) => {
    const drop =
      dropAt !== null && dropAt >= seg.start && dropAt <= seg.start + seg.text.length
        ? dropAt - seg.start
        : null;
    return drop !== null ? (
      <span key={seg.start} data-start={seg.start}>
        {seg.text.slice(0, drop)}
        <span className="drop-caret" />
        {seg.text.slice(drop)}
      </span>
    ) : (
      <span key={seg.start} data-start={seg.start}>
        {seg.text}
      </span>
    );
  };

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
          ) : (
            plain(seg)
          ),
        )}
        {text.endsWith("\n") ? lineEnd(text.length) : null}
      </div>
    </div>
  );
}
