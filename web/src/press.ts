/**
 * A press that starts on a button ends on that button.
 *
 * Everything clickable here animates under the press — most buttons slide
 * 2px down and right, the round composer ones shrink to 92%. That animation
 * moves the element out from under a pointer resting near its edge, and a
 * click is only generated where the press and the release agree: the release
 * landed on the page behind, so the button lit up and then did nothing. Worse
 * near a corner, and worst on the small round buttons, where 8% of 30px is
 * most of the margin you had.
 *
 * Widening the hit area cannot fix it, because the widened area moves too.
 * The fix is to stop asking where the pointer ended up: on pointerdown the
 * element captures the pointer, so every later event for it — the release,
 * and the mouse events the click is built from — is delivered to that element
 * wherever the pointer actually is. The button moving is then irrelevant.
 *
 * Capture also means a release genuinely far away would still count as a
 * click, and dragging off a button to change your mind is a real gesture, so
 * a release outside a small tolerance around the element swallows the click
 * that would have followed. The tolerance is generous enough to cover any
 * press animation and nothing more.
 */

/** How far outside an element a release still counts as a press on it. */
const SLACK = 12;

/** What this applies to: anything that animates under a press. */
const PRESSABLE = 'button, [role="button"], .ask-option, .diff-head, .tool-image';

function within(el: Element, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  return (
    x >= r.left - SLACK && x <= r.right + SLACK && y >= r.top - SLACK && y <= r.bottom + SLACK
  );
}

export function installPressGuard(): void {
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0 || !e.isPrimary) return;
      const target = e.target;
      if (!(target instanceof Element)) return;
      const el = target.closest(PRESSABLE);
      if (!(el instanceof HTMLElement) || el.matches(":disabled")) return;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // the element went away between the hit test and here
        return;
      }

      const done = (up: PointerEvent) => {
        el.removeEventListener("pointerup", done);
        el.removeEventListener("pointercancel", cancelled);
        if (within(el, up.clientX, up.clientY)) return;
        // released away from the button: this was a change of mind, and the
        // click the capture is about to synthesise is not wanted
        const swallow = (click: Event) => {
          click.stopPropagation();
          click.preventDefault();
        };
        el.addEventListener("click", swallow, { capture: true });
        // the click lands in the same task as the release; anything still
        // listening after that would be swallowing an unrelated one
        setTimeout(() => el.removeEventListener("click", swallow, true), 0);
      };
      const cancelled = () => {
        el.removeEventListener("pointerup", done);
        el.removeEventListener("pointercancel", cancelled);
      };
      el.addEventListener("pointerup", done);
      el.addEventListener("pointercancel", cancelled);
    },
    true,
  );
}
