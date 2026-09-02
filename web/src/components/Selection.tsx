import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";

/**
 * Selection flags for the transcript.
 *
 * Selecting a long stretch of a reply with the mouse means holding the
 * button down while the page scrolls under you, and letting go a line
 * early means starting over. So once something is selected — a
 * double-clicked word, a dragged run — a flag stands at each end of it,
 * and the flags are what you drag: scroll wherever you like with the
 * wheel first, the selection stays put, then pull a flag to where the
 * selection should reach. Near the top or bottom of the transcript a
 * dragged flag scrolls it for you. Copy works as it always did.
 *
 * The flags are drawn over the page (fixed, in a portal), and while one is
 * being dragged neither takes the pointer, so the text under it is what
 * the caret lookup finds. Clicking anywhere else collapses the selection,
 * and the flags go with it.
 */

interface Flag {
  /** The point on the text the flag marks: the line's top edge, at the
   *  selection's start or end. */
  x: number;
  y: number;
  h: number;
}

/** How near the transcript's edge a dragged flag starts it scrolling. */
const EDGE = 44;
/** Pixels per frame at the edge. */
const CREEP = 9;

/** The caret position under a point — Chromium's spelling of it. */
function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  try {
    const pos = doc.caretPositionFromPoint?.(x, y);
    if (pos) return { node: pos.offsetNode, offset: pos.offset };
    const range = document.caretRangeFromPoint(x, y);
    return range ? { node: range.startContainer, offset: range.startOffset } : null;
  } catch {
    return null;
  }
}

/** Where the selection's ends are on screen, if it lives in `within`. */
function flagsOf(within: HTMLElement): { start: Flag; end: Flag } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  if (!within.contains(range.commonAncestorContainer)) return null;
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  const first = rects[0] ?? range.getBoundingClientRect();
  const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
  if (first.height === 0 && last.height === 0) return null;
  return {
    start: { x: first.left, y: first.top, h: first.height },
    end: { x: last.right, y: last.top, h: last.height },
  };
}

export function SelectionFlags({ scrollerRef }: { scrollerRef: RefObject<HTMLElement | null> }) {
  const [flags, setFlags] = useState<{ start: Flag; end: Flag } | null>(null);
  const [dragging, setDragging] = useState<"start" | "end" | null>(null);
  /** The selection's fixed end while the other is dragged, and where the
   *  pointer took hold relative to the flag's own point. */
  const drag = useRef<{
    which: "start" | "end";
    anchor: { node: Node; offset: number };
    grab: { dx: number; dy: number };
    lineH: number;
    pointer: { x: number; y: number };
    creep: number | null;
  } | null>(null);
  /** A mouse selection in progress: no flags until the button comes up,
   *  or they would chase the pointer. */
  const selecting = useRef(false);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const refresh = () => {
      if (selecting.current) return;
      setFlags(flagsOf(scroller));
    };
    const down = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.(".sel-flag")) return;
      selecting.current = true;
      setFlags(null);
    };
    const up = () => {
      if (!selecting.current) return;
      selecting.current = false;
      // the selection settles a tick after the button comes up
      setTimeout(refresh, 0);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && flagsOf(scroller)) window.getSelection()?.removeAllRanges();
    };
    document.addEventListener("selectionchange", refresh);
    scroller.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    scroller.addEventListener("scroll", refresh);
    window.addEventListener("resize", refresh);
    window.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("selectionchange", refresh);
      scroller.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      scroller.removeEventListener("scroll", refresh);
      window.removeEventListener("resize", refresh);
      window.removeEventListener("keydown", key);
    };
  }, [scrollerRef]);

  /** Move the dragged end of the selection to wherever the pointer is. */
  const extendTo = (px: number, py: number) => {
    const d = drag.current;
    const scroller = scrollerRef.current;
    if (!d || !scroller) return;
    // the flag's point is the line's top edge; sample the middle of the
    // line, where the words are
    const x = px - d.grab.dx;
    const y = py - d.grab.dy + d.lineH / 2;
    const at = caretAt(x, y);
    if (!at || !scroller.contains(at.node)) return;
    const sel = window.getSelection();
    if (!sel) return;
    sel.setBaseAndExtent(d.anchor.node, d.anchor.offset, at.node, at.offset);
  };

  /** Scroll the transcript while the pointer holds near its edge. */
  const creep = () => {
    const d = drag.current;
    const scroller = scrollerRef.current;
    if (!d || !scroller) return;
    const box = scroller.getBoundingClientRect();
    const py = d.pointer.y;
    let dy = 0;
    if (py < box.top + EDGE) dy = -CREEP * Math.min(1, (box.top + EDGE - py) / EDGE + 0.3);
    else if (py > box.bottom - EDGE) dy = CREEP * Math.min(1, (py - (box.bottom - EDGE)) / EDGE + 0.3);
    if (dy !== 0) {
      scroller.scrollTop += dy;
      extendTo(d.pointer.x, d.pointer.y);
      d.creep = requestAnimationFrame(creep);
    } else {
      d.creep = null;
    }
  };

  const grab = (e: React.PointerEvent<HTMLDivElement>, which: "start" | "end") => {
    if (e.button !== 0 || !flags) return;
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    // the end that stays: the other one
    const anchor =
      which === "end"
        ? { node: range.startContainer, offset: range.startOffset }
        : { node: range.endContainer, offset: range.endOffset };
    const flag = flags[which];
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      which,
      anchor,
      grab: { dx: e.clientX - flag.x, dy: e.clientY - flag.y },
      lineH: flag.h,
      pointer: { x: e.clientX, y: e.clientY },
      creep: null,
    };
    setDragging(which);
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.pointer = { x: e.clientX, y: e.clientY };
    extendTo(e.clientX, e.clientY);
    if (d.creep === null) d.creep = requestAnimationFrame(creep);
  };

  const release = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    if (d.creep !== null) cancelAnimationFrame(d.creep);
    drag.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // already released
    }
    setDragging(null);
    const scroller = scrollerRef.current;
    if (scroller) setFlags(flagsOf(scroller));
  };

  if (!flags) return null;
  const scroller = scrollerRef.current;
  const box = scroller?.getBoundingClientRect();
  /** A flag whose line has scrolled out of the transcript stays out of
   *  sight rather than standing over the header or the composer. */
  const shown = (f: Flag) => !box || (f.y + f.h > box.top && f.y < box.bottom);

  return createPortal(
    <>
      {(["start", "end"] as const).map((which) => {
        const f = flags[which];
        if (!shown(f)) return null;
        return (
          <div
            key={which}
            className={`sel-flag ${which} ${dragging ? "dragging" : ""}`}
            style={{ left: f.x, top: f.y, height: f.h }}
            onPointerDown={(e) => grab(e, which)}
            onPointerMove={move}
            onPointerUp={release}
            onPointerCancel={release}
          >
            <span className="sel-bar" />
            <span className="sel-knob" title="Drag to change what's selected" />
          </div>
        );
      })}
    </>,
    document.body,
  );
}
