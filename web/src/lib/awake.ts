/**
 * Whether anyone can see ruri, and which elements are actually in view.
 *
 * Asleep — nothing of the window can be seen: minimised, hidden, on another
 * Space, or covered whole by other windows, which macOS tells the page the
 * same way — nothing on the window changes: the clocks stop where they
 * stand (beat.ts, spin.ts), any entrance caught halfway pauses, to finish
 * on waking, and nothing the server says is applied — it stops sending the
 * chats, and what little else comes is held unread (store.ts, receive)
 * until the window wakes and takes it in one render. The only work left
 * running is the agents'.
 *
 * A window that can be seen is awake whether or not it is the one in use.
 * It used to sleep the moment another app took the focus, and someone
 * watching a chat from beside the app they were in — or whose focus a
 * launched app had taken — watched a reply stop at whatever the agent was
 * doing as the focus left, a tool call as often as not, and a working
 * clock that had stopped as if the model had: a reply cut off, put right
 * only by clicking back into ruri. Focus still decides one thing, apart
 * from all this: whether the peek band is the page's or the title bar
 * (`data-unfocused`, styles.css).
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
  return forced || !document.hidden;
}

/** The window is the one in use: keys and clicks go to it. */
function focused(): boolean {
  return forced || document.hasFocus();
}

let awake = seen();
document.documentElement.toggleAttribute("data-asleep", !awake);
document.documentElement.toggleAttribute("data-unfocused", !focused());

/** Some of the window can be seen. */
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
  document.documentElement.toggleAttribute("data-unfocused", !focused());
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
