/**
 * Whether anyone can see ruri — the window on screen and the one in use —
 * and what happens as that changes.
 *
 * Asleep (behind another app, minimised, hidden, on another Space) the
 * window draws nothing at all. Nothing on it moves: the clocks stop where
 * they stand (beat.ts, spin.ts), and an entrance caught halfway pauses
 * where it is, to finish on waking. Nothing on it changes either: the
 * server sends it nothing live (the `view` message's `live`), and whatever
 * it does send is held unapplied (store.ts). With not one element
 * different, Chromium has no frame to draw.
 *
 * Waking, it catches up all at once, and what is new fades in rather than
 * snapping into place: for a moment after waking, everything the catch-up
 * adds to the page is faded up from nothing, and every line of text it
 * changes from faint.
 *
 * `?awake` in the URL keeps it awake for good — for the scripts that drive
 * a window from behind whatever else is open (scripts/shot.mjs). The state
 * is marked on <html> as `data-asleep`, for anyone inspecting the window.
 */

/** How long after waking a new arrival counts as the catch-up's. It covers
 *  the round trip the catch-up itself takes (store.ts sends the view, the
 *  server answers with what changed). */
const FADE_WINDOW_MS = 1500;
const FADE_MS = 380;

const forced = new URLSearchParams(location.search).has("awake");

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

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
    // watching for what the catch-up brings starts before anything applies it
    fadeArrivals();
  } else {
    paused = document.getAnimations().filter((animation) => animation.playState === "running");
    for (const animation of paused) animation.pause();
  }
  for (const listener of listeners) listener();
}

window.addEventListener("focus", update);
window.addEventListener("blur", update);
document.addEventListener("visibilitychange", update);

/* ── what is new fades in ────────────────────────────────────────── */

let watcher: MutationObserver | undefined;
let watchTimer: number | undefined;

/** Fade up one arrival — unless something it sits inside is already
 *  fading up, which carries it along. The terminal is left alone: its
 *  rows are redrawn wholesale, and a shell's backlog is not news. */
function fade(el: Element, faded: WeakSet<Element>, changed: boolean): void {
  if (faded.has(el) || el.closest(".xterm")) return;
  for (let up = el.parentElement; up; up = up.parentElement) if (faded.has(up)) return;
  faded.add(el);
  // opacity alone: a transform would fight any element that has its own
  // (a turning star, a waveform bar)
  el.animate(changed ? [{ opacity: 0.3 }, { opacity: 1 }] : [{ opacity: 0 }, { opacity: 1 }], {
    duration: FADE_MS,
    easing: "ease-out",
  });
}

/** For the moment after waking, fade in what the catch-up puts on the page. */
function fadeArrivals(): void {
  const root = document.getElementById("root");
  if (!root || reducedMotion()) return;
  watcher?.disconnect();
  window.clearTimeout(watchTimer);
  const faded = new WeakSet<Element>();
  watcher = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        const el = record.target.parentElement;
        if (el) fade(el, faded, true);
        continue;
      }
      for (const node of record.addedNodes) {
        if (node instanceof Element) fade(node, faded, false);
        else if (node.parentElement) fade(node.parentElement, faded, true);
      }
    }
  });
  watcher.observe(root, { childList: true, subtree: true, characterData: true });
  watchTimer = window.setTimeout(() => {
    watcher?.disconnect();
    watcher = undefined;
  }, FADE_WINDOW_MS);
}
