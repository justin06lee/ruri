/**
 * One clock for every spinning star.
 *
 * A CSS animation that never ends has the window draw a fresh frame 60 to
 * 120 times a second for as long as it is on screen, and the new-component
 * star can sit in the chat header all day. So the stars are turned from
 * here: one timer, ten steps a second, a turn every 5.5 seconds. Each star
 * is on its own layer (`will-change: transform` in styles.css), so a step
 * re-composites that little square, never the page. The timer runs only
 * while a star is in view (lib/awake.ts watchSeen) and the window is awake;
 * a star scrolled away holds still and snaps to the clock's angle when it
 * comes back. Not at all for someone who has asked for reduced motion.
 *
 * And not for ever: a star turns for a while when it arrives and whenever
 * the window wakes, then holds still — a star standing there still says
 * new, and a header that keeps a timer going all day for it does not.
 */
import { isAwake, subscribeAwake, watchSeen } from "./awake";

const FRAME_MS = 100;
const TURN_MS = 5500;
const STEP_DEG = (360 * FRAME_MS) / TURN_MS;
/** How long the stars turn, from a star arriving or the window waking. */
const SPIN_FOR_MS = 20_000;

/** The stars in view — the only ones a step turns. */
const seen = new Set<HTMLElement>();
let angle = 0;
let timer: number | undefined;
/** Until when the stars may turn. */
let until = 0;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function turn(star: HTMLElement): void {
  star.style.transform = `rotate(${angle.toFixed(1)}deg)`;
}

function step(): void {
  angle = (angle + STEP_DEG) % 360;
  for (const star of seen) turn(star);
  if (Date.now() >= until) settle();
}

/** Start or stop the clock to match: stars in view, window awake, and
 *  their while not yet up. */
function settle(): void {
  const wanted = seen.size > 0 && isAwake() && Date.now() < until;
  if (wanted && timer === undefined) timer = window.setInterval(step, FRAME_MS);
  else if (!wanted && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

subscribeAwake(() => {
  if (isAwake()) until = Date.now() + SPIN_FOR_MS;
  settle();
});

/** A ref for anything that should turn with the stars. */
export function spinStar(el: HTMLElement | null): void | (() => void) {
  if (!el || reducedMotion()) return;
  until = Date.now() + SPIN_FOR_MS;
  turn(el);
  const unwatch = watchSeen(el, (inView) => {
    if (inView) {
      seen.add(el);
      turn(el);
    } else {
      seen.delete(el);
    }
    settle();
  });
  return () => {
    unwatch();
    seen.delete(el);
    settle();
  };
}
