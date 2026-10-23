import { useSyncExternalStore } from "react";
import { SESSIONS_MODE_PREF } from "../../../shared/protocol";
import { getPref, setPref, watchPref } from "../prefs";

/**
 * Sessions or Team (server/sessionsMode.ts): one global setting. Sessions —
 * the default — is a project as a list of ordinary chats; Team is its lead
 * with a team behind it. Read from the machine's prefs, so every window
 * and the server agree.
 */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
watchPref(SESSIONS_MODE_PREF, changed);

export function inSessionsMode(): boolean {
  return getPref(SESSIONS_MODE_PREF) !== "team";
}

export function setSessionsMode(on: boolean): void {
  setPref(SESSIONS_MODE_PREF, on ? "sessions" : "team");
  changed();
}

export function useSessionsMode(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    inSessionsMode,
  );
}
