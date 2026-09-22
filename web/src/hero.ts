import { useSyncExternalStore } from "react";
import { defaultHero, type Hero, parseHero } from "./lib/heroFace";
import { getPref, setPref, watchPref } from "./prefs";

export * from "./lib/heroFace";

/**
 * The hero face — the face over a chat with nothing in it yet — as the
 * user has set it up in Settings: cropped Ruri panels in /public/hero, and
 * any pictures of their own; one face always, or one drawn at random (each
 * project keeping its own, a new one every launch, or every time); the
 * frame it sits in; what it does under the pointer; what Home says.
 * What a hero is lives in lib/heroFace.ts; this is the window's copy.
 *
 * Kept as one preference (server/prefs.ts); the user's pictures are
 * uploads, kept by the sweep while the preference names them.
 */

/** Fixture and screenshot runs must come out the same every time. */
export const pinned = typeof location !== "undefined" && location.search.includes("fixture");

/** Drawn once per page load: what "a new face every launch" draws from. */
export const launchRoll = pinned ? 11 / 12 : Math.random();

const KEY = "ruri-hero";

/** Read on first use, not as the module loads — see band.ts, which has the
 *  same loop of imports to keep out of. */
let hero: Hero | null = null;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function notify(): void {
  for (const listener of listeners) listener();
}

/** The hero as it stands, for a handler that must not hold a stale copy. */
export function getHero(): Hero {
  if (!hero) {
    hero = parseHero(getPref(KEY));
    watchPref(KEY, (value) => {
      hero = parseHero(value);
      notify();
    });
  }
  return hero;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHero(): Hero {
  return useSyncExternalStore(subscribe, getHero);
}

/** Change it: on screen at once, kept a moment after the last change. */
export function setHero(next: Hero): void {
  getHero();
  hero = next;
  notify();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setPref(KEY, JSON.stringify(next)), 400);
}

/** Change part of it, reading it as it is now. */
export function patchHero(patch: Partial<Hero>): void {
  setHero({ ...getHero(), ...patch });
}

/** Back to how it came — by forgetting the preference. */
export function resetHero(): void {
  getHero();
  clearTimeout(saveTimer);
  hero = defaultHero();
  notify();
  setPref(KEY, "");
}
