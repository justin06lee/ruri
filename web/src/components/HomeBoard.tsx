import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  HOME_ID,
  type BackgroundWork,
  type Project,
  type SessionInfo,
  type TranscriptEvent,
} from "../../../shared/protocol";
import { useRuri, watchBoard } from "../store";
import { Capped } from "./Capped";
import { money } from "./figures";
import { StatisticsPage } from "./Statistics";

/**
 * The projects page, and the strip at the top of Home.
 *
 * Every open project at once — which one is working, which is waiting on
 * you, what the last thing each one did was — without walking the sidebar.
 * A card per project, a few lines per session of what it has been doing.
 * The lines move a finished step at a time — a tool call, a reply once it
 * is written — and nothing on the page animates: the words of a reply as
 * they come, and anything that moves, belong to the chat that is open, and
 * nowhere else.
 *
 * It used to carry the money as well: three tiles of spending above the
 * grid, and every card footed with its own. That made one page out of two
 * questions — what is everything doing, and what has everything cost — so
 * the second went to its own page (components/Statistics.tsx) and this one
 * went to the sidebar, under Home, where a page about the projects
 * belongs. What is left on Home is the strip: the agent's chat, and the
 * statistics.
 */

/** The projects the board shows: hidden ones stay hidden here too. The
 *  selector is memoised on the list itself, so nothing re-renders on a
 *  store change that left the projects alone. */
let shownFrom: Project[] | undefined;
let shownCache: Project[] = [];
function selectShown(s: { projects: Project[] }): Project[] {
  if (s.projects !== shownFrom) {
    shownFrom = s.projects;
    shownCache = s.projects.filter((p) => !p.hidden);
  }
  return shownCache;
}

export type HomeTab = "chat" | "stats";

/** One line of activity, in the words the transcript uses. */
interface Line {
  kind: "tool" | "said" | "you" | "done" | "live" | "note";
  text: string;
}

const LINE_CHARS = 96;

function clip(text: string, max = LINE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function lineOf(event: TranscriptEvent): Line | null {
  switch (event.kind) {
    case "tool":
      if (event.name === "AskUserQuestion") return { kind: "note", text: "asked you a question" };
      return { kind: "tool", text: clip(`${event.name} · ${event.summary}`) };
    case "assistant":
      return event.text.trim() ? { kind: "said", text: clip(event.text) } : null;
    case "user":
      return { kind: "you", text: clip(`you: ${event.text}`) };
    case "result":
      return {
        kind: "done",
        text: event.stopped
          ? "stopped"
          : event.ok
            ? `done${event.costUsd !== undefined ? ` · ${money(event.costUsd)}` : ""}${event.durationMs !== undefined ? ` · ${(event.durationMs / 1000).toFixed(0)}s` : ""}`
            : clip(event.error ?? "error", 60),
      };
    case "compaction":
      return { kind: "note", text: "compacted" };
    case "plan": {
      const active = event.entries?.find((entry) => entry.status === "in_progress")?.content;
      return {
        kind: "note",
        text: clip(active ? `plan · ${active}` : event.removed ? "plan cleared" : "plan updated"),
      };
    }
    case "info":
      return { kind: "note", text: clip(event.text) };
  }
}

/** How many lines a session shows: its last few steps. */
const LINES = 3;

const NO_EVENTS: TranscriptEvent[] = [];

/** "2 agents and a script at work in the background" — what a chat whose
 *  turn is over is still doing. */
function backgroundLine(work: BackgroundWork): string {
  const count = (n: number, one: string, many: string) => (n === 1 ? `${one}` : `${n} ${many}`);
  const parts = [
    work.agents > 0 ? count(work.agents, "an agent", "agents") : undefined,
    work.scripts > 0 ? count(work.scripts, "a script", "scripts") : undefined,
  ].filter(Boolean);
  return `${parts.join(" and ")} at work in the background`;
}

const SessionLines = memo(function SessionLines({ session, many }: { session: SessionInfo; many: boolean }) {
  const events = useRuri((s) => s.transcripts[session.id] ?? NO_EVENTS);
  const turnStatus = useRuri((s) => s.statuses[session.id] ?? "idle");
  const work = useRuri((s) => s.work[session.id]);
  // a turn over with its agents or scripts still going is still working
  const status = work && (turnStatus === "idle" || turnStatus === "error") ? "working" : turnStatus;
  const setActive = useRuri((s) => s.setActive);
  const lines = useMemo(() => {
    const out: Line[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < LINES; i--) {
      const line = lineOf(events[i]!);
      if (line) out.unshift(line);
    }
    // a reply being written is the open chat's business: here it is
    // "thinking" until it is done, and then it is a line
    if (turnStatus === "working" && out[out.length - 1]?.kind !== "tool") {
      out.push({ kind: "live", text: "thinking" });
      if (out.length > LINES) out.shift();
    } else if (work && turnStatus !== "working" && turnStatus !== "permission") {
      out.push({ kind: "live", text: backgroundLine(work) });
      if (out.length > LINES) out.shift();
    }
    return out;
  }, [events, turnStatus, work]);

  return (
    <button
      type="button"
      className="board-session"
      title={`Open ${session.title ?? "this session"}`}
      onClick={() => setActive(session.id)}
    >
      {many && (
        <span className="board-session-title">
          <span className={`dot ${status}`} aria-hidden />
          {session.title ?? "new session"}
        </span>
      )}
      {lines.length === 0 ? (
        <span className="board-line note">nothing yet</span>
      ) : (
        lines.map((line, i) => (
          <span key={i} className={`board-line ${line.kind}`}>
            {line.text}
          </span>
        ))
      )}
    </button>
  );
});

type Status = "permission" | "working" | "error" | "idle";

const WORD: Record<Status, string> = {
  permission: "needs you",
  working: "working",
  error: "error",
  idle: "idle",
};

function ProjectCard({
  project,
  status,
  sessions,
}: {
  project: Project;
  status: Status;
  /** The sessions it lists (see shownSessions). */
  sessions: SessionInfo[];
}) {
  const setActive = useRuri((s) => s.setActive);
  const first = sessions[0];
  return (
    <div className={`pcard st-${status}`}>
      <div
        className="pcard-head"
        role={first ? "button" : undefined}
        onClick={() => first && setActive(first.id)}
        title={first ? `Open ${project.name}` : undefined}
      >
        <span className={`dot ${status}`} aria-hidden />
        <span className="pcard-name">{project.name}</span>
        <span className="pcard-status">{WORD[status]}</span>
      </div>
      {/* a project of twenty chats is not a card twenty chats tall */}
      <Capped max={4} className="pcard-body">
        {project.sessions.length === 0 ? (
          <span className="board-line note">no sessions open</span>
        ) : (
          sessions.map((session) => (
            <SessionLines key={session.id} session={session} many={project.sessions.length > 1} />
          ))
        )}
      </Capped>
    </div>
  );
}

const RANK: Record<Status, number> = { permission: 0, working: 1, error: 2, idle: 3 };

/** What one session is up to. A session whose turn is over is still
 *  working while agents or scripts it left running are. */
function sessionStatus(
  session: SessionInfo,
  statuses: Record<string, string>,
  work: Record<string, BackgroundWork>,
): Status {
  const s = statuses[session.id];
  return s === "permission" || s === "working"
    ? s
    : session.id in work
      ? "working"
      : s === "error"
        ? "error"
        : "idle";
}

/** What a project is up to, from its sessions: the most urgent one wins. */
function statusOf(
  project: Project,
  statuses: Record<string, string>,
  work: Record<string, BackgroundWork>,
): Status {
  let best: Status = "idle";
  for (const session of project.sessions) {
    const status = sessionStatus(session, statuses, work);
    if (RANK[status] < RANK[best]) best = status;
  }
  return best;
}

/**
 * The sessions a card lists. A live card lists the ones that make it live
 * — working, waiting on you, errored — and none of the chats that finished
 * hours ago beside them, which are a click away in the sidebar; an idle
 * card has nothing live to show, so it shows where each chat left off.
 */
function shownSessions(
  project: Project,
  status: Status,
  statuses: Record<string, string>,
  work: Record<string, BackgroundWork>,
): SessionInfo[] {
  if (status === "idle") return project.sessions;
  return project.sessions.filter((session) => sessionStatus(session, statuses, work) !== "idle");
}

/**
 * The strip at the top of Home: the agent's chat on one side, what all of
 * it is costing on the other.
 *
 * The projects used to be the other side of this strip; they are their own
 * page off the sidebar now, and the statistics took the place. The chat
 * tab carries Home's own dot, so a turn you left running shows from the
 * statistics page.
 *
 * The inked pill that says which page is up is one piece of its own under
 * the two words, not a background each word wears in turn: picking the
 * other page slides it across to it (styles.css, .home-tab-glide).
 */
function HomeTabs({ tab, onTab }: { tab: HomeTab; onTab: (tab: HomeTab) => void }) {
  const homeStatus = useRuri((s) => s.statuses[HOME_ID] ?? "idle");
  const group = useRef<HTMLDivElement>(null);
  const glide = useRef<HTMLSpanElement>(null);
  // under whichever word is on — measured, since the chat tab grows a dot
  // while Home works; the first placing is where it starts, not a slide
  useLayoutEffect(() => {
    const place = () => {
      const on = group.current?.querySelector<HTMLElement>(".home-tab.on");
      const pill = glide.current;
      if (!on || !pill) return;
      pill.style.width = `${on.offsetWidth}px`;
      pill.style.transform = `translateX(${on.offsetLeft}px)`;
    };
    place();
    const frame = requestAnimationFrame(() => glide.current?.classList.add("placed"));
    void document.fonts.ready.then(place);
    return () => cancelAnimationFrame(frame);
  }, [tab, homeStatus]);
  return (
    <div className="home-tabs">
      <div className="home-tabs-group" role="tablist" aria-label="Home" ref={group}>
        <span className="home-tab-glide" ref={glide} aria-hidden />
        <button
          type="button"
          role="tab"
          aria-selected={tab === "chat"}
          className={`home-tab ${tab === "chat" ? "on" : ""}`}
          title="The Home agent — ask it to open and close projects"
          onClick={() => onTab("chat")}
        >
          chat
          {(homeStatus === "working" || homeStatus === "permission") && (
            <span
              className={`dot ${homeStatus}`}
              aria-label={homeStatus === "working" ? "Home is working" : "Home needs you"}
            />
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "stats"}
          className={`home-tab ${tab === "stats" ? "on" : ""}`}
          title="What all of this has cost — and what the agents are costing this machine right now"
          onClick={() => onTab("stats")}
        >
          statistics
        </button>
      </div>
    </div>
  );
}

/** How long Home's two pages take to slide past each other — the
 *  .home-track transition in styles.css. */
const SLIDE_MS = 380;

/**
 * Home: its two pages side by side on one track, under the strip that
 * picks between them — the agent's chat on the left, the statistics on the
 * right. Picking the other one slides the strip's pill across and the
 * track a page's width along with it, so the page you leave goes out one
 * side as the other comes in from the other; the strip itself stays put.
 *
 * Only the page you are on is mounted. The other is put up for the slide
 * and taken down once it is out of sight — the statistics watch this
 * machine's processes while they are up, and nothing should be doing that
 * behind the chat.
 */
export function HomeDeck({
  tab,
  onTab,
  chat,
}: {
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  /** The chat's page, as the pane would show it on its own. */
  chat: ReactNode;
}) {
  const [leaving, setLeaving] = useState<HomeTab | null>(null);
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setLeaving(null), SLIDE_MS + 60);
    return () => clearTimeout(timer);
  }, [leaving, tab]);
  const go = (next: HomeTab) => {
    if (next === tab) return;
    setLeaving(tab);
    onTab(next);
  };
  const up = (page: HomeTab) => tab === page || leaving === page;
  return (
    <div className="home-deck">
      <HomeTabs tab={tab} onTab={go} />
      <div className={`home-track on-${tab}`}>
        <div className="home-slide" inert={tab !== "chat"}>
          {up("chat") && chat}
        </div>
        <div className="home-slide" inert={tab !== "stats"}>
          {up("stats") && (
            <main className="chat home-stats">
              <div className="home-tabs-space" aria-hidden />
              <StatisticsPage />
            </main>
          )}
        </div>
      </div>
    </div>
  );
}

/** Every open project on one page: what they are doing and what it cost. */
export function ProjectsPage() {
  const projects = useRuri(selectShown);
  const statuses = useRuri((s) => s.statuses);
  const work = useRuri((s) => s.work);
  // while this is up, every chat's finished steps come here (and, as it
  // opens, every chat's last few lines as they now stand)
  useEffect(() => watchBoard(), []);

  const { live, idle } = useMemo(() => {
    const ranked = projects
      .map((project) => {
        const status = statusOf(project, statuses, work);
        return { project, status, sessions: shownSessions(project, status, statuses, work) };
      })
      .sort((a, b) => RANK[a.status] - RANK[b.status] || a.project.name.localeCompare(b.project.name));
    return {
      live: ranked.filter((x) => x.status !== "idle"),
      idle: ranked.filter((x) => x.status === "idle"),
    };
  }, [projects, statuses, work]);

  const working = live.filter((x) => x.status === "working").length;
  const waiting = live.filter((x) => x.status === "permission").length;
  const errored = live.filter((x) => x.status === "error").length;
  const grid = (items: typeof live) => (
    <div className="projects-grid">
      {items.map(({ project, status, sessions }) => (
        <ProjectCard key={project.id} project={project} status={status} sessions={sessions} />
      ))}
    </div>
  );

  return (
    <>
      {/* the same band of air the settings page stands under: this page has
          no header bar either, so the count would start hard against the
          window's edge, with nothing up there to drag the window by */}
      <div className="page-drag" aria-hidden />
      <div className="board-page projects-page">
        <div className="board-inner projects-inner">
          <div className="projects-head">
            <div className="projects-count">
              <span className="projects-count-n">
                {projects.length}
                <small>{projects.length === 1 ? "project" : "projects"}</small>
              </span>
              <span className="projects-live">
                {waiting > 0 && <span className="st-permission">{waiting} waiting on you</span>}
                {working > 0 && <span className="st-working">{working} working</span>}
                {errored > 0 && (
                  <span className="st-error">
                    {errored} {errored === 1 ? "error" : "errors"}
                  </span>
                )}
                {live.length === 0 && (
                  <span className="st-idle">{projects.length === 0 ? "nothing open" : "all quiet"}</span>
                )}
              </span>
            </div>
          </div>

          {projects.length === 0 && (
            <div className="board-empty projects-empty">
              No projects open. Ask Home on the chat tab to open one — “let's work on X and Y today”.
            </div>
          )}

          {live.length > 0 && (
            <>
              <div className="projects-group">live</div>
              {grid(live)}
            </>
          )}
          {idle.length > 0 && (
            <>
              {live.length > 0 && <div className="projects-group">idle</div>}
              {grid(idle)}
            </>
          )}
        </div>
      </div>
    </>
  );
}
