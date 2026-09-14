/**
 * One slow clock for everything on screen that moves by itself — the working
 * dots, the thinking doodle, the streaming cursor, an agent's turning ring.
 *
 * Each of those used to be an infinite CSS animation, and an infinite
 * animation has Chromium draw the window afresh at the display's rate — up
 * to 120 frames a second on a ProMotion screen — for as long as it is on
 * screen, even when what it shows changes twice a second (the doodle's poses
 * are hard half-second swaps). With a few agents working that never
 * stopped: the GPU process and the window server busy all day, for a dot.
 *
 * Here nothing is animated. A mover is an element whose `data-<kind>` this
 * clock steps — only as often as its look needs, and only on that element,
 * so a step restyles one span and repaints one small square; styles.css
 * says what each step looks like. The clock runs only while a mover is
 * mounted and the window is both visible and in front: a ruri behind the
 * app you are working in holds still in its resting pose (step 0), and
 * someone who has asked for reduced motion never sees it move at all.
 */
import { useEffect, useState } from "react";

const TICK_MS = 250;

/** `data-turn` is taken — every exchange in a transcript carries its turn
 *  id under it — so the ring's kind is "spin". */
export type Beat = "pulse" | "blink" | "doodle" | "spin";

/** How many ticks one step of each kind lasts, and how many steps it has. */
const KINDS: Record<Beat, { every: number; steps: number }> = {
  // full, soft, faint, soft — one breath a second
  pulse: { every: 1, steps: 4 },
  // half a second on, half a second off
  blink: { every: 2, steps: 2 },
  // a pose swap every half second; the tilts come round every four
  doodle: { every: 2, steps: 8 },
  // an eighth of a turn a step, a whole turn every two seconds
  spin: { every: 1, steps: 8 },
};

const movers = new Map<HTMLElement, Beat>();
let tick = 0;
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

function step(): void {
  tick += 1;
  for (const [el, kind] of movers) {
    const { every, steps } = KINDS[kind];
    if (tick % every === 0) el.dataset[kind] = String((tick / every) % steps);
  }
}

/** Start or stop the clock to match: something to move, a window to see it. */
function settle(): void {
  const wanted = movers.size > 0 && isAwake() && !reducedMotion();
  if (wanted && timer === undefined) {
    timer = window.setInterval(step, TICK_MS);
  } else if (!wanted && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
    // holding still means the resting pose, not wherever it happened to stop
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
 * should move (`ref={working ? beat("pulse") : undefined}`) and it comes off
 * the clock the moment it stops.
 */
export function beat(kind: Beat): (el: HTMLElement | null) => void | (() => void) {
  let ref = refs.get(kind);
  if (!ref) {
    ref = (el) => {
      if (!el) return;
      el.dataset[kind] = "0";
      movers.set(el, kind);
      settle();
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
