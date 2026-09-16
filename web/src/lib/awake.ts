/**
 * Whether anyone can see ruri — the window on screen and the one in use —
 * and which elements are actually in view.
 *
 * Asleep (behind another app, minimised, hidden, on another Space) nothing
 * on the window moves: the clocks stop where they stand (beat.ts, spin.ts)
 * and any entrance caught halfway pauses, to finish on waking. State goes
 * on changing underneath — transcripts, statuses, gauges all apply as they
 * arrive — only the animation is frozen.
 *
 * `watchSeen` is the same idea one element at a time: a mover scrolled out
 * of view or inside a hidden pane is not worth a step either.
 *
 * `?awake` in the URL keeps the window awake for good — for the scripts
 * that drive it from behind whatever else is open (scripts/shot.mjs). The
 * state is marked on <html> as `data-asleep`, for anyone inspecting.
 */

const forced = new URLSearchParams(location.search).has("awake");

function seen(): boolean {
  return forced || (!document.hidden && document.hasFocus());
}

let awake = seen();
document.documentElement.toggleAttribute("data-asleep", !awake);

/** The window can be seen and is the one being used. */
export function isAwake(): boolean {
  return awake;
}

const listeners = new Set<() => void>();

/** Hear about the window waking or going to sleep. */
export function subscribeAwake(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** What was running as the window went to sleep: paused there, and only
 *  those — anything that starts while asleep (a file dropped on the window
 *  from behind) plays, since someone is plainly looking at it. */
let paused: Animation[] = [];

function update(): void {
  const next = seen();
  if (next === awake) return;
  awake = next;
  document.documentElement.toggleAttribute("data-asleep", !next);
  if (next) {
    for (const animation of paused) animation.play();
    paused = [];
  } else {
    paused = document.getAnimations().filter((animation) => animation.playState === "running");
    for (const animation of paused) animation.pause();
  }
  for (const listener of listeners) listener();
}

window.addEventListener("focus", update);
window.addEventListener("blur", update);
document.addEventListener("visibilitychange", update);

/* ── which elements are in view ──────────────────────────────────── */

const watched = new Map<Element, (seen: boolean) => void>();
let observer: IntersectionObserver | undefined;

/**
 * Hear whether an element is in the viewport — off while it is scrolled
 * away or inside something hidden. The first report comes on the next
 * frame; until then it counts as unseen. Returns the function that stops
 * watching.
 */
export function watchSeen(el: Element, onChange: (seen: boolean) => void): () => void {
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) watched.get(entry.target)?.(entry.isIntersecting);
  });
  watched.set(el, onChange);
  observer.observe(el);
  return () => {
    watched.delete(el);
    observer?.unobserve(el);
  };
}
