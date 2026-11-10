import { useSyncExternalStore } from "react";
import { MYCELIUM_PREF } from "../../../shared/protocol";
import { getPref, setPref, watchPref } from "../prefs";

/**
 * Live components (server/mycelium.ts): one global setting, off until
 * turned on. On, the component library is tied to the code through
 * mycelium: entries follow their root declaration, and the Components
 * page renders them from the code. Read from the machine's prefs, so
 * every window and the server agree.
 */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
watchPref(MYCELIUM_PREF, changed);

export function liveComponentsOn(): boolean {
  return getPref(MYCELIUM_PREF) === "on";
}

export function setLiveComponents(on: boolean): void {
  setPref(MYCELIUM_PREF, on ? "on" : "off");
  changed();
}

export function useLiveComponents(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    liveComponentsOn,
  );
}
