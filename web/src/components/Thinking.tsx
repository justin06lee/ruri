/**
 * The working indicator: the macOS activity indicator (twelve spokes), drawn in CSS
 * (.spinner) so it follows the theme ink, stepped by lib/beat.ts.
 *
 * Beside it, the working line — what a running turn has done so far. A
 * turn is otherwise a closed box between the prompt and the result, which
 * is fine for the minute it usually takes and no help at all on the hour
 * it sometimes takes. The clock, the token count and the gap since anything
 * last came back are the three numbers that tell a deep build from a dead
 * connection.
 */
import type { TurnProgress } from "../../../shared/protocol";
import { beat, useNow } from "../lib/beat";

/** Turned by the ring's clock (lib/beat.ts), not a CSS animation. */
export function Spinner() {
  return <span className="spinner" ref={beat("spin")} aria-hidden />;
}

/* ── the working line ────────────────────────────────────────────── */

/** Nothing back for this long is worth saying out loud — under it, a gap
 *  is just a tool running, and a warning every time one did would teach
 *  the user to ignore the line. */
const QUIET_MS = 90_000;

/** 42s, 3m 08s, 1h 14m — as long as it has been, in as few characters. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** 309, 1.3k, 47k — the shape the CLI's own counter uses. */
function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

export function WorkingLine({ turn, effort }: { turn: TurnProgress; effort: string }) {
  // one tick a second: the clock has to move, and nothing else on screen
  // is going to move it while a turn sits in a long tool call — while ruri
  // can be seen, that is; out of sight it waits, then catches up
  const now = useNow(1000);

  const quiet = now - turn.at;
  return (
    <div className="working-line">
      <span className="working-word">Working…</span>
      <span className="working-stats">{elapsed(now - turn.startedAt)}</span>
      <details className="working-details">
        <summary>Details</summary>
        <span className="working-stats">
          {turn.tokens > 0 && `${tokens(turn.tokens)} tokens · `}
          {effort} effort
        </span>
      </details>
      {quiet > QUIET_MS && <span className="working-quiet">No update for {elapsed(quiet)}</span>}
    </div>
  );
}
