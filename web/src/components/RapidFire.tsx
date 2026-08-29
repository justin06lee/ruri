import { useEffect, useRef, useState } from "react";
import { useRuri } from "../store";

/**
 * Rapid fire: the same chat, one session at a time — whichever is ready for
 * a prompt. It builds no pane of its own; it hands the ordinary chat pane a
 * different channel to show, so the transcript, the composer and everything
 * around them are the ones you already know. The app's own active session
 * doesn't move: leaving the line puts you back where you were.
 *
 * A send is not a cut. The prompt lands and sits there long enough to read
 * before the card fades out and the next one fades in.
 */

/** How long the sent prompt stays on screen before the card leaves. */
const HOLD_MS = 700;
/** The crossfade either side of the swap. */
const FADE_MS = 260;

export interface RapidFire {
  on: boolean;
  /** The session the pane is showing — rapid fire's pick, not the app's. */
  current: string | undefined;
  /** How many sessions could take a prompt right now. */
  ready: number;
  working: number;
  /** True while the card is on its way out — the pane fades on this. */
  leaving: boolean;
  /** Send or skip: on to the next session waiting. */
  advance: (reason?: "sent" | "skip") => void;
}

/** The line as the sidebar reads it, and who in it could take a prompt. */
function line(): { ids: string[]; ready: string[] } {
  const { projects, statuses } = useRuri.getState();
  const ids = [
    ...projects.filter((p) => p.starred),
    ...projects.filter((p) => !p.starred),
  ].flatMap((project) => project.sessions.map((session) => session.id));
  return { ids, ready: ids.filter((id) => (statuses[id] ?? "idle") !== "working") };
}

/** The next session ready for a prompt, going round from `from`. */
function nextAfter(from: string | undefined): string | undefined {
  const { ids, ready } = line();
  if (ready.length === 0) return undefined;
  const at = from ? ids.indexOf(from) : -1;
  if (at === -1) return ready[0];
  for (let step = 1; step <= ids.length; step++) {
    const candidate = ids[(at + step) % ids.length]!;
    if (ready.includes(candidate)) return candidate;
  }
  return undefined;
}

export function useRapidFire(): RapidFire {
  const on = useRuri((s) => s.rapid);
  const projects = useRuri((s) => s.projects);
  const statuses = useRuri((s) => s.statuses);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  /** A hand-off is under way: the card is holding, then fading. Nothing else
   *  may move the pick until it lands — least of all the turn the sent prompt
   *  just started, which would cut the hold short. */
  const [handing, setHanding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  // Leaving the line drops the pick, so coming back starts fresh.
  useEffect(() => {
    if (on) return;
    clearTimers();
    setHanding(false);
    setLeaving(false);
    setCurrent(undefined);
  }, [on]);

  // The pick: whoever is ready. It only moves on its own when this one can no
  // longer take a prompt — it started a turn, or it's gone. When everybody's
  // working there's nowhere to go, so the card stays and you watch it finish.
  useEffect(() => {
    if (!on || handing) return;
    const { ready } = line();
    if (current && ready.includes(current)) return;
    // entering the line from a session that could take a prompt starts there
    const activeId = useRuri.getState().activeId;
    const next =
      current === undefined && activeId && ready.includes(activeId)
        ? activeId
        : nextAfter(current);
    // nobody else waiting: stay on this one and watch it finish
    if (next && next !== current) setCurrent(next);
    // recomputed from projects/statuses on every change
  }, [on, handing, current, projects, statuses]);

  // Being shown counts as read.
  useEffect(() => {
    if (!current) return;
    if (useRuri.getState().unread[current]) {
      useRuri.setState((s) => ({ unread: { ...s.unread, [current]: false } }));
    }
  }, [current]);

  const { ids, ready } = line();

  const advance = (reason: "sent" | "skip" = "skip") => {
    if (handing) return;
    setHanding(true);
    // a sent prompt is worth seeing land — the card holds, then leaves
    const hold = reason === "sent" ? HOLD_MS : 0;
    timers.current.push(
      setTimeout(() => {
        // the line is read here rather than at the click: the turn the prompt
        // just started has changed who is waiting
        if (!nextAfter(current)) {
          // nobody else waiting — stay on this one instead of fading out and
          // straight back in to the same session
          setHanding(false);
          return;
        }
        setLeaving(true);
        timers.current.push(
          setTimeout(() => {
            const next = nextAfter(current);
            if (next) setCurrent(next);
            setLeaving(false);
            setHanding(false);
          }, FADE_MS),
        );
      }, hold),
    );
  };

  return {
    on,
    current,
    ready: ready.length,
    working: ids.length - ready.length,
    leaving,
    advance,
  };
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
        <button
          className="rapid-skip"
          title="Pass — on to the next session waiting"
          onClick={() => rapid.advance("skip")}
        >
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
