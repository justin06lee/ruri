import { memo, useState, type HTMLAttributes } from "react";
import { type BandPicture, offThemes, useBand } from "../band";
import { useShown } from "../pictures";
import { send } from "../store";

/**
 * The peek band: the pictures across the top of the sidebar, as Settings
 * has them (band.ts) — and the one picture, drawn the same way here and in
 * the editor.
 *
 * The band is also the window's title bar, and a title bar's drag region
 * swallows the mouse: nothing inside it ever sees the pointer arrive. The
 * last try cut the pictures with a hover out of that region one by one,
 * and hover still did not dependably reach them. So while ruri is the
 * window in use, the band is no drag region at all
 * (styles.css): every picture, and the gaps between them, see the pointer
 * like any other part of the page, and a press anywhere on the band
 * carries the window itself — the shell moves it along with the cursor
 * until the button comes up (desktop/main.ts, windowDrag). Nothing is
 * polled; the shell hears from the page only while a press is held.
 *
 * While ruri is behind another app, the band is the title bar again: a
 * press there is the window's first click, which the page never sees,
 * and macOS drags the window by it natively, bringing it forward as it
 * goes. Hover waits for the window to be in use, as the band's GIFs do.
 */

export const BandPic = memo(function BandPic({
  picture,
  quiet = false,
  className = "",
  style,
  onPointerEnter,
  onPointerLeave,
  ...rest
}: {
  picture: BandPicture;
  /** Hover does nothing — the editor, while a picture is being moved. */
  quiet?: boolean;
} & HTMLAttributes<HTMLDivElement>) {
  const [over, setOver] = useState(false);
  const hot = over && !quiet;
  const shown = useShown(picture, hot);

  return (
    <div
      {...rest}
      className={`band-pic fx-host fx-${picture.effect}${hot ? " hot" : ""}${picture.invert ? " invert" : ""}${offThemes(picture)} ${className}`}
      style={
        {
          left: picture.x,
          top: picture.drop,
          width: picture.w,
          "--amt": picture.amount,
          "--speed": `${picture.speed}ms`,
          ...style,
        } as React.CSSProperties
      }
      onPointerEnter={(e) => {
        setOver(true);
        onPointerEnter?.(e);
      }}
      onPointerLeave={(e) => {
        setOver(false);
        onPointerLeave?.(e);
      }}
    >
      <div className="band-art fx-art">
        <img className={`band-img${picture.flip ? " flip" : ""}`} src={shown} alt="" draggable={false} />
      </div>
    </div>
  );
});

/* ── dragging the window by the band ─────────────────────────────── */

// the same test main.tsx marks <body> by — asked directly, since this is
// read as the module loads, before main.tsx has got that far
const desktop = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
let moveFrame = 0;
/** What the press being carried is held by: the picture it landed on, so
 *  that picture stays the one under the pointer — hovered — the whole way,
 *  or the band itself, pressed between pictures. */
let holder: Element | null = null;

function letGo(): void {
  if (!holder) return;
  holder = null;
  cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  send({ type: "window_drag", phase: "end" });
}

/** What the band does with a press in the desktop app: carry the window,
 *  and a double-click does what a title bar's does. */
const carry: HTMLAttributes<HTMLSpanElement> = {
  onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const target = e.target instanceof Element ? e.target.closest(".band-pic") : null;
    const el = target ?? e.currentTarget;
    try {
      // the moves come here however far the cursor goes, window or no window
      el.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the page no longer has: the press is over already
      return;
    }
    holder = el;
    send({ type: "window_drag", phase: "start" });
  },
  onPointerMove(e) {
    if (!holder?.hasPointerCapture(e.pointerId) || moveFrame) return;
    // one move a frame, however fast the pointer reports
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      send({ type: "window_drag", phase: "move" });
    });
  },
  onPointerUp(e) {
    if (holder?.hasPointerCapture(e.pointerId)) holder.releasePointerCapture(e.pointerId);
    letGo();
  },
  onPointerCancel: letGo,
  onLostPointerCapture: letGo,
  onDoubleClick() {
    send({ type: "window_drag", phase: "zoom" });
  },
};

/** The band itself, across the top of the sidebar. */
export function PeekBand() {
  const { pictures } = useBand();
  return (
    <span className="logo-peeks" aria-hidden {...(desktop ? carry : {})}>
      {pictures.map((picture) => (
        <BandPic key={picture.id} picture={picture} />
      ))}
    </span>
  );
}
