/**
 * The command key, by platform: ⌘ on a Mac, Ctrl everywhere else — for the
 * shortcuts that are the Mac's by habit, and for how the hints name them.
 */
export const MAC = typeof navigator === "undefined" || /Mac/.test(navigator.userAgent);

/** "⌘" or "Ctrl+", to put in front of a key in a hint. */
export const MOD = MAC ? "⌘" : "Ctrl+";

/** The platform's command key is down (and not the other one). */
export function commandKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
