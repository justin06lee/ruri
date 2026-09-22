import { memo, useState, type HTMLAttributes } from "react";
import { type BandPicture, reacts, useBand } from "../band";
import { useShown } from "../pictures";
import { send } from "../store";

/**
 * The peek band: the pictures across the top of the sidebar, as Settings
 * has them (band.ts) — and the one picture, drawn the same way here and in
 * the editor.
 *
 * The band is also the window's title bar, and a title bar's drag region
 * swallows the mouse: nothing inside it ever sees the pointer arrive. A
 * picture with nothing to do on hover stays part of that region and drags
 * the window natively, as the whole band always has. One that does react
 * has to see the pointer, so it leaves the region (`.reacts`, styles.css)
 * — and then drags the window itself: pressing on it asks the shell to
 * move the window along with the cursor until the button comes up
 * (desktop/main.ts, windowDrag). Nothing is polled; the shell hears from
 * the page only while a press is held.
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
      className={`band-pic fx-host fx-${picture.effect}${hot ? " hot" : ""}${picture.invert ? " invert" : ""}${
        reacts(picture) ? " reacts" : ""
      } ${className}`}
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

/* ── dragging the window by a picture ────────────────────────────── */

// the same test main.tsx marks <body> by — asked directly, since this is
// read as the module loads, before main.tsx has got that far
const desktop = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
let moveFrame = 0;

/** What a reacting picture does with a press in the desktop app: carry
 *  the window, and a double-click does what a title bar's does. */
const carry: HTMLAttributes<HTMLDivElement> = {
  onPointerDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    send({ type: "window_drag", phase: "start" });
    try {
      // the moves come here however far the cursor goes, window or no window
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // a pointer the page no longer has: the press is over already
    }
  },
  onPointerMove(e) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId) || moveFrame) return;
    // one move a frame, however fast the pointer reports
    moveFrame = requestAnimationFrame(() => {
      moveFrame = 0;
      send({ type: "window_drag", phase: "move" });
    });
  },
  onPointerUp(e) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    send({ type: "window_drag", phase: "end" });
  },
  onPointerCancel() {
    cancelAnimationFrame(moveFrame);
    moveFrame = 0;
    send({ type: "window_drag", phase: "end" });
  },
  onDoubleClick() {
    send({ type: "window_drag", phase: "zoom" });
  },
};

/** The band itself, across the top of the sidebar. */
export function PeekBand() {
  const { pictures } = useBand();
  return (
    <span className="logo-peeks" aria-hidden>
      {pictures.map((picture) => (
        <BandPic key={picture.id} picture={picture} {...(desktop && reacts(picture) ? carry : {})} />
      ))}
    </span>
  );
}
