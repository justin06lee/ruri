import { useSyncExternalStore } from "react";
import { SPLIT_PREF } from "../../../shared/protocol";
import { getPref, setPref, watchPref } from "../prefs";

/**
 * Long prompts cut into tasks (server/promptSplit.ts): one global setting,
 * on by default. Read from the machine's prefs, so every window and the
 * server agree.
 */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
watchPref(SPLIT_PREF, changed);

export function splitLongPromptsOn(): boolean {
  return getPref(SPLIT_PREF) !== "off";
}

export function setSplitLongPrompts(on: boolean): void {
  setPref(SPLIT_PREF, on ? "on" : "off");
  changed();
}

export function useSplitLongPrompts(): boolean {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, splitLongPromptsOn);
}
