import { useSyncExternalStore } from "react";
import { liveComponentsFor, MYCELIUM_PREF, type Project } from "../../../shared/protocol";
import { getPref, setPref, watchPref } from "../prefs";
import { useRuri } from "../store";

/**
 * Live components (server/mycelium.ts): a setting, off until turned on,
 * and each project's own word over it. On, the component library is tied
 * to the code through mycelium: entries follow their root declaration, and
 * the Components page renders them from the code. The setting is read from
 * the machine's prefs and a project's word from the project itself, so
 * every window and the server agree.
 */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
watchPref(MYCELIUM_PREF, changed);

/** The setting itself: what a project that says nothing follows. */
export function liveComponentsOn(): boolean {
  return getPref(MYCELIUM_PREF) === "on";
}

export function setLiveComponents(on: boolean): void {
  setPref(MYCELIUM_PREF, on ? "on" : "off");
  changed();
}

function useSetting(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    liveComponentsOn,
  );
}

/** Whether live components is on — for a project when one is named (its
 *  own word, else the setting), else the setting. */
export function useLiveComponents(projectId?: string): boolean {
  const setting = useSetting();
  const own = useRuri((s) => (projectId ? s.projects.find((p) => p.id === projectId)?.mycelium : undefined));
  return liveComponentsFor({ ...(own ? { mycelium: own } : {}) }, setting ? "on" : "off");
}

/** What a project says for itself: on, off, or nothing ("default"). */
export function liveChoice(project: Pick<Project, "mycelium"> | undefined): "on" | "off" | "default" {
  return project?.mycelium ?? "default";
}
