/**
 * What all of this is costing — in money, and in this machine.
 *
 * Home's other page. It used to be the top strip of the projects page,
 * three tiles of money above a grid of cards, which made the projects page
 * two pages at once: what everything is doing, and what everything has
 * spent. They are separate questions and they are separate pages now
 * (components/HomeBoard.tsx keeps the first).
 *
 * The money comes off the ledger (server/ledger.ts), which is what makes
 * it true across rewinds, compactions and relaunches. The machine's side
 * comes off `ps`, sampled only while this page is up (server/resources.ts):
 * every chat that has been prompted holds a warm harness process of 150 to
 * 400 MB, and this is where you find out which ones, and how much.
 */
import { memo, useEffect, useMemo } from "react";
import { HOME_ID, type AgentProcess, type Project, type Totals } from "../../../shared/protocol";
import { useRuri, watchMeters } from "../store";
import { money, shortCount, span, sum, NONE } from "./figures";

/** "1.4 GB", "312 MB" — one number and its unit, never more. */
function bytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} kB`;
}

/** "in 2h", "in 40m", "any moment" — when a window rolls over. */
function backIn(at: number): string {
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return "any moment";
  if (mins < 60) return `in ${mins}m`;
  const h = Math.round(mins / 60);
  return h < 48 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

/** "3h", "14m", "just started" — how long a process has been up. */
function upFor(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just started";
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

function figuresTitle(label: string, totals: Totals): string {
  return `${label}: ${totals.tokens.toLocaleString()} tokens, ${money(totals.costUsd)} at API prices, ${totals.turns} turns, ${span(totals.ms)} of turns`;
}

/** One span's figures, cost in large type. */
function StatTile({ totals, label }: { totals: Totals; label: string }) {
  return (
    <div className="stat-tile" title={figuresTitle(label, totals)}>
      <span className="stat-label">{label}</span>
      <span className="stat-cost">{money(totals.costUsd)}</span>
      <span className="stat-sub">
        <span>
          <b>{shortCount(totals.tokens)}</b> tok
        </span>
        <span>
          <b>{totals.turns}</b> {totals.turns === 1 ? "turn" : "turns"}
        </span>
        {totals.ms > 0 && (
          <span>
            <b>{span(totals.ms)}</b>
          </span>
        )}
      </span>
    </div>
  );
}

/** A bar as wide as its share, for reading a column down rather than across. */
function Share({ of, all, kind }: { of: number; all: number; kind: string }) {
  const part = all > 0 ? Math.max(0.01, Math.min(1, of / all)) : 0;
  return (
    <span className={`share ${kind}`} aria-hidden>
      <span className="share-fill" style={{ width: `${(part * 100).toFixed(1)}%` }} />
    </span>
  );
}

/** What each project has spent, heaviest first. */
const Spending = memo(function Spending({ projects }: { projects: Project[] }) {
  const stats = useRuri((s) => s.stats);
  const rows = useMemo(() => {
    const all = [...projects.map((p) => ({ id: p.id, name: p.name })), { id: HOME_ID, name: "Home" }]
      .map((p) => ({ ...p, totals: stats[p.id]?.total ?? NONE, today: stats[p.id]?.today ?? NONE }))
      .filter((p) => p.totals.turns > 0 || p.today.turns > 0);
    all.sort((a, b) => b.totals.costUsd - a.totals.costUsd);
    return all;
  }, [projects, stats]);

  const most = rows[0]?.totals.costUsd ?? 0;
  if (rows.length === 0) {
    return <div className="stats-empty">Nothing has run yet.</div>;
  }
  return (
    <div className="stats-table">
      <div className="stats-row stats-head">
        <span>project</span>
        <span>today</span>
        <span>all time</span>
        <span>tokens</span>
        <span>turns</span>
        <span>time</span>
      </div>
      {rows.map((row) => (
        <div className="stats-row" key={row.id} title={figuresTitle(row.name, row.totals)}>
          <span className="stats-name">
            {row.name}
            <Share of={row.totals.costUsd} all={most} kind="cost" />
          </span>
          <span>{row.today.turns > 0 ? money(row.today.costUsd) : "—"}</span>
          <span>
            <b>{money(row.totals.costUsd)}</b>
          </span>
          <span>{shortCount(row.totals.tokens)}</span>
          <span>{row.totals.turns}</span>
          <span>{row.totals.ms > 0 ? span(row.totals.ms) : "—"}</span>
        </div>
      ))}
    </div>
  );
});

/**
 * What a running agent is called on screen: the chat it is having.
 *
 * Every agent here belongs to one — that is what makes it an agent rather
 * than machinery (server/resources.ts) — but a chat closed while its
 * process was still winding down leaves an id nothing answers to, so the
 * program's own name is the fallback.
 */
function agentTitle(
  agent: AgentProcess,
  nameOf: (channelId: string) => { project: string; session: string } | undefined,
): { lead: string; sub: string } {
  if (agent.channelId === HOME_ID) return { lead: "Home", sub: agent.name };
  const named = agent.channelId ? nameOf(agent.channelId) : undefined;
  return named ? { lead: named.project, sub: named.session } : { lead: agent.name, sub: "a closed chat" };
}

/**
 * The agents running on this machine right now, heaviest first.
 *
 * A harness and the MCP servers it started are one row, not six: the
 * figures are the whole family's, and `helpers` says how many that was.
 */
const Agents = memo(function Agents() {
  const resources = useRuri((s) => s.resources);
  const projects = useRuri((s) => s.projects);
  const setActive = useRuri((s) => s.setActive);

  const nameOf = useMemo(() => {
    const names = new Map<string, { project: string; session: string }>();
    for (const project of projects) {
      for (const session of project.sessions) {
        names.set(session.id, { project: project.name, session: session.title ?? "new session" });
      }
    }
    return (channelId: string) => names.get(channelId);
  }, [projects]);

  if (!resources) {
    return <div className="stats-empty">Reading this machine…</div>;
  }
  const { agents, app, host } = resources;
  const agentBytes = agents.reduce((n, a) => n + a.rss, 0);
  // what ruri is of this machine — the honest figure, and the one you act
  // on. macOS reports almost no memory "free" whatever is running, because
  // it keeps what it is not using as cache, so free memory is not a number
  // to put in front of anyone.
  const share = host.totalBytes > 0 ? ((agentBytes + app.rss) / host.totalBytes) * 100 : 0;

  return (
    <>
      <div className="meters-summary">
        <div
          className="meter-tile"
          title={`${agents.length} chats with a harness running, and everything those started`}
        >
          <span className="stat-label">agents</span>
          <span className="stat-cost">{bytes(agentBytes)}</span>
          <span className="stat-sub">
            <span>
              <b>{agents.length}</b> {agents.length === 1 ? "agent" : "agents"}
            </span>
            <span>
              <b>{agents.reduce((n, a) => n + a.cpu, 0).toFixed(0)}%</b> cpu
            </span>
          </span>
        </div>
        <div
          className="meter-tile"
          title="ruri itself: the server, its window, the shells behind the terminal tabs, and the probes that ask each harness what models it has"
        >
          <span className="stat-label">ruri</span>
          <span className="stat-cost">{bytes(app.rss)}</span>
          <span className="stat-sub">
            <span>
              <b>{app.processes}</b> proc
            </span>
            <span>
              <b>{app.cpu.toFixed(0)}%</b> cpu
            </span>
          </span>
        </div>
        <div
          className="meter-tile"
          title={`ruri and its agents hold ${bytes(agentBytes + app.rss)} of this machine's ${bytes(host.totalBytes)}`}
        >
          <span className="stat-label">of this machine</span>
          <span className="stat-cost">{share.toFixed(share >= 10 ? 0 : 1)}%</span>
          <span className="stat-sub">
            <span>
              <b>{bytes(agentBytes + app.rss)}</b> of
            </span>
            <span>
              <b>{bytes(host.totalBytes)}</b>
            </span>
          </span>
        </div>
      </div>

      {agents.length === 0 ? (
        <div className="stats-empty">
          No chat has a harness running. A chat closes its process when you leave it, and the next prompt
          picks the conversation back up where it was. Everything else ruri runs — the shells behind the
          terminal tabs, the probes that ask each harness what models it has — is counted under ruri.
        </div>
      ) : (
        <div className="stats-table agents-table">
          <div className="stats-row stats-head">
            <span>agent</span>
            <span>memory</span>
            <span>cpu</span>
            <span>up</span>
            <span>pid</span>
          </div>
          {agents.map((agent) => {
            const { lead, sub } = agentTitle(agent, nameOf);
            const open = agent.channelId && nameOf(agent.channelId);
            return (
              <div
                className={`stats-row agent-row${open ? " openable" : ""}`}
                key={agent.pid}
                role={open ? "button" : undefined}
                title={
                  open
                    ? `Open ${lead} — ${agent.name}, ${agent.helpers} helper processes`
                    : `${agent.name}, ${agent.helpers} helper processes`
                }
                onClick={() => open && agent.channelId && setActive(agent.channelId)}
              >
                <span className="stats-name">
                  {lead}
                  <small>{sub}</small>
                  <Share of={agent.rss} all={agents[0]!.rss} kind="mem" />
                </span>
                <span>
                  <b>{bytes(agent.rss)}</b>
                  {agent.helpers > 0 && <small> +{agent.helpers}</small>}
                </span>
                <span>{agent.cpu.toFixed(0)}%</span>
                <span>{upFor(agent.uptimeMs)}</span>
                <span className="agent-pid">{agent.pid}</span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
});

/** Home's statistics page: the money, then the machine. */
export function StatisticsPage() {
  const projects = useRuri((s) => s.projects);
  const stats = useRuri((s) => s.stats);
  const usage = useRuri((s) => s.usage);
  // the meters run for exactly as long as this page is up, and not a
  // moment longer (server/resources.ts)
  useEffect(() => watchMeters(), []);

  const shown = useMemo(() => projects.filter((p) => !p.hidden), [projects]);
  const ids = useMemo(() => [...shown.map((p) => p.id), HOME_ID], [shown]);
  // the gauges in the composer's dock, written out: every window a
  // provider holds, how much of it is gone, and when it comes back
  const limits = useMemo(() => {
    const many = Object.keys(usage).length > 1;
    const out: Array<{ key: string; label: string; percent: number; resets?: string; title: string }> = [];
    for (const [provider, limit] of Object.entries(usage)) {
      const lead = many ? `${provider} · ` : "";
      const add = (name: string, percent: number | undefined, at: number | undefined) => {
        if (percent === undefined) return;
        out.push({
          key: `${provider}-${name}`,
          label: `${lead}${name}`,
          percent,
          ...(at !== undefined ? { resets: `back ${backIn(at)}` } : {}),
          title: `${Math.round(percent)}% of the ${name} window used`,
        });
      };
      add("5-hour", limit.fiveHour, limit.resets?.fiveHour);
      add("weekly", limit.weekly, limit.resets?.weekly);
      if (limit.scoped) {
        out.push({
          key: `${provider}-scoped`,
          label: `${lead}${limit.scoped.label.toLowerCase()} weekly`,
          percent: limit.scoped.percent,
          ...(limit.resets?.scoped !== undefined ? { resets: `back ${backIn(limit.resets.scoped)}` } : {}),
          title: `${Math.round(limit.scoped.percent)}% of the ${limit.scoped.label} weekly window used`,
        });
      }
    }
    return out;
  }, [usage]);

  const today = sum(ids.map((id) => stats[id]?.today ?? NONE));
  const week = sum(ids.map((id) => stats[id]?.week ?? NONE));
  const total = sum(ids.map((id) => stats[id]?.total ?? NONE));

  return (
    <div className="board-page stats-page">
      <div className="board-inner stats-inner">
        <div className="stats-tiles">
          <StatTile totals={today} label="today" />
          <StatTile totals={week} label="this week" />
          <StatTile totals={total} label="all time" />
        </div>

        <div className="stats-group">what is running</div>
        <Agents />

        <div className="stats-group">what it has cost</div>
        <Spending projects={shown} />

        {limits.length > 0 && (
          <>
            <div className="stats-group">what is left</div>
            <div className="stats-table limits-table">
              {limits.map((limit) => (
                <div className="stats-row" key={limit.key} title={limit.title}>
                  <span className="stats-name">
                    {limit.label}
                    <Share of={limit.percent} all={100} kind="limit" />
                  </span>
                  <span>
                    <b>{Math.round(limit.percent)}%</b> used
                  </span>
                  <span className="limit-resets">{limit.resets ?? ""}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
