import { memo, useEffect, useMemo, useState, useSyncExternalStore, type HTMLAttributes } from "react";
import { type BandPicture, pictureUrl, reacts, useBand, usePicture, type Loaded } from "../band";
import { isAwake, subscribeAwake } from "../lib/awake";
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

function useAwake(): boolean {
  return useSyncExternalStore(subscribeAwake, isAwake);
}

/** A fresh URL for a picture's bytes while `on` — a new URL is a new
 *  image, so a GIF given one starts again from its first frame. */
function usePlay(loaded: Loaded | null, on: boolean): string | undefined {
  const url = useMemo(() => (on && loaded ? URL.createObjectURL(loaded.blob) : undefined), [on, loaded]);
  // let go of the last one as soon as it is off the screen
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

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
  const awake = useAwake();
  const art = usePicture(picture.src);
  const swap = usePicture(picture.hoverSrc);

  // what moves while the pointer is on it: the hover picture, if it moves,
  // or the picture itself when it is set to play on hover
  const playing =
    hot &&
    (picture.hoverSrc ? Boolean(swap?.animated) : Boolean(art?.animated) && picture.animate === "hover");
  const played = usePlay(picture.hoverSrc ? swap : art, playing);

  let shown: string;
  if (hot && picture.hoverSrc) shown = played ?? swap?.url ?? pictureUrl(picture.hoverSrc);
  else if (playing) shown = played ?? art?.url ?? pictureUrl(picture.src);
  // held on its first frame: set to be, or waiting for the pointer, or the
  // window is out of use (nothing on it moves then — lib/awake.ts)
  else if (art?.animated && art.still && (picture.animate !== "always" || !awake)) shown = art.still;
  else shown = art?.url ?? pictureUrl(picture.src);

  return (
    <div
      {...rest}
      className={`band-pic fx-${picture.effect}${hot ? " hot" : ""}${picture.invert ? " invert" : ""}${
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
      <div className="band-art">
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
