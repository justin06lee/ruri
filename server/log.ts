/**
 * The one place a swallowed error goes. Most of ruri's stores are
 * best-effort — a save that fails must not take the app down — but a
 * failure nobody hears of is a bug nobody can find. One line on stderr,
 * every time, with what was being attempted.
 */

/** An error's message, whatever was thrown. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Node's errno code, when the error carries one. */
export function errorCode(err: unknown): string | undefined {
  return err instanceof Error && typeof (err as NodeJS.ErrnoException).code === "string"
    ? (err as NodeJS.ErrnoException).code
    : undefined;
}

/** True for the one failure that is usually expected: the file is not there. */
export function isMissing(err: unknown): boolean {
  return errorCode(err) === "ENOENT";
}

/** Say what went wrong, where, and what was being tried — then carry on. */
export function warn(scope: string, err: unknown, note?: string): void {
  const stamp = new Date().toISOString();
  const what = note ? `${note}: ` : "";
  process.stderr.write(`${stamp} ruri ${scope}: ${what}${errorMessage(err)}\n`);
}
