/**
 * One slow clock per pace for everything on screen that moves by itself —
 * the thinking doodle, the sidebar's dragons, the streaming cursor, an
 * agent's turning ring.
 *
 * None of these is a CSS animation: an infinite animation has Chromium
 * draw the window afresh at the display's rate for as long as it is on
 * screen, even when what it shows changes twice a second. Instead a mover
 * is an element whose step a clock sets — as `data-<kind>`, or for the
 * ring as a `--spin` its turn is worked out from — and each clock ticks
 * exactly as often as its movers change. A tick that would leave an
 * element as it is does not touch it. Each mover is its own compositor
 * layer (styles.css), so a step changes one layer and repaints nothing.
 *
 * A clock runs only while one of its movers is mounted, in view
 * (lib/awake.ts watchSeen) and the window is awake. Asleep, or scrolled
 * out of view, a mover holds where it was and is not written to; coming
 * back it snaps to the clock's current step. Someone who has asked for
 * reduced motion never sees any of it move.
 */
import { useEffect, useState } from "react";
import { isAwake, subscribeAwake, watchSeen } from "./awake";

export { isAwake, subscribeAwake };

/** `data-turn` is taken — every exchange in a transcript carries its turn
 *  id under it — so the ring's kind is "spin". */
export type Beat = "blink" | "chomp" | "doodle" | "spin";

/** How long each step of each kind lasts and how many steps it has — and,
 *  for a kind whose CSS works its pose out from the step rather than
 *  listing every one, the custom property the step is written to. */
const KINDS: Record<Beat, { ms: number; steps: number; prop?: string }> = {
  // half a second on, half a second off
  blink: { ms: 500, steps: 2 },
  // a pose swap every half second; the tilts come round every four
  doodle: { ms: 500, steps: 8 },
  // a row's dragon: jaws open, jaws shut, on the doodle's own half second
  // (the same clock, so every head in the sidebar bites with the doodle)
  chomp: { ms: 500, steps: 2 },
  // twelve degrees a step at fifteen steps a second: a whole turn every two
  // seconds, as it always took, in thirty steps where it had eight
  spin: { ms: 67, steps: 30, prop: "--spin" },
};

const movers = new Map<HTMLElement, Beat>();
/** The movers currently in view — the only ones a tick writes to. */
const seen = new Set<HTMLElement>();
/** The clocks running, one per pace, and how many ticks each has counted:
 *  what it has counted rather than what the wall says, so a tick that
 *  lands late still moves every mover exactly one step. */
const clocks = new Map<number, { timer: number; ticks: number }>();
/** Where each stopped clock stood, so it picks up rather than starting over. */
const stood = new Map<number, number>();

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function stepOf(kind: Beat): string {
  const { ms, steps } = KINDS[kind];
  return String((clocks.get(ms)?.ticks ?? stood.get(ms) ?? 0) % steps);
}

function write(el: HTMLElement, kind: Beat): void {
  const step = stepOf(kind);
  const prop = KINDS[kind].prop;
  if (prop) {
    if (el.style.getPropertyValue(prop) !== step) el.style.setProperty(prop, step);
  } else if (el.dataset[kind] !== step) {
    el.dataset[kind] = step;
  }
}

function tick(ms: number): void {
  const clock = clocks.get(ms);
  if (!clock) return;
  clock.ticks += 1;
  for (const el of seen) {
    const kind = movers.get(el);
    if (kind && KINDS[kind].ms === ms) write(el, kind);
  }
}

/** Start or stop each clock to match: movers of its pace in view, and a
 *  window awake to see them in. */
function settle(): void {
  const want = new Set<number>();
  if (isAwake() && !reducedMotion()) {
    for (const el of seen) {
      const kind = movers.get(el);
      if (kind) want.add(KINDS[kind].ms);
    }
  }
  for (const [ms, clock] of clocks) {
    if (want.has(ms)) continue;
    window.clearInterval(clock.timer);
    clocks.delete(ms);
    stood.set(ms, clock.ticks);
  }
  for (const ms of want) {
    if (clocks.has(ms)) continue;
    clocks.set(ms, { ticks: stood.get(ms) ?? 0, timer: window.setInterval(() => tick(ms), ms) });
  }
}

subscribeAwake(settle);

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
      // in step with the others already moving
      write(el, kind);
      const unwatch = watchSeen(el, (inView) => {
        if (inView) {
          seen.add(el);
          // back in view: wherever the clock has got to since
          write(el, kind);
        } else {
          seen.delete(el);
        }
        settle();
      });
      return () => {
        unwatch();
        seen.delete(el);
        movers.delete(el);
        const prop = KINDS[kind].prop;
        if (prop) el.style.removeProperty(prop);
        else delete el.dataset[kind];
        settle();
      };
    };
    refs.set(kind, ref);
  }
  return ref;
}

/**
 * Run `step` every `ms` while the window is awake — and, given `el`, only
 * while that element is in view — and `rest` (the still pose) whenever it
 * stops. For the few things that must move faster than the beat (the
 * music waveform). Returns the cleanup, for an effect.
 */
export function whileAwake(step: () => void, ms: number, rest?: () => void, el?: Element | null): () => void {
  let timer: number | undefined;
  let inView = !el;
  const run = () => {
    const want = isAwake() && inView && !reducedMotion();
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
  const unwatch = el
    ? watchSeen(el, (next) => {
        inView = next;
        run();
      })
    : undefined;
  return () => {
    off();
    unwatch?.();
    if (timer !== undefined) window.clearInterval(timer);
  };
}

/**
 * The time, for a line that counts up (a turn's clock, an agent's, the
 * gauges' countdowns). It moves every `everyMs` while the window is awake
 * and stands still while it is not — a count nobody can see is a render for
 * nothing — then catches up the moment the window wakes. `on` false stops it.
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
