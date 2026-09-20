/**
 * The numbers, written the way ruri writes them.
 *
 * Shared by the projects page and the statistics page, which were one page
 * until they were two: the same run of turns must read the same in a card's
 * footer and in a table's row, or the two pages look like they disagree.
 */
import type { Totals } from "../../../shared/protocol";

/** "1.3M", "84k", "512" — room for one number, not a locale's worth. */
export function shortCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

/** "$5474", "$26.3", "$0.92" — three figures of it, whatever the size. */
export function money(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`;
  if (usd >= 10) return `$${usd.toFixed(1)}`;
  return `$${usd.toFixed(2)}`;
}

/** "3h 12m" for a run of turns' wall time. */
export function span(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${h}h ${rest}m` : `${h}h`;
}

export const NONE: Totals = { tokens: 0, costUsd: 0, turns: 0, ms: 0 };

export function sum(parts: Totals[]): Totals {
  return parts.reduce(
    (a, b) => ({
      tokens: a.tokens + b.tokens,
      costUsd: a.costUsd + b.costUsd,
      turns: a.turns + b.turns,
      ms: a.ms + b.ms,
    }),
    NONE,
  );
}
