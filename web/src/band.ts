import { useSyncExternalStore } from "react";
import { type Band, defaultBand, MAX_PICTURES, parseBand } from "./lib/peekBand";
import { getPref, setPref, watchPref } from "./prefs";

export * from "./lib/peekBand";

/**
 * The peek band — the strip of pictures across the top of the sidebar —
 * as the user has set it up in Settings.
 *
 * A fresh install shows the one mountain path, a picture for each theme
 * (web/public/peek), but the band is the user's: any pictures, any number
 * up to MAX_PICTURES, each placed by dragging it, each with its own hover —
 * a motion, a second picture to swap in, a GIF that plays only while the
 * pointer is on it — and each on every theme or only some.
 * What a band is lives in lib/peekBand.ts; this is the window's copy of it.
 *
 * Kept as one preference (server/prefs.ts) holding a small JSON list; the
 * pictures themselves are uploads (/uploads/<file>), which the upload sweep
 * keeps for as long as the preference mentions them.
 */

const KEY = "ruri-band";

/* ── the one copy the window holds ───────────────────────────────── */

/** Read on first use, not as the module loads: this module and store.ts
 *  import each other, and the preferences are not there to read until
 *  every module in that loop has finished loading. */
let band: Band | null = null;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function notify(): void {
  for (const listener of listeners) listener();
}

/** The band as it stands, for a handler that must not hold a stale copy. */
export function getBand(): Band {
  if (!band) {
    band = parseBand(getPref(KEY));
    // another window changed it (or the machine's copy arrived after the cache)
    watchPref(KEY, (value) => {
      band = parseBand(value);
      notify();
    });
  }
  return band;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The band as it stands, re-rendering whoever reads it when it changes. */
export function useBand(): Band {
  return useSyncExternalStore(subscribe, getBand);
}

/**
 * Change the band. On screen at once — the sidebar follows a drag in the
 * editor as it happens — and kept a moment after the last change, so a
 * drag is one write to disk rather than one per pixel.
 */
export function setBand(next: Band): void {
  getBand();
  const kept = { pictures: next.pictures.slice(0, MAX_PICTURES) };
  band = kept;
  notify();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setPref(KEY, JSON.stringify(kept)), 400);
}

/** Back to the band a fresh install shows — by forgetting the preference,
 *  which is what "default" means for one. */
export function resetBand(): void {
  getBand();
  clearTimeout(saveTimer);
  band = defaultBand();
  notify();
  setPref(KEY, "");
}
