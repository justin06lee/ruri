/**
 * The usage gauges flanking the composer: context occupancy, the 5-hour
 * window, the weekly window, and the account's model-scoped weekly window
 * (the harness names that one itself — "Fable", "Opus").
 *
 * The windows belong to whichever harness the channel's model runs on, not
 * to Claude: a session on Codex reads Codex's own limits, and a harness that
 * reports none shows empty bars rather than someone else's numbers.
 *
 * Each gauge is a number over a thin bar that fills left to right; past 90%
 * the fill turns the diff's red, the one place a gauge asks to be looked at.
 *
 * Under each name, for the windows that roll over, is how long until they
 * do — the percentage says how much is left, which is not the thing you plan
 * around.
 */

import type { ContextUsage, UsageLimits } from "../../../shared/protocol";
import { useNow } from "../lib/beat";
import { useRuri } from "../store";

/** Where a bar turns red. */
const HOT_AT = 90;

/** A harness with nothing to report — a stable identity, so the selector
 *  it comes out of never re-renders on a fresh object. */
const NO_LIMITS: UsageLimits = {};

/** Tokens as the composer has room for: 128k, 1.04M, 940. */
function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return `${n}`;
}

interface Gauge {
  /** The short name under the bar — which window this gauge watches. */
  name: string;
  /** 0-100, already clamped. */
  percent: number;
  /** The big read: a token count for context, a percentage for the rest. */
  value: string;
  /** How long until this window rolls over, already worded; "" for the ones
   *  that never do (context) and the ones whose harness doesn't say. */
  reset: string;
  title: string;
}

function Meter({ gauge }: { gauge: Gauge }) {
  return (
    <div className="usage-gauge" title={gauge.title}>
      <div className="usage-value">{gauge.value}</div>
      <div className={`usage-bar${gauge.percent >= HOT_AT ? " hot" : ""}`} aria-hidden>
        <div className="usage-fill" style={{ width: `${gauge.percent}%` }} />
      </div>
      <div className="usage-name">
        {gauge.name}
        {gauge.reset && <span className="usage-reset">{gauge.reset}</span>}
      </div>
    </div>
  );
}

/** Round to whole percent, clamped — the endpoint can report over 100. */
function pct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** A reading old enough to have moved on names when it was taken — the
 *  numbers a relaunch opens on are the last run's until the first fresh read
 *  lands, and hovering should say so rather than pass them off as now. */
function asOf(at: number | undefined): string {
  if (at === undefined || Date.now() - at < 10 * 60_000) return "";
  const when = new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return ` · read at ${when}`;
}

/**
 * The wait until a window rolls over, in the width a gauge column has: "in
 * 41m", "in 2h 10m", "in 6d 22h". A countdown rather than a clock time
 * because that is the question being asked — how long until the limit is
 * mine again — and because a clock time three days out has to say which day.
 *
 * A stamp already past says nothing: the window has turned over and the next
 * read carries the new one, so a stale "in 0m" would be the only lie here.
 */
function until(at: number | undefined, now: number): string {
  if (at === undefined || at <= now) return "";
  const mins = Math.max(1, Math.round((at - now) / 60_000));
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    const rest = mins % 60;
    return rest > 0 ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest > 0 ? `in ${days}d ${rest}h` : `in ${days}d`;
}

/** The same moment spelled out for the tooltip, dated when it isn't today. */
function resetsAt(at: number | undefined, now: number): string {
  if (at === undefined || at <= now) return "";
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const sameDay = when.toDateString() === new Date(now).toDateString();
  const day = when.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return ` · resets ${sameDay ? time : `${day} at ${time}`}`;
}

function gaugesFor(context: ContextUsage | undefined, usage: UsageLimits, now: number): Gauge[] {
  const tokens = context?.tokens ?? 0;
  const window = context?.window ?? 1_000_000;
  const ctx = pct((tokens / window) * 100);
  const resets = usage.resets;
  const gauges: Gauge[] = [
    {
      name: "context",
      percent: ctx,
      value: shortTokens(tokens),
      // the only window here that doesn't roll over on a clock — it empties
      // when the session does, which is /compact's business, not a wait
      reset: "",
      title: `Context — ${tokens.toLocaleString()} of ${window.toLocaleString()} tokens (${ctx}%)`,
    },
    {
      name: "5h",
      percent: pct(usage.fiveHour ?? 0),
      value: usage.fiveHour === undefined ? "—" : `${pct(usage.fiveHour)}%`,
      reset: until(resets?.fiveHour, now),
      title:
        usage.fiveHour === undefined
          ? "The 5-hour window couldn't be read"
          : `5-hour session window — ${pct(usage.fiveHour)}% used${resetsAt(resets?.fiveHour, now)}${asOf(usage.at)}`,
    },
    {
      name: "week",
      percent: pct(usage.weekly ?? 0),
      value: usage.weekly === undefined ? "—" : `${pct(usage.weekly)}%`,
      reset: until(resets?.weekly, now),
      title:
        usage.weekly === undefined
          ? "The weekly window couldn't be read"
          : `Weekly window, all models — ${pct(usage.weekly)}% used${resetsAt(resets?.weekly, now)}${asOf(usage.at)}`,
    },
  ];
  // the scoped window only exists on plans that have one, but the row is
  // built for four — an absent one still shows its empty bar
  const scoped = usage.scoped;
  gauges.push({
    name: scoped ? scoped.label.toLowerCase() : "model",
    percent: pct(scoped?.percent ?? 0),
    value: scoped ? `${pct(scoped.percent)}%` : "—",
    reset: scoped ? until(resets?.scoped, now) : "",
    title: scoped
      ? `Weekly window for ${scoped.label} — ${pct(scoped.percent)}% used${resetsAt(resets?.scoped, now)}${asOf(usage.at)}`
      : "This harness reports no model-scoped weekly window",
  });
  return gauges;
}

/** Now, to the minute. The countdowns are the only thing here that moves on
 *  its own — the readings themselves arrive on their own poll — and they
 *  hold while ruri is asleep, catching up as it wakes (lib/beat.ts). */
function useMinute(): number {
  return useNow(30_000);
}

/**
 * Two gauges for one side of the composer — context and 5h on the left,
 * the two weekly windows on the right. `model` decides whose account the
 * windows come from; Claude models carry no provider id.
 */
export function UsageGauges({
  channelId,
  model,
  side,
}: {
  channelId: string;
  /** The channel's model id, which names the harness it spends from. */
  model: string | undefined;
  side: "left" | "right";
}) {
  const context = useRuri((s) => s.contexts[channelId]);
  const provider = useRuri((s) => s.models.find((m) => m.value === model)?.provider ?? "claude");
  const usage = useRuri((s) => s.usage[provider] ?? NO_LIMITS);
  const now = useMinute();
  const gauges = gaugesFor(context, usage, now);
  const pair = side === "left" ? gauges.slice(0, 2) : gauges.slice(2, 4);
  return (
    <div className={`usage-gauges ${side}`}>
      {pair.map((g) => (
        <Meter key={g.name} gauge={g} />
      ))}
    </div>
  );
}
