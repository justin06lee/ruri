import * as fs from "node:fs";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/**
 * The window's own preferences — theme, the theme clock, which folders are
 * unfolded, the music player's volume — kept here rather than in the window.
 *
 * They were the window's to keep, in localStorage, and localStorage is
 * filed under an origin. The app serves itself over http on a port, so the
 * port is the origin; it used to take whatever port was free at launch,
 * which meant every launch read an empty store and every preference reset
 * itself overnight. The port is pinned now, but that only makes the window's
 * storage work — it does not make it the right place. These belong to the
 * machine, the same as the workspace root and the vault, so they live where
 * everything else about this machine lives.
 *
 * Deliberately untyped: it is a bag of small strings the UI understands and
 * the server only stores. New preferences need nothing here.
 */

const MAX_KEYS = 200;
/** Room for the largest: the peek band keeps its list of pictures and
 *  placings in one (web/src/band.ts). */
const MAX_VALUE = 32_000;

function prefsFile(): string {
  return configPath("prefs.json");
}

export class PrefStore {
  private data: Record<string, string> | null = null;

  private load(): Record<string, string> {
    if (this.data) return this.data;
    let loaded: Record<string, string> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(prefsFile(), "utf8")) as Record<string, unknown>;
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") loaded[key] = value;
      }
    } catch (err) {
      if (!isMissing(err)) warn("prefs", err, "load");
      loaded = {};
    }
    this.data = loaded;
    return loaded;
  }

  all(): Record<string, string> {
    return { ...this.load() };
  }

  /** Keep one. An empty value forgets it — that is what "back to default"
   *  means for a preference. */
  set(key: string, value: string): void {
    const data = this.load();
    if (!key || key.length > 120 || value.length > MAX_VALUE) return;
    if (value === "") delete data[key];
    else if (Object.keys(data).length < MAX_KEYS || key in data) data[key] = value;
    else return;
    this.save();
  }

  private save(): void {
    try {
      writeJsonAtomic(prefsFile(), this.data ?? {}, 2);
    } catch (err) {
      warn("prefs", err, "save");
      // best-effort persistence
    }
  }
}
