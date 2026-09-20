import { memo, useEffect, useMemo } from "react";
import { HOME_ID, type Project, type SessionInfo, type TranscriptEvent } from "../../../shared/protocol";
import { useRuri, watchBoard } from "../store";
import { money } from "./figures";

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

const SessionLines = memo(function SessionLines({ session, many }: { session: SessionInfo; many: boolean }) {
  const events = useRuri((s) => s.transcripts[session.id] ?? NO_EVENTS);
  const status = useRuri((s) => s.statuses[session.id] ?? "idle");
  const setActive = useRuri((s) => s.setActive);
  const lines = useMemo(() => {
    const out: Line[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < LINES; i--) {
      const line = lineOf(events[i]!);
      if (line) out.unshift(line);
    }
    // a reply being written is the open chat's business: here it is
    // "thinking" until it is done, and then it is a line
    if (status === "working" && out[out.length - 1]?.kind !== "tool") {
      out.push({ kind: "live", text: "thinking" });
      if (out.length > LINES) out.shift();
    }
    return out;
  }, [events, status]);

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

function ProjectCard({ project, status }: { project: Project; status: Status }) {
  const setActive = useRuri((s) => s.setActive);
  const first = project.sessions[0];
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
      <div className="pcard-body">
        {project.sessions.length === 0 ? (
          <span className="board-line note">no sessions open</span>
        ) : (
          project.sessions.map((session) => (
            <SessionLines key={session.id} session={session} many={project.sessions.length > 1} />
          ))
        )}
      </div>
    </div>
  );
}

const RANK: Record<Status, number> = { permission: 0, working: 1, error: 2, idle: 3 };

/** What a project is up to, from its sessions: the most urgent one wins. */
function statusOf(project: Project, statuses: Record<string, string>): Status {
  let best: Status = "idle";
  for (const session of project.sessions) {
    const s = statuses[session.id];
    const status: Status = s === "permission" || s === "working" || s === "error" ? s : "idle";
    if (RANK[status] < RANK[best]) best = status;
  }
  return best;
}

/**
 * The strip at the top of Home: the agent's chat on one side, what all of
 * it is costing on the other.
 *
 * The projects used to be the other side of this strip; they are their own
 * page off the sidebar now, and the statistics took the place. The chat
 * tab carries Home's own dot, so a turn you left running shows from the
 * statistics page.
 */
export function HomeTabs({ tab, onTab }: { tab: HomeTab; onTab: (tab: HomeTab) => void }) {
  const statuses = useRuri((s) => s.statuses);
  const homeStatus = statuses[HOME_ID] ?? "idle";
  return (
    <div className="home-tabs">
      <div className="home-tabs-group" role="tablist" aria-label="Home">
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

/** Every open project on one page: what they are doing and what it cost. */
export function ProjectsPage() {
  const projects = useRuri(selectShown);
  const statuses = useRuri((s) => s.statuses);
  // while this is up, every chat's finished steps come here (and, as it
  // opens, every chat's last few lines as they now stand)
  useEffect(() => watchBoard(), []);

  const { live, idle } = useMemo(() => {
    const ranked = projects
      .map((project) => ({ project, status: statusOf(project, statuses) }))
      .sort((a, b) => RANK[a.status] - RANK[b.status] || a.project.name.localeCompare(b.project.name));
    return {
      live: ranked.filter((x) => x.status !== "idle"),
      idle: ranked.filter((x) => x.status === "idle"),
    };
  }, [projects, statuses]);

  const working = live.filter((x) => x.status === "working").length;
  const waiting = live.filter((x) => x.status === "permission").length;
  const errored = live.filter((x) => x.status === "error").length;
  const grid = (items: typeof live) => (
    <div className="projects-grid">
      {items.map(({ project, status }) => (
        <ProjectCard key={project.id} project={project} status={status} />
      ))}
    </div>
  );

  return (
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
  );
}
