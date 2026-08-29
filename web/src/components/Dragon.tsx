/**
 * The dragon gauges flanking the composer: context occupancy, the 5-hour
 * window, the weekly window, and the account's model-scoped weekly window
 * (the harness names that one itself — "Fable", "Opus").
 *
 * The windows belong to whichever harness the channel's model runs on, not
 * to Claude: a session on Codex reads Codex's own limits, and a harness that
 * reports none shows empty dragons rather than someone else's numbers.
 *
 * Each dragon fills from his feet up. Below the waterline his body is solid
 * ink and his own outline inverts to paper; above it he is the plain drawing.
 * The art is two alpha masks generated from the line art — one the strokes,
 * one the flood-filled body — so both halves are painted with theme colors
 * and follow light/dark for free. Past 80% he starts sweating.
 */

import { useId } from "react";
import type { ContextUsage, UsageLimits } from "../../../shared/protocol";
import { DRAGON, DRAGON_H, DRAGON_W } from "../dragonArt";
import { useRuri } from "../store";

/** Where the drawing swaps to the sweating one. */
const SWEAT_AT = 80;

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
  /** The short name under the number — which window this dragon watches. */
  name: string;
  /** 0-100, already clamped. */
  percent: number;
  /** The big read: a token count for context, a percentage for the rest. */
  value: string;
  title: string;
}

function Dragon({ gauge }: { gauge: Gauge }) {
  const art = DRAGON[gauge.percent >= SWEAT_AT ? "sweat" : "calm"];
  const uid = useId().replace(/:/g, "");
  // the waterline in the art's own coordinates — clipping the paths rather
  // than scaling anything, so the drawing never stretches as it fills
  const y = DRAGON_H * (1 - gauge.percent / 100);
  return (
    <div className="dragon-gauge" title={gauge.title}>
      <svg className="dragon" viewBox={`0 0 ${DRAGON_W} ${DRAGON_H}`} aria-hidden>
        <clipPath id={`below-${uid}`}>
          <rect className="dragon-clip" x="0" y={y} width={DRAGON_W} height={DRAGON_H - y} />
        </clipPath>
        <clipPath id={`above-${uid}`}>
          <rect className="dragon-clip" x="0" y="0" width={DRAGON_W} height={y} />
        </clipPath>
        {/* filled: solid body, its own detail knocked back out of it — the
            contour stays the edge of the fill instead of inverting away */}
        <g clipPath={`url(#below-${uid})`}>
          <path className="dragon-body" d={art.body} fillRule="evenodd" />
          <path className="dragon-detail" d={art.detail} fillRule="evenodd" />
        </g>
        {/* empty: the drawing as inked */}
        <g clipPath={`url(#above-${uid})`}>
          <path className="dragon-stroke" d={art.stroke} fillRule="evenodd" />
        </g>
      </svg>
      <div className="dragon-value">{gauge.value}</div>
      <div className="dragon-name">{gauge.name}</div>
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

function gaugesFor(context: ContextUsage | undefined, usage: UsageLimits): Gauge[] {
  const tokens = context?.tokens ?? 0;
  const window = context?.window ?? 1_000_000;
  const ctx = pct((tokens / window) * 100);
  const gauges: Gauge[] = [
    {
      name: "context",
      percent: ctx,
      value: shortTokens(tokens),
      title: `Context — ${tokens.toLocaleString()} of ${window.toLocaleString()} tokens (${ctx}%)`,
    },
    {
      name: "5h",
      percent: pct(usage.fiveHour ?? 0),
      value: usage.fiveHour === undefined ? "—" : `${pct(usage.fiveHour)}%`,
      title:
        usage.fiveHour === undefined
          ? "The 5-hour window couldn't be read"
          : `5-hour session window — ${pct(usage.fiveHour)}% used${asOf(usage.at)}`,
    },
    {
      name: "week",
      percent: pct(usage.weekly ?? 0),
      value: usage.weekly === undefined ? "—" : `${pct(usage.weekly)}%`,
      title:
        usage.weekly === undefined
          ? "The weekly window couldn't be read"
          : `Weekly window, all models — ${pct(usage.weekly)}% used${asOf(usage.at)}`,
    },
  ];
  // the scoped window only exists on plans that have one, but the row is
  // built for four — an absent one still shows its empty dragon
  const scoped = usage.scoped;
  gauges.push({
    name: scoped ? scoped.label.toLowerCase() : "model",
    percent: pct(scoped?.percent ?? 0),
    value: scoped ? `${pct(scoped.percent)}%` : "—",
    title: scoped
      ? `Weekly window for ${scoped.label} — ${pct(scoped.percent)}% used${asOf(usage.at)}`
      : "This harness reports no model-scoped weekly window",
  });
  return gauges;
}

/**
 * Two dragons for one side of the composer — context and 5h on the left,
 * the two weekly windows on the right. `model` decides whose account the
 * windows come from; Claude models carry no provider id.
 */
export function DragonGauges({
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
  const gauges = gaugesFor(context, usage);
  const pair = side === "left" ? gauges.slice(0, 2) : gauges.slice(2, 4);
  return (
    <div className={`dragons ${side}`}>
      {pair.map((g) => (
        <Dragon key={g.name} gauge={g} />
      ))}
    </div>
  );
}
