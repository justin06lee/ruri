/**
 * One slow clock for everything on screen that moves by itself — the
 * thinking doodle, the streaming cursor, an agent's turning ring. All three
 * live in the chat that is open; nothing anywhere else in the window moves.
 *
 * Each of those used to be an infinite CSS animation, and an infinite
 * animation has Chromium draw the window afresh at the display's rate — up
 * to 120 frames a second on a ProMotion screen — for as long as it is on
 * screen, even when what it shows changes twice a second (the doodle's poses
 * are hard half-second swaps).
 *
 * Here nothing is animated. A mover is an element whose `data-<kind>` this
 * clock steps, and the clock ticks exactly as often as the fastest mover on
 * screen changes, never more — the doodle alone is two ticks a second — and
 * a tick that would leave an element as it is does not touch it. Each mover
 * is its own compositor layer (styles.css), so a step changes a transform or
 * an opacity on that one layer: nothing on the page is repainted for it. The
 * clock runs only while a mover is mounted and the window is both visible
 * and in front: a ruri behind the app you are working in holds still in its
 * resting pose (step 0), and someone who has asked for reduced motion never
 * sees it move at all.
 */
import { useEffect, useState } from "react";

/** `data-turn` is taken — every exchange in a transcript carries its turn
 *  id under it — so the ring's kind is "spin". */
export type Beat = "blink" | "doodle" | "spin";

/** How long each step of each kind lasts, and how many steps it has. */
const KINDS: Record<Beat, { ms: number; steps: number }> = {
  // half a second on, half a second off
  blink: { ms: 500, steps: 2 },
  // a pose swap every half second; the tilts come round every four
  doodle: { ms: 500, steps: 8 },
  // an eighth of a turn a step, a whole turn every two seconds
  spin: { ms: 250, steps: 8 },
};

const movers = new Map<HTMLElement, Beat>();
/** Time on the clock: what it has counted rather than what the wall says,
 *  so a tick that lands late still moves every mover exactly one step. */
let elapsed = 0;
/** What the clock ticks at now; 0 is stopped. */
let every = 0;
let timer: number | undefined;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The window can be seen and is the one being used. */
export function isAwake(): boolean {
  return !document.hidden && document.hasFocus();
}

const wakeListeners = new Set<() => void>();

/** Hear about the window coming to the front or going behind. */
export function subscribeAwake(listener: () => void): () => void {
  wakeListeners.add(listener);
  return () => wakeListeners.delete(listener);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** The slowest tick that still lands on every step of what is mounted. */
function tickFor(): number {
  let ms = 0;
  for (const kind of new Set(movers.values())) ms = gcd(ms, KINDS[kind].ms);
  return ms;
}

function stepOf(kind: Beat): string {
  const { ms, steps } = KINDS[kind];
  return String(Math.floor(elapsed / ms) % steps);
}

function step(): void {
  elapsed += every;
  for (const [el, kind] of movers) {
    const next = stepOf(kind);
    if (el.dataset[kind] !== next) el.dataset[kind] = next;
  }
}

/** Start, stop or re-pace the clock to match: what is mounted, and a
 *  window to see it in. */
function settle(): void {
  const want = isAwake() && !reducedMotion() ? tickFor() : 0;
  if (want === every) return;
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  every = want;
  if (want > 0) {
    // re-paced: stay on a boundary of the new tick
    elapsed -= elapsed % want;
    timer = window.setInterval(step, want);
  } else {
    // holding still means the resting pose, not wherever it happened to stop
    elapsed = 0;
    for (const [el, kind] of movers) el.dataset[kind] = "0";
  }
}

function wake(): void {
  settle();
  for (const listener of wakeListeners) listener();
}

window.addEventListener("focus", wake);
window.addEventListener("blur", wake);
document.addEventListener("visibilitychange", wake);

const refs = new Map<Beat, (el: HTMLElement | null) => void | (() => void)>();

/**
 * A ref that puts an element on the clock. One per kind, the same function
 * every render, so React attaches it once; pass it only while the element
 * should move (`ref={running ? beat("spin") : undefined}`) and it comes off
 * the clock the moment it stops.
 */
export function beat(kind: Beat): (el: HTMLElement | null) => void | (() => void) {
  let ref = refs.get(kind);
  if (!ref) {
    ref = (el) => {
      if (!el) return;
      movers.set(el, kind);
      settle();
      // in step with the others already moving
      el.dataset[kind] = every > 0 ? stepOf(kind) : "0";
      return () => {
        movers.delete(el);
        delete el.dataset[kind];
        settle();
      };
    };
    refs.set(kind, ref);
  }
  return ref;
}

/**
 * Run `step` every `ms` while the window is in front, and `rest` (the still
 * pose) whenever it goes behind — for the few things that must move faster
 * than the beat (the music waveform). Returns the cleanup, for an effect.
 */
export function whileAwake(step: () => void, ms: number, rest?: () => void): () => void {
  let timer: number | undefined;
  const run = () => {
    const want = isAwake() && !reducedMotion();
    if (want && timer === undefined) {
      step();
      timer = window.setInterval(step, ms);
    } else if (!want) {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
      rest?.();
    }
  };
  run();
  const off = subscribeAwake(run);
  return () => {
    off();
    if (timer !== undefined) window.clearInterval(timer);
  };
}

/**
 * The time, for a line that counts up (a turn's clock, an agent's). It
 * moves every `everyMs` while the window is in front and stands still
 * while it is not — a count nobody can see is a render for nothing — then
 * catches up the moment the window comes back. `on` false stops it.
 */
export function useNow(everyMs: number, on = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    let timer: number | undefined;
    const run = () => {
      const want = isAwake();
      if (want && timer === undefined) {
        setNow(Date.now());
        timer = window.setInterval(() => setNow(Date.now()), everyMs);
      } else if (!want && timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    };
    run();
    const off = subscribeAwake(run);
    return () => {
      off();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [everyMs, on]);
  return now;
}
