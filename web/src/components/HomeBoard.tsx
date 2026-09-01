import { memo, useMemo, useState } from "react";
import { HOME_ID, type Project, type ProjectStats, type SessionInfo, type Totals, type TranscriptEvent } from "../../../shared/protocol";
import { getPref, setPref } from "../prefs";
import { useRuri } from "../store";

/**
 * The board on Home: every open project as a card, each with a few lines
 * of what its sessions are doing right now, and what it has all cost.
 *
 * Home is the one place that is not a project, so it is the one place to
 * see all of them at once — which project is working, which is waiting on
 * you, what the last thing each one did was — without walking the sidebar.
 * The lines are live: a streaming reply's tail moves as it streams, a tool
 * call shows the moment it's made. The figures come off the ledger
 * (server/ledger.ts), which is what makes them true across rewinds,
 * compactions and relaunches.
 *
 * It sits above the Home agent rather than replacing it: the board is what
 * is going on, the agent underneath is where you say what should be.
 */

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
      className={`board-session ${status}`}
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

function Figures({ totals, label }: { totals: Totals; label: string }) {
  return (
    <span className="board-figures" title={`${label}: ${totals.tokens.toLocaleString()} tokens, ${money(totals.costUsd)} at API prices, ${totals.turns} turns, ${span(totals.ms)} of turns`}>
      <span className="board-figure-label">{label}</span>
      <b>{shortCount(totals.tokens)}</b>
      <span className="board-figure-unit">tok</span>
      <b>{money(totals.costUsd)}</b>
      <b>{totals.turns}</b>
      <span className="board-figure-unit">{totals.turns === 1 ? "turn" : "turns"}</span>
    </span>
  );
}

function ProjectCard({ project, stats }: { project: Project; stats: ProjectStats | undefined }) {
  const statuses = useRuri((s) => s.statuses);
  const setActive = useRuri((s) => s.setActive);
  const status = project.sessions.some((x) => statuses[x.id] === "permission")
    ? "permission"
    : project.sessions.some((x) => statuses[x.id] === "working")
      ? "working"
      : project.sessions.some((x) => statuses[x.id] === "error")
        ? "error"
        : "idle";
  const word = { permission: "needs you", working: "working", error: "error", idle: "idle" }[status];
  const first = project.sessions[0];
  return (
    <div className={`board-card ${status}`}>
      <div
        className="board-card-head"
        role={first ? "button" : undefined}
        onClick={() => first && setActive(first.id)}
        title={first ? `Open ${project.name}` : undefined}
      >
        <span className={`dot ${status}`} aria-hidden />
        <span className="board-card-name">{project.name}</span>
        <span className="board-card-status">{word}</span>
      </div>
      <div className="board-card-body">
        {project.sessions.length === 0 ? (
          <span className="board-line note">no sessions open</span>
        ) : (
          project.sessions.map((session) => (
            <SessionLines key={session.id} session={session} many={project.sessions.length > 1} />
          ))
        )}
      </div>
      {stats && (stats.total.turns > 0 || stats.today.turns > 0) && (
        <div className="board-card-foot">
          <Figures totals={stats.today} label="today" />
          <Figures totals={stats.total} label="all" />
        </div>
      )}
    </div>
  );
}

const RANK = { permission: 0, working: 1, error: 2, idle: 3 } as const;

export function HomeBoard() {
  const projects = useRuri((s) => s.projects);
  const statuses = useRuri((s) => s.statuses);
  const stats = useRuri((s) => s.stats);
  const [folded, setFolded] = useState(getPref("ruri-home-board") === "folded");

  const ordered = useMemo(() => {
    const rank = (p: Project) =>
      Math.min(...p.sessions.map((x) => RANK[statuses[x.id] ?? "idle"]), RANK.idle);
    return [...projects].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [projects, statuses]);

  const working = projects.flatMap((p) => p.sessions).filter((x) => statuses[x.id] === "working").length;
  const waiting = projects.flatMap((p) => p.sessions).filter((x) => statuses[x.id] === "permission").length;
  const ids = [...projects.map((p) => p.id), HOME_ID];
  const today = sum(ids.map((id) => stats[id]?.today ?? NONE));
  const week = sum(ids.map((id) => stats[id]?.week ?? NONE));
  const total = sum(ids.map((id) => stats[id]?.total ?? NONE));

  if (projects.length === 0) return null;

  const toggle = () => {
    setFolded(!folded);
    setPref("ruri-home-board", folded ? "open" : "folded");
  };

  return (
    <section className={`home-board ${folded ? "folded" : ""}`}>
      <div className="home-board-head">
        <span className="home-board-title">
          {projects.length === 1 ? "1 project" : `${projects.length} projects`}
          <span className="home-board-live">
            {working > 0 && <span className="working">{working} working</span>}
            {waiting > 0 && <span className="permission">{waiting} waiting on you</span>}
            {working === 0 && waiting === 0 && <span className="idle">all quiet</span>}
          </span>
        </span>
        <span className="home-board-stats">
          <Figures totals={today} label="today" />
          <Figures totals={week} label="week" />
          <Figures totals={total} label="all" />
        </span>
        <button
          type="button"
          className="icon-button home-board-fold"
          title={folded ? "Show the projects" : "Fold the board to its numbers"}
          onClick={toggle}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d={folded ? "M6 9l6 6 6-6" : "M6 15l6-6 6 6"} />
          </svg>
        </button>
      </div>
      {!folded && (
        <div className="home-board-cards">
          {ordered.map((project) => (
            <ProjectCard key={project.id} project={project} stats={stats[project.id]} />
          ))}
        </div>
      )}
    </section>
  );
}
