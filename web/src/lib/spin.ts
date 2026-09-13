/**
 * One clock for every spinning star.
 *
 * A CSS animation that never ends has the window draw a fresh frame 60 to
 * 120 times a second for as long as it is on screen — cheap frames, but
 * each one wakes the GPU, and the new-component star can sit in the chat
 * header all day. So the stars are turned from here instead: one timer,
 * ten steps a second, a turn every 5.5 seconds as before. Each star is on
 * its own layer (`will-change: transform` in styles.css), so a step only
 * re-composites that little square, never the page. The timer only runs
 * while a star is mounted and the window can be seen, and not at all for
 * someone who has asked their system for reduced motion.
 */

const FRAME_MS = 100;
const TURN_MS = 5500;
const STEP_DEG = (360 * FRAME_MS) / TURN_MS;

const stars = new Set<HTMLElement>();
let angle = 0;
let timer: number | undefined;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function step(): void {
  angle = (angle + STEP_DEG) % 360;
  const transform = `rotate(${angle.toFixed(1)}deg)`;
  for (const star of stars) star.style.transform = transform;
}

/** Start or stop the clock to match: stars on screen, window visible. */
function settle(): void {
  const wanted = stars.size > 0 && !document.hidden;
  if (wanted && timer === undefined) timer = window.setInterval(step, FRAME_MS);
  else if (!wanted && timer !== undefined) {
    window.clearInterval(timer);
    timer = undefined;
  }
}

document.addEventListener("visibilitychange", settle);

/** A ref for anything that should turn with the stars. */
export function spinStar(el: HTMLElement | null): void | (() => void) {
  if (!el || reducedMotion()) return;
  el.style.transform = `rotate(${angle.toFixed(1)}deg)`;
  stars.add(el);
  settle();
  return () => {
    stars.delete(el);
    settle();
  };
}
