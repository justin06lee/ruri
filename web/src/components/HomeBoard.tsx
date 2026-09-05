import { memo, useMemo } from "react";
import { HOME_ID, type Project, type ProjectStats, type SessionInfo, type Totals, type TranscriptEvent } from "../../../shared/protocol";
import { useRuri } from "../store";

/**
 * Home's two pages and the strip that swaps them.
 *
 * Home is the one place that is not a project, so it is the one place to
 * see all of them at once — which project is working, which is waiting on
 * you, what the last thing each one did was — without walking the sidebar.
 * That is the projects page: every open project as a card with a few live
 * lines of what its sessions are doing right now, and what it has all
 * cost. The lines are live: a streaming reply's tail moves as it streams,
 * a tool call shows the moment it's made. The figures come off the ledger
 * (server/ledger.ts), which is what makes them true across rewinds,
 * compactions and relaunches.
 *
 * The other page is the Home agent's chat. They used to share the pane,
 * the board stacked over the agent, and each got in the other's way: the
 * board squeezed to half a card's height, the agent pushed to the floor.
 * Now the strip at the top picks one, and remembers the choice.
 */

export type HomeTab = "chat" | "projects";

/** "1.3M", "84k", "512" — room for one number, not a locale's worth. */
export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

function money(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

/** "3h 12m" for a run of turns' wall time. */
function span(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

const NONE: Totals = { tokens: 0, costUsd: 0, turns: 0, ms: 0 };

function sum(parts: Totals[]): Totals {
  return parts.reduce(
    (a, b) => ({ tokens: a.tokens + b.tokens, costUsd: a.costUsd + b.costUsd, turns: a.turns + b.turns, ms: a.ms + b.ms }),
    NONE,
  );
}

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

/** The tail of what's streaming: the last words, not the first. */
function tail(text: string, max = 84): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `…${flat.slice(-(max - 1)).trimStart()}` : flat;
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
      return { kind: "note", text: clip(active ? `plan · ${active}` : event.removed ? "plan cleared" : "plan updated") };
    }
    case "info":
      return { kind: "note", text: clip(event.text) };
  }
}

/** How many lines a session shows: the streaming tail and the last few. */
const LINES = 3;

const NO_EVENTS: TranscriptEvent[] = [];

const SessionLines = memo(function SessionLines({ session, many }: { session: SessionInfo; many: boolean }) {
  const events = useRuri((s) => s.transcripts[session.id] ?? NO_EVENTS);
  const draft = useRuri((s) => s.drafts[session.id]);
  const status = useRuri((s) => s.statuses[session.id] ?? "idle");
  const setActive = useRuri((s) => s.setActive);
  const lines = useMemo(() => {
    const out: Line[] = [];
    for (let i = events.length - 1; i >= 0 && out.length < LINES; i--) {
      const line = lineOf(events[i]!);
      if (line) out.unshift(line);
    }
    if (draft?.text.trim()) {
      out.push({ kind: "live", text: tail(draft.text) });
      if (out.length > LINES) out.shift();
    } else if (status === "working" && out[out.length - 1]?.kind !== "tool") {
      out.push({ kind: "live", text: "thinking" });
      if (out.length > LINES) out.shift();
    }
    return out;
  }, [events, draft, status]);

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
            {line.kind === "live" && <span className="board-cursor" aria-hidden />}
          </span>
        ))
      )}
    </button>
  );
});

function figuresTitle(label: string, totals: Totals): string {
  return `${label}: ${totals.tokens.toLocaleString()} tokens, ${money(totals.costUsd)} at API prices, ${totals.turns} turns, ${span(totals.ms)} of turns`;
}

/** A card's figures for one span: the cost leads, the rest follows. */
function CardFigures({ totals, label }: { totals: Totals; label: string }) {
  return (
    <span className="pcard-fig" title={figuresTitle(label, totals)}>
      <span className="pcard-fig-label">{label}</span>
      <span className="pcard-fig-row">
        <b>{money(totals.costUsd)}</b>
        <span>{shortCount(totals.tokens)} tok</span>
        <span>{totals.turns} {totals.turns === 1 ? "turn" : "turns"}</span>
      </span>
    </span>
  );
}

/** The page's own figures for one span — a tile, cost in large type. */
function StatTile({ totals, label }: { totals: Totals; label: string }) {
  return (
    <div className="stat-tile" title={figuresTitle(label, totals)}>
      <span className="stat-label">{label}</span>
      <span className="stat-cost">{money(totals.costUsd)}</span>
      <span className="stat-sub">
        <span><b>{shortCount(totals.tokens)}</b> tok</span>
        <span><b>{totals.turns}</b> {totals.turns === 1 ? "turn" : "turns"}</span>
        {totals.ms > 0 && <span><b>{span(totals.ms)}</b></span>}
      </span>
    </div>
  );
}

type Status = "permission" | "working" | "error" | "idle";

const WORD: Record<Status, string> = { permission: "needs you", working: "working", error: "error", idle: "idle" };

function ProjectCard({ project, stats, status }: { project: Project; stats: ProjectStats | undefined; status: Status }) {
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
      {stats && (stats.total.turns > 0 || stats.today.turns > 0) && (
        <div className="pcard-foot">
          <CardFigures totals={stats.today} label="today" />
          <CardFigures totals={stats.total} label="all time" />
        </div>
      )}
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
 * The strip at the top of Home: chat on one side, projects on the other.
 * The projects tab carries the count and, while anything is running, the
 * same pulsing dot the sidebar uses; the chat tab carries Home's own dot,
 * so a turn you left running shows from the other page.
 */
export function HomeTabs({ tab, onTab }: { tab: HomeTab; onTab: (tab: HomeTab) => void }) {
  const projects = useRuri((s) => s.projects);
  const statuses = useRuri((s) => s.statuses);
  const homeStatus = statuses[HOME_ID] ?? "idle";
  let working = 0;
  let waiting = 0;
  for (const project of projects) {
    for (const session of project.sessions) {
      if (statuses[session.id] === "working") working++;
      else if (statuses[session.id] === "permission") waiting++;
    }
  }
  const live = waiting > 0 ? "permission" : working > 0 ? "working" : null;
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
            <span className={`dot ${homeStatus}`} aria-label={homeStatus === "working" ? "Home is working" : "Home needs you"} />
          )}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "projects"}
          className={`home-tab ${tab === "projects" ? "on" : ""}`}
          title={
            waiting > 0
              ? `${waiting} waiting on you, ${working} working`
              : working > 0
                ? `${working} working`
                : "Every open project at a glance"
          }
          onClick={() => onTab("projects")}
        >
          projects
          {projects.length > 0 && <span className="home-tab-count">{projects.length}</span>}
          {live && <span className={`dot ${live}`} aria-label={live === "permission" ? "a project needs you" : "projects working"} />}
        </button>
      </div>
    </div>
  );
}

/** Every open project on one page: what they are doing and what it cost. */
export function ProjectsPage() {
  const projects = useRuri((s) => s.projects);
  const statuses = useRuri((s) => s.statuses);
  const stats = useRuri((s) => s.stats);

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
  const ids = [...projects.map((p) => p.id), HOME_ID];
  const today = sum(ids.map((id) => stats[id]?.today ?? NONE));
  const week = sum(ids.map((id) => stats[id]?.week ?? NONE));
  const total = sum(ids.map((id) => stats[id]?.total ?? NONE));

  const grid = (items: typeof live) => (
    <div className="projects-grid">
      {items.map(({ project, status }) => (
        <ProjectCard key={project.id} project={project} stats={stats[project.id]} status={status} />
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
              {errored > 0 && <span className="st-error">{errored} {errored === 1 ? "error" : "errors"}</span>}
              {live.length === 0 && <span className="st-idle">{projects.length === 0 ? "nothing open" : "all quiet"}</span>}
            </span>
          </div>
          <StatTile totals={today} label="today" />
          <StatTile totals={week} label="this week" />
          <StatTile totals={total} label="all time" />
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
