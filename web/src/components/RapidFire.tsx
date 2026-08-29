import { useEffect } from "react";
import { useRuri } from "../store";

/**
 * Rapid fire: the ordinary chat pages, visited in turn. It has no pane of
 * its own — it just walks you to whichever session is ready for a prompt,
 * and walks you on the moment you send. A session that's working is skipped
 * until it finishes; picking one from the sidebar by hand leaves the line.
 */

export interface RapidFire {
  on: boolean;
  /** How many sessions could take a prompt right now. */
  ready: number;
  working: number;
  /** Send or skip: on to the next session waiting. */
  advance: () => void;
}

export function useRapidFire(): RapidFire {
  const on = useRuri((s) => s.rapid);
  const projects = useRuri((s) => s.projects);
  const statuses = useRuri((s) => s.statuses);
  const activeId = useRuri((s) => s.activeId);

  // sidebar order: starred first, then the rest — the line runs the way the
  // sidebar reads, and wraps around to the top
  const ids = [
    ...projects.filter((p) => p.starred),
    ...projects.filter((p) => !p.starred),
  ].flatMap((project) => project.sessions.map((session) => session.id));
  const ready = ids.filter((id) => (statuses[id] ?? "idle") !== "working");
  const working = ids.filter((id) => statuses[id] === "working").length;

  /** The next session ready for a prompt, going round from `from`. */
  const nextAfter = (from: string | null): string | undefined => {
    if (ready.length === 0) return undefined;
    const at = from ? ids.indexOf(from) : -1;
    if (at === -1) return ready[0];
    for (let step = 1; step <= ids.length; step++) {
      const candidate = ids[(at + step) % ids.length]!;
      if (ready.includes(candidate)) return candidate;
    }
    return undefined;
  };

  const go = (id: string) => useRuri.getState().setActive(id, { keepRapid: true });

  const advance = () => {
    const next = nextAfter(activeId);
    if (next && next !== activeId) go(next);
  };

  // Turning it on lands you on a session that can take a prompt; so does the
  // one you're sitting on starting a turn of its own. When everybody's
  // working there's nowhere to go, so you stay and watch this one finish.
  useEffect(() => {
    if (!on) return;
    if (activeId && ready.includes(activeId)) return;
    const next = nextAfter(activeId);
    if (next && next !== activeId) go(next);
    // recomputed from projects/statuses on every change
  }, [on, statuses, projects, activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  return { on, ready: ready.length, working, advance };
}

/** The line's own controls, riding in the chat header while it's running. */
export function RapidBar({ rapid }: { rapid: RapidFire }) {
  const setRapid = useRuri((s) => s.setRapid);
  return (
    <div className="rapid-bar">
      <span className="rapid-count">
        rapid fire · {rapid.ready} ready · {rapid.working} working
      </span>
      {rapid.ready > 1 && (
        <button className="rapid-skip" title="Pass — on to the next session waiting" onClick={rapid.advance}>
          skip
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </button>
      )}
      <button className="icon-button" title="Leave rapid fire" onClick={() => setRapid(false)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}
