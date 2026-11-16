/**
 * How a running script says whether it is getting anywhere: it is
 * printing, or it has been quiet for so long. Read off when it last
 * printed (its card's `printedAt`, kept by the server while it runs), by
 * its card in the chat and by its page.
 */

/** How long, in a card's words: "42s", "3m 05s". */
export function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Under this, a script that printed is still printing: its card hears of
 *  new output every five seconds at most, a couple after it came. */
export const QUIET_MS = 12_000;

/**
 * A running script, in a word or three: "printing", "quiet 3m 05s", or
 * "nothing printed yet" — nothing at all in its first moments, when not
 * having printed says nothing.
 */
export function printing(
  printedAt: number | undefined,
  startedAt: number,
  now: number,
  quiet = "quiet",
): string | undefined {
  if (!printedAt) return now - startedAt < QUIET_MS ? undefined : "nothing printed yet";
  const silent = now - printedAt;
  return silent < QUIET_MS ? "printing" : `${quiet} ${span(silent)}`;
}

/** A time of day to the second, for a stretch of output: "10:42:03". */
export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
