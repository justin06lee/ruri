import { useLayoutEffect, useRef, useState } from "react";
import { HTTP_BASE, send, useRuri } from "../store";
import { Viewer } from "./Attachments";

/**
 * The bridge, from the user's side.
 *
 * A session that is driving a page or an app does it in a window nobody
 * sees, and this is the one place it shows: a small plate above the
 * composer with a live picture of the thing, its title and address, and
 * the one control that matters — take it over, give it back. Taking over
 * puts the real window on screen in front of you; giving it back hides it
 * again with the session still at the wheel. The picture opens in the
 * ordinary viewer at full size, read-only.
 *
 * It rides above the docked composer the way the rapid-fire plate does,
 * off the textbox's measured height and right edge, and stacks above that
 * plate when both are on. It appears when the session opens something and
 * goes when the session (or the close button) shuts it.
 */
export function BridgeStrip({ channelId, stacked }: { channelId: string; stacked?: boolean }) {
  const state = useRuri((s) => s.bridges[channelId]);
  const [open, setOpen] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  /* Right edge on the textbox's right edge — the same measurement the
     rapid-fire plate makes, for the same reason: the textbox is centred
     between the dragons, so its edge is wherever they leave it. */
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const pane = strip?.closest("main");
    const box = pane?.querySelector(".composer-box");
    if (!strip || !pane || !box) return;
    const align = () => {
      const inset = Math.round(pane.getBoundingClientRect().right - box.getBoundingClientRect().right);
      strip.style.setProperty("--bridge-inset", `${inset}px`);
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(pane);
    observer.observe(box);
    return () => observer.disconnect();
  }, [state !== undefined, stacked]);

  if (!state) return null;
  const src = state.previewUrl ? `${HTTP_BASE}${state.previewUrl}` : undefined;
  const kind = state.kind === "web" ? "page" : "app";

  return (
    <div className={`bridge-strip${stacked ? " stacked" : ""}`} ref={stripRef}>
      <div className="bridge-plate" title={state.takenOver ? "You have this — the session is still driving it" : "The session is driving this in a window you don't see"}>
        <button
          className="bridge-thumb"
          title={src ? "See it at full size" : "No picture yet"}
          disabled={!src}
          onClick={() => setOpen(true)}
        >
          {src ? <img src={src} alt="" /> : <span className="bridge-blank">{kind}</span>}
        </button>
        <div className="bridge-words">
          <span className="bridge-title">{state.title || kind}</span>
          <span className="bridge-address">{state.address}</span>
        </div>
        <button
          className={`bridge-toggle${state.takenOver ? " on" : ""}`}
          title={state.takenOver ? "Hide it again; the session keeps driving" : "Bring it on screen, in front, to work in it yourself"}
          onClick={() =>
            send({ type: state.takenOver ? "bridge_release" : "bridge_takeover", projectId: channelId })
          }
        >
          {state.takenOver ? "Give back" : "Take over"}
        </button>
        <button
          className="icon-button"
          title="Close it"
          onClick={() => send({ type: "bridge_close", projectId: channelId })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {open && src && (
        <Viewer
          target={{ kind: "image", src, label: state.title || kind, name: "preview.png", mediaType: "image/png" }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
