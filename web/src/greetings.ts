import { useSyncExternalStore } from "react";
import { parseGreetings } from "./lib/greetings";
import { getPref, setPref, watchPref } from "./prefs";

export * from "./lib/greetings";

/**
 * Home's greetings as the user has set them in Settings — the window's
 * copy. What they are lives in lib/greetings.ts.
 *
 * Kept as one preference (server/prefs.ts) holding a JSON list. Until the
 * user changes them, a list kept by the retired hero face (`ruri-hero`) is
 * read instead; the first change moves them to their own key and lets the
 * old preference go.
 */

const KEY = "ruri-greetings";
const LEGACY = "ruri-hero";

/** Fixture and screenshot runs must come out the same every time. */
const pinned = typeof location !== "undefined" && location.search.includes("fixture");

/** Drawn once per page load: which of several greetings this launch says. */
export const launchRoll = pinned ? 0 : Math.random();

/** Read on first use, not as the module loads — see band.ts, which has the
 *  same loop of imports to keep out of. */
let lines: string[] | null = null;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

const read = (): string[] => parseGreetings(getPref(KEY), getPref(LEGACY));

function notify(): void {
  for (const listener of listeners) listener();
}

export function getGreetings(): string[] {
  if (!lines) {
    lines = read();
    // another window changed them, or the machine's copy arrived after the cache
    const reread = () => {
      lines = read();
      notify();
    };
    watchPref(KEY, reread);
    watchPref(LEGACY, reread);
  }
  return lines;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useGreetings(): string[] {
  return useSyncExternalStore(subscribe, getGreetings);
}

/** Change them: on screen at once, kept a moment after the last keystroke. */
export function setGreetings(next: string[]): void {
  getGreetings();
  lines = next;
  notify();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    setPref(KEY, JSON.stringify(next));
    if (getPref(LEGACY)) setPref(LEGACY, "");
  }, 400);
}
