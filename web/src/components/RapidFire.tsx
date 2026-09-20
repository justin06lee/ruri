import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { STAR_PATH } from "../icons";
import { lineOf } from "../lib/rapid";
import { getPref, setPref } from "../prefs";
import { useRuri } from "../store";

/**
 * Rapid fire: the same chat, one session at a time — whichever is ready for
 * a prompt. It builds no pane of its own; it hands the ordinary chat pane a
 * different channel to show, so the transcript, the composer and everything
 * around them are the ones you already know. The app's own active session
 * doesn't move: leaving the line puts you back where you were.
 *
 * A send is not a cut. The prompt lands and sits there long enough to read,
 * the card eases out, and then the next project announces itself — its name,
 * big, for as long as it takes to register — before its chat rises into
 * place. Two seconds of theatre that answer the only question a line like
 * this ever raises: which one am I looking at now?
 *
 * Who is in the line at all is lib/rapid.ts: every open project, or only the
 * starred ones (the star on the plate, remembered across launches), and a
 * hidden project in neither.
 */

/** Whether the line was narrowed to the starred projects, last time. */
const STARRED_PREF = "ruri-rapid-starred";

/** How long the sent prompt stays on screen before the card leaves. */
const HOLD_MS = 700;
/** The card easing out. Long enough to read as a movement, not a cut. */
const FADE_MS = 420;
/** The name card: in, held, and out again. */
const INTRO_MS = 1150;

export interface RapidFire {
  on: boolean;
  /** The session the pane is showing — rapid fire's pick, not the app's. */
  current: string | undefined;
  /** How many sessions could take a prompt right now. */
  ready: number;
  working: number;
  /** The line is narrowed to the starred projects. */
  starred: boolean;
  setStarred: (on: boolean) => void;
  /** True while the card is on its way out — the pane fades on this. */
  leaving: boolean;
  /** The project being handed to, while its name is on screen. */
  intro: { name: string; title?: string } | null;
  /** Send or skip: on to the next session waiting. */
  advance: (reason?: "sent" | "skip") => void;
}

/** The line as the sidebar reads it, and who in it could take a prompt. */
function line(starredOnly: boolean): { ids: string[]; ready: string[] } {
  const { projects, statuses } = useRuri.getState();
  return lineOf(projects, statuses, starredOnly);
}

/** Who a session belongs to, for the card that announces it. */
function whose(sessionId: string): { name: string; title?: string } {
  const { projects } = useRuri.getState();
  for (const project of projects) {
    const session = project.sessions.find((s) => s.id === sessionId);
    if (session) return { name: project.name, ...(session.title ? { title: session.title } : {}) };
  }
  return { name: "…" };
}

/** The next session ready for a prompt, going round from `from`. */
function nextAfter(from: string | undefined, starredOnly: boolean): string | undefined {
  const { ids, ready } = line(starredOnly);
  if (ready.length === 0) return undefined;
  const at = from ? ids.indexOf(from) : -1;
  if (at === -1) return ready[0];
  for (let step = 1; step <= ids.length; step++) {
    const candidate = ids[(at + step) % ids.length]!;
    if (ready.includes(candidate)) return candidate;
  }
  return undefined;
}

/** Where the pick should be, given where it is: unchanged while that
 *  session can still take a prompt. */
function repick(current: string | undefined, starredOnly: boolean): string | undefined {
  const { ids, ready } = line(starredOnly);
  if (current && ready.includes(current)) return current;
  // entering the line from a session that could take a prompt starts there
  const activeId = useRuri.getState().activeId;
  const next =
    current === undefined && activeId && ready.includes(activeId)
      ? activeId
      : nextAfter(current, starredOnly);
  // Nobody else waiting: stay on this one and watch it finish — but only
  // while it is still in the line. Narrowed to the starred, hidden away or
  // closed, it is not ours to hand back, and holding it would go on
  // offering the composer a session the line no longer holds.
  return next ?? (current && ids.includes(current) ? current : undefined);
}

export function useRapidFire(): RapidFire {
  const on = useRuri((s) => s.rapid);
  // Which line: every open project, or only the starred. Kept here rather
  // than in the store so the preference can be read as the component first
  // renders (prefs.ts leans on the store, so the store cannot lean back).
  const [starred, holdStarred] = useState(() => getPref(STARRED_PREF) === "1");
  const setStarred = (want: boolean) => {
    holdStarred(want);
    setPref(STARRED_PREF, want ? "1" : "0");
  };
  // subscribed only to render again when the line changes: `line()` reads
  // them from the store itself
  useRuri((s) => s.projects);
  useRuri((s) => s.statuses);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  /** A hand-off is under way: the card is holding, then fading. Nothing else
   *  may move the pick until it lands — least of all the turn the sent prompt
   *  just started, which would cut the hold short. */
  const [handing, setHanding] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [intro, setIntro] = useState<{ name: string; title?: string } | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  };
  useEffect(() => clearTimers, []);

  // Leaving the line drops the pick, so coming back starts fresh — the
  // state as the render notices, the timers (not state) after it.
  const [wasOn, setWasOn] = useState(on);
  if (wasOn !== on) {
    setWasOn(on);
    if (!on) {
      setHanding(false);
      setLeaving(false);
      setIntro(null);
      setCurrent(undefined);
    }
  }
  useEffect(() => {
    if (!on) clearTimers();
  }, [on]);

  // The pick: whoever is ready. It only moves on its own when this one can no
  // longer take a prompt — it started a turn, or it's gone. When everybody's
  // working there's nowhere to go, so the card stays and you watch it finish.
  // Worked out as the render happens — projects and statuses are subscribed
  // above, so every change to the line comes through here.
  if (on && !handing) {
    const next = repick(current, starred);
    if (next !== current) setCurrent(next);
  }

  // Being shown counts as read.
  useEffect(() => {
    if (!current) return;
    if (useRuri.getState().unread[current]) {
      useRuri.setState((s) => ({ unread: { ...s.unread, [current]: false } }));
    }
  }, [current]);

  const { ids, ready } = line(starred);

  const advance = (reason: "sent" | "skip" = "skip") => {
    if (handing) return;
    setHanding(true);
    // a sent prompt is worth seeing land — the card holds, then leaves
    const hold = reason === "sent" ? HOLD_MS : 0;
    timers.current.push(
      setTimeout(() => {
        // the line is read here rather than at the click: the turn the prompt
        // just started has changed who is waiting
        if (!nextAfter(current, starred)) {
          // nobody else waiting — stay on this one instead of fading out and
          // straight back in to the same session
          setHanding(false);
          return;
        }
        setLeaving(true);
        timers.current.push(
          setTimeout(() => {
            const next = nextAfter(current, starred);
            if (!next) {
              setLeaving(false);
              setHanding(false);
              return;
            }
            // the swap happens behind the name card, so the incoming chat is
            // never seen half-built — it rises when the name has gone
            setCurrent(next);
            setIntro(whose(next));
            timers.current.push(
              setTimeout(() => {
                setIntro(null);
                setLeaving(false);
                setHanding(false);
              }, INTRO_MS),
            );
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
    starred,
    setStarred,
    leaving,
    intro,
    advance,
  };
}

/**
 * The line's own controls. They belong to the composer, not to the header,
 * so they ride directly above the textbox — placed the same way the
 * jump-to-latest pill is, off the measured height of the box itself, because
 * the dragons beside it stand taller than it does and anything laid out in
 * flow ends up level with their heads instead.
 *
 * `floating` is the docked composer; the hero's composer has no dragons and
 * takes it in flow.
 */
export function RapidBar({ rapid, floating }: { rapid: RapidFire; floating?: boolean }) {
  const setRapid = useRuri((s) => s.setRapid);
  const barRef = useRef<HTMLDivElement>(null);

  /* Line the plate's right edge up with the textbox below it. The textbox is
     centred between the dragons rather than filling the pane, so its right
     edge is wherever those work out to — a fixed padding here lands next to
     it, never on it. Measured from the real thing, and kept in step: the
     dragons change height, the box grows with a long prompt. */
  useLayoutEffect(() => {
    const bar = barRef.current;
    const pane = bar?.closest("main");
    const box = pane?.querySelector(".composer-box");
    if (!bar || !pane || !box) return;
    const align = () => {
      const inset = Math.round(pane.getBoundingClientRect().right - box.getBoundingClientRect().right);
      bar.style.setProperty("--rapid-inset", `${inset}px`);
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(pane);
    observer.observe(box);
    return () => observer.disconnect();
  }, [floating]);

  const empty = rapid.starred && rapid.ready + rapid.working === 0;

  return (
    <div className={`rapid-bar ${floating ? "floating" : ""}`} ref={barRef}>
      {/* a plate of its own: this floats over the transcript, and without a
          surface under it the conversation reads straight through the text */}
      <div className="rapid-plate">
        <span className="rapid-count">
          <span className="rapid-lead">rapid fire</span>
          {/* narrowed to the starred with nothing starred, "0 ready · 0
              working" reads as a stall rather than an empty line */}
          {empty ? " · nothing starred" : ` · ${rapid.ready} ready · ${rapid.working} working`}
        </span>
        <button
          className={`rapid-star ${rapid.starred ? "on" : ""}`}
          title={
            rapid.starred
              ? "Starred projects only — click for every open project"
              : "Every open project — click for the starred ones only"
          }
          aria-pressed={rapid.starred}
          onClick={() => rapid.setStarred(!rapid.starred)}
        >
          <svg
            viewBox="0 0 24 24"
            fill={rapid.starred ? "currentColor" : "none"}
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d={STAR_PATH} />
          </svg>
        </button>
        {rapid.ready > 1 && (
          <button
            className="rapid-skip"
            title="Pass — on to the next session waiting"
            onClick={() => rapid.advance("skip")}
          >
            skip
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        )}
        <button className="icon-button" title="Leave rapid fire" onClick={() => setRapid(false)}>
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}
