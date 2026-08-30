import { send } from "./store";

/**
 * The window's small preferences — theme, the theme clock, which folders are
 * unfolded, the player's volume.
 *
 * They live on the server (see server/prefs.ts). localStorage is kept as a
 * cache in front of it, because it answers synchronously and the server's
 * copy arrives a websocket round trip later: the theme has to be on the page
 * before the first paint, not after it. So a read is local-first, and the
 * snapshot fills in anything the local copy doesn't have — which, the first
 * time this machine runs a build that keeps preferences properly, is all of
 * them.
 *
 * A preference the user changes this session is never overwritten by an
 * arriving snapshot: what is on screen is what they just asked for.
 */

const held = new Map<string, string>();
/** Keys this session has set — a late snapshot must not undo them. */
const touched = new Set<string>();
const watchers = new Map<string, Set<(value: string | null) => void>>();

export function getPref(key: string): string | null {
  const cached = held.get(key);
  if (cached !== undefined) return cached;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setPref(key: string, value: string): void {
  held.set(key, value);
  touched.add(key);
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode or a wiped profile — the server still has it
  }
  send({ type: "set_pref", key, value });
}

/** Watch one preference, for the rare thing that has to react to a change
 *  it didn't make (the theme, when the snapshot brings a different one). */
export function watchPref(key: string, listener: (value: string | null) => void): () => void {
  const listeners = watchers.get(key) ?? new Set();
  listeners.add(listener);
  watchers.set(key, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) watchers.delete(key);
  };
}

/** The machine's copy, off the snapshot. */
export function hydratePrefs(stored: Record<string, string>): void {
  for (const [key, value] of Object.entries(stored)) {
    if (touched.has(key)) continue;
    const before = getPref(key);
    held.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // fine — the value is in memory for this session either way
    }
    if (before === value) continue;
    for (const listener of watchers.get(key) ?? []) listener(value);
  }
}
