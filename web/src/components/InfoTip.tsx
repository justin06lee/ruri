import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** How wide the card is, and how far it keeps from the window's edges. */
const CARD_W = 260;
const MARGIN = 12;

/**
 * A small ⓘ beside a setting whose name doesn't say enough by itself:
 * click it and a little card says what the setting is for. It stands in
 * for the sentence that used to sit under the row — the row stays one
 * line, and the words are there for whoever wants them.
 *
 * The card is put on the page's top layer, so a scrolling or clipped
 * panel never cuts it off, and it goes on a click anywhere else, Escape,
 * or a scroll.
 */
export function InfoTip({ children, label = "What's this?" }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const card = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const height = card.current?.offsetHeight ?? 80;
    const up = r.bottom + 8 + height > window.innerHeight - MARGIN;
    const left = Math.max(
      MARGIN,
      Math.min(r.left + r.width / 2 - CARD_W / 2, window.innerWidth - CARD_W - MARGIN),
    );
    setAt({ left, top: up ? r.top - 8 - height : r.bottom + 8, up });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      const target = e.target as Node | null;
      if (target && (button.current?.contains(target) || card.current?.contains(target))) return;
      setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("scroll", close, true);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", close);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`info-tip${open ? " open" : ""}`}
        aria-label={label}
        aria-expanded={open}
        onClick={() => {
          setAt(null);
          setOpen(!open);
        }}
      >
        <svg viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="8" cy="4.9" r="0.85" fill="currentColor" />
          <path d="M8 7.2v4.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div
            ref={card}
            className={`info-tip-card${at?.up ? " up" : ""}`}
            role="tooltip"
            style={{ width: CARD_W, left: at?.left ?? -9999, top: at?.top ?? -9999 }}
          >
            {children}
          </div>,
          document.body,
        )}
    </>
  );
}
