/**
 * A capped box in the chat takes the wheel only once you are in it.
 *
 * The chat scrolls, and so do a few boxes in it with a height cap: the patch
 * under a Write or Edit, a compaction's brief, a permission's command, a
 * question's preview. Left alone, a long flick down the conversation stops
 * dead as one of them slides under the pointer, and the rest of the flick
 * scrolls a patch nobody was reading.
 *
 * So each of them — `.scroll-gate` — starts out not scrolling at all, and the
 * wheel goes past it to the chat. It takes the wheel once you are in it: a
 * press inside, or the pointer moving in and a moment passing with no wheel
 * turning. Moving is the point: the page sliding a box under a pointer that
 * is standing still is not you going in, so stopping to read with the
 * pointer over a patch never arms it. Leaving puts it back.
 *
 * It switches `overflow` itself (styles.css) rather than catching the wheel
 * and passing it on: a box that cannot scroll hands the wheel to the chat
 * natively, momentum and all, and a gesture already under way stays with
 * whatever it started on.
 */

/** How long after the pointer moves in, with no wheel turning, the box takes the wheel. */
const DWELL_MS = 450;

const GATE = ".scroll-gate";

/** The box that has the wheel. */
let engaged: HTMLElement | null = null;
/** The box the pointer moved into, waiting out the dwell. */
let armed: HTMLElement | null = null;
let timer: number | undefined;
let lastX = Number.NaN;
let lastY = Number.NaN;

function gateOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(GATE) : null;
}

function engage(gate: HTMLElement): void {
  if (gate === engaged) return;
  release();
  engaged = gate;
  gate.toggleAttribute("data-engaged", true);
}

function release(): void {
  engaged?.removeAttribute("data-engaged");
  engaged = null;
}

function disarm(): void {
  window.clearTimeout(timer);
  timer = undefined;
  armed = null;
}

function arm(gate: HTMLElement): void {
  disarm();
  armed = gate;
  timer = window.setTimeout(() => {
    disarm();
    if (gate.isConnected && gate.matches(":hover")) engage(gate);
  }, DWELL_MS);
}

export function installScrollGate(): void {
  // a press inside takes it straight away; a press anywhere else lets go
  document.addEventListener(
    "pointerdown",
    (e) => {
      const gate = gateOf(e.target);
      if (gate) engage(gate);
      else release();
    },
    true,
  );

  // a wheel turning is someone scrolling past: the dwell starts over, from
  // the next time the pointer moves
  document.addEventListener("wheel", disarm, { capture: true, passive: true });

  document.addEventListener(
    "mousemove",
    (e) => {
      const gate = gateOf(e.target);
      if (gate !== engaged) release();
      if (gate !== armed) disarm();
      // Chromium re-sends a still pointer's position as the page scrolls
      // under it — the same point on the screen, over something new. Only a
      // pointer that went somewhere is someone moving in.
      const moved = e.screenX !== lastX || e.screenY !== lastY;
      lastX = e.screenX;
      lastY = e.screenY;
      if (moved && gate && gate !== engaged && !armed) arm(gate);
    },
    { capture: true, passive: true },
  );
}
