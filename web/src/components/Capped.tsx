import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

/**
 * A list that stops growing. Up to `max` items it is as tall as they are;
 * past that it holds at that height and scrolls, with half of the next
 * item showing under the last whole one, so it reads as more below rather
 * than as the end of the list.
 *
 * Counted in items rather than pixels because the rows it holds are not
 * one height — a plugin with a description, a server with its env — and a
 * cap in pixels would cut one list at three rows and another at twelve.
 * The page around a long list stays the length it was built for: Settings
 * with a hundred plugins installed is not a hundred rows longer.
 */
/** Hold a list at `max` items' height — or let it be, when it is shorter. */
function fit(el: HTMLElement | null, max: number): void {
  if (!el) return;
  const cut = el.children[max];
  if (!cut) {
    // short enough: no cap, and no scroll box either — a scroll box clips
    // whatever pokes out sideways (a focus ring, a shadow)
    el.style.maxHeight = "";
    el.style.overflowY = "";
    return;
  }
  // how far down the first item past the cap starts, border and padding
  // above it included — which is what max-height counts, border-box
  const box = cut.getBoundingClientRect();
  const top = box.top - el.getBoundingClientRect().top + el.scrollTop;
  el.style.maxHeight = `${Math.round(top + box.height / 2)}px`;
  el.style.overflowY = "auto";
}

export function Capped({
  max = 6,
  className = "",
  children,
}: {
  /** Whole items shown before it scrolls. */
  max?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // every render: the items may have changed, and measuring is cheap
  useLayoutEffect(() => fit(ref.current, max));
  // and whenever the width changes, since rows that wrap change height
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const watch = new ResizeObserver(() => fit(el, max));
    watch.observe(el);
    return () => watch.disconnect();
  }, [max]);
  return (
    <div ref={ref} className={`capped ${className}`}>
      {children}
    </div>
  );
}
