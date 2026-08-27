/**
 * The dragon gauges flanking the composer: context occupancy, the 5-hour
 * window, the weekly window, and the account's model-scoped weekly window
 * (the endpoint names that one itself — "Fable", "Opus").
 *
 * Each dragon fills from his feet up. Below the waterline his body is solid
 * ink and his own outline inverts to paper; above it he is the plain drawing.
 * The art is two alpha masks generated from the line art — one the strokes,
 * one the flood-filled body — so both halves are painted with theme colors
 * and follow light/dark for free. Past 80% he starts sweating.
 */

import type { ContextUsage, UsageLimits } from "../../../shared/protocol";
import { useRuri } from "../store";

/** Where the drawing swaps to the sweating one. */
const SWEAT_AT = 80;

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
  const art = gauge.percent >= SWEAT_AT ? "sweat" : "calm";
  // clip-path insets, not a height animation: the masks stay the same size so
  // the drawing never stretches as the level moves
  const below = { clipPath: `inset(${100 - gauge.percent}% 0 0 0)` };
  const above = { clipPath: `inset(0 0 ${gauge.percent}% 0)` };
  return (
    <div className={`dragon-gauge ${gauge.percent >= SWEAT_AT ? "hot" : ""}`} title={gauge.title}>
      <div className="dragon">
        <span className={`dragon-layer solid ${art}`} style={below} />
        <span className={`dragon-layer outline-inv ${art}`} style={below} />
        <span className={`dragon-layer outline ${art}`} style={above} />
        <span className="dragon-level" style={{ bottom: `${gauge.percent}%` }} />
      </div>
      <div className="dragon-value">{gauge.value}</div>
      <div className="dragon-name">{gauge.name}</div>
    </div>
  );
}

/** Round to whole percent, clamped — the endpoint can report over 100. */
function pct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
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
          : `5-hour session window — ${pct(usage.fiveHour)}% used`,
    },
    {
      name: "week",
      percent: pct(usage.weekly ?? 0),
      value: usage.weekly === undefined ? "—" : `${pct(usage.weekly)}%`,
      title:
        usage.weekly === undefined
          ? "The weekly window couldn't be read"
          : `Weekly window, all models — ${pct(usage.weekly)}% used`,
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
      ? `Weekly window for ${scoped.label} — ${pct(scoped.percent)}% used`
      : "This plan has no model-scoped weekly window",
  });
  return gauges;
}

/**
 * Two dragons for one side of the composer — context and 5h on the left,
 * the two weekly windows on the right.
 */
export function DragonGauges({ channelId, side }: { channelId: string; side: "left" | "right" }) {
  const context = useRuri((s) => s.contexts[channelId]);
  const usage = useRuri((s) => s.usage);
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
