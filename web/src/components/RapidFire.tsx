import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project } from "../../../shared/protocol";
import { type Line, lineOf, nextAfter, repick } from "../lib/rapid";
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
 * place. A second and a half of theatre that answers the only question a
 * line like this ever raises: which one am I looking at now?
 *
 * Who is in the line at all is lib/rapid.ts: every open project, or only the
 * starred ones (the all | starred switch on the plate, remembered across
 * launches), and a hidden project in neither.
 */

/** Whether the line was narrowed to the starred projects, last time. */
const STARRED_PREF = "ruri-rapid-starred";

/** How long the sent prompt stays on screen before the card leaves. */
const HOLD_MS = 450;
/** The card easing out. Long enough to read as a movement, not a cut. */
const FADE_MS = 260;
/** The name card: in, held, and out again (styles.css, rapid-name). */
const INTRO_MS = 700;

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

/** The line as it stands this moment — for the hand-off's timers, which run
 *  after the render that set them and have to see what has changed since. */
function lineNow(starredOnly: boolean): Line {
  const { projects, statuses } = useRuri.getState();
  return lineOf(projects, statuses, starredOnly);
}

/** Who a session belongs to, for the card that announces it. */
function whose(projects: Project[], sessionId: string): { name: string; title?: string } {
  for (const project of projects) {
    const session = project.sessions.find((s) => s.id === sessionId);
    if (session) return { name: project.name, ...(session.title ? { title: session.title } : {}) };
  }
  return { name: "…" };
}

/**
 * A hand-off, one step at a time: the card holding where it is, the card
 * easing out, the next project's name over the pane. Each step is state, and
 * one effect waits it out — so whatever starts a hand-off (a click, a send,
 * the render noticing the chat on screen has started a turn) only has to set
 * the first step.
 */
type Handoff = { step: "hold"; ms: number } | { step: "fade" } | { step: "intro" };

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
  // The line, worked out from what is subscribed to here and nothing read
  // off the store behind it: the React Compiler caches a value by the
  // inputs it can see, and a line read through getState() was cached by
  // `starred` alone — the count and the skip button froze at whatever the
  // line was when the app first drew, before the projects had arrived.
  const projects = useRuri((s) => s.projects);
  const statuses = useRuri((s) => s.statuses);
  const activeId = useRuri((s) => s.activeId);
  const { ids, ready } = lineOf(projects, statuses, starred);
  const [current, setCurrent] = useState<string | undefined>(undefined);
  /** The hand-off under way. Nothing else may move the pick until it lands —
   *  least of all the turn the sent prompt just started, which would cut the
   *  hold short. */
  const [handoff, setHandoff] = useState<Handoff | null>(null);

  // Leaving the line drops the pick and any hand-off, so coming back starts
  // fresh; the hand-off's timer goes with its effect.
  const [wasOn, setWasOn] = useState(on);
  if (wasOn !== on) {
    setWasOn(on);
    if (!on) {
      setHandoff(null);
      setCurrent(undefined);
    }
  }

  // The pick: whoever is ready. It only moves on its own when this one can no
  // longer take a prompt — it started a turn, or it's gone. When everybody's
  // working there's nowhere to go, so the card stays and you watch it finish.
  // Worked out as the render happens, off the line above. Entering the line,
  // or a line that has emptied, takes the pick at once; moving on from a
  // session that is on screen goes the way a send does — an answered
  // permission card or a queued prompt going out used to cut straight to the
  // next project, with nothing to say it had changed.
  if (on && !handoff) {
    const next = repick({ ids, ready }, current, activeId);
    if (current !== undefined && next !== undefined && next !== current) {
      setHandoff({ step: "hold", ms: HOLD_MS });
    } else if (next !== current) {
      setCurrent(next);
    }
  }

  // Each step of a hand-off, waited out. The line is read when a step ends
  // rather than when the hand-off began: the turn the prompt just started
  // has changed who is waiting.
  useEffect(() => {
    if (!handoff) return;
    const wait = handoff.step === "hold" ? handoff.ms : handoff.step === "fade" ? FADE_MS : INTRO_MS;
    const timer = setTimeout(() => {
      if (handoff.step === "intro") {
        setHandoff(null);
        return;
      }
      const next = nextAfter(lineNow(starred), current);
      if (!next) {
        // nobody else waiting — stay on this one instead of fading out and
        // straight back in to the same session
        setHandoff(null);
      } else if (handoff.step === "hold") {
        setHandoff({ step: "fade" });
      } else {
        // the swap happens behind the name card, so the incoming chat is
        // never seen half-built — it rises when the name has gone
        setCurrent(next);
        setHandoff({ step: "intro" });
      }
    }, wait);
    return () => clearTimeout(timer);
  }, [handoff, current, starred]);

  // Being shown counts as read.
  useEffect(() => {
    if (!current) return;
    if (useRuri.getState().unread[current]) {
      useRuri.setState((s) => ({ unread: { ...s.unread, [current]: false } }));
    }
  }, [current]);

  const advance = (reason: "sent" | "skip" = "skip") => {
    if (handoff) return;
    // a sent prompt is worth seeing land — the card holds, then leaves
    setHandoff({ step: "hold", ms: reason === "sent" ? HOLD_MS : 0 });
  };

  return {
    on,
    current,
    ready: ready.length,
    working: ids.length - ready.length,
    starred,
    setStarred,
    leaving: handoff?.step === "fade" || handoff?.step === "intro",
    intro: handoff?.step === "intro" && current ? whose(projects, current) : null,
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
 * `floating` is the docked composer; the hero's composer stands its dragons
 * out of flow (styles.css, .hero-composer .dragons), so it takes the bar in
 * flow, straight above the box.
 */
export function RapidBar({ rapid, floating }: { rapid: RapidFire; floating?: boolean }) {
  const setRapid = useRuri((s) => s.setRapid);
  const barRef = useRef<HTMLDivElement>(null);

  /* Line the plate's right edge up with the textbox below it. The textbox is
     centred between the dragons rather than filling the pane, so its right
     edge is wherever those work out to — a fixed padding here lands next to
     it, never on it. Measured from the real thing, and kept in step: the
     dragons change height, the box grows with a long prompt. Measured off
     the bar's own edge, not the pane's: in the hero the bar is only as wide
     as the hero, and an inset taken from the pane put the plate a margin's
     width short of the box. */
  useLayoutEffect(() => {
    const bar = barRef.current;
    const box = bar?.closest("main")?.querySelector(".composer-box");
    if (!bar || !box) return;
    const align = () => {
      const inset = Math.round(bar.getBoundingClientRect().right - box.getBoundingClientRect().right);
      bar.style.setProperty("--rapid-inset", `${Math.max(0, inset)}px`);
    };
    align();
    const observer = new ResizeObserver(align);
    observer.observe(bar);
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
        {/* Which projects the line goes round — a choice between two, said
            in words. It was a lone star, and a star beside the chat you are
            looking at reads as "star this one", which it never did. */}
        <div className="rapid-scope" role="group" aria-label="Which projects rapid fire goes round">
          <button
            className={rapid.starred ? "" : "on"}
            aria-pressed={!rapid.starred}
            title="Go round every open project"
            onClick={() => rapid.setStarred(false)}
          >
            all
          </button>
          <button
            className={rapid.starred ? "on" : ""}
            aria-pressed={rapid.starred}
            title="Go round the starred projects only"
            onClick={() => rapid.setStarred(true)}
          >
            starred
          </button>
        </div>
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

/**
 * The line with nobody to hand you: nothing starred, nothing open, or every
 * session in it mid-turn as you arrive. It used to show the app's own active
 * chat — Home, as often as not — under the line's controls, so a prompt
 * typed there went somewhere the line had never picked. The first session
 * to come free is picked up from here on its own.
 */
export function RapidWaiting({ rapid }: { rapid: RapidFire }) {
  const inLine = rapid.ready + rapid.working;
  const [title, note] =
    inLine === 0 && rapid.starred
      ? ["Nothing starred", "Star a project in the sidebar, or go round every open project."]
      : inLine === 0
        ? ["Nothing open", "Open a project and its sessions join the line."]
        : ["Everyone's working", "The first session to finish comes up here."];
  return (
    <main className="chat rapid-page rapid-waiting">
      <div className="rapid-waiting-title">{title}</div>
      <div className="rapid-waiting-note">{note}</div>
      <RapidBar rapid={rapid} />
    </main>
  );
}
