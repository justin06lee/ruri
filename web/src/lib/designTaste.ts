import { useSyncExternalStore } from "react";
import { GUSTEAU_PREF } from "../../../shared/protocol";
import { getPref, setPref, watchPref } from "../prefs";

/**
 * Design taste (server/gusteau.ts): one global setting, on by default.
 * On, new sessions hold interface work to the user's taste through
 * gusteau. Read from the machine's prefs, so every window and the server
 * agree.
 */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
watchPref(GUSTEAU_PREF, changed);

export function designTasteOn(): boolean {
  return getPref(GUSTEAU_PREF) !== "off";
}

export function setDesignTaste(on: boolean): void {
  setPref(GUSTEAU_PREF, on ? "on" : "off");
  changed();
}

export function useDesignTaste(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    designTasteOn,
  );
}
