/**
 * A test, build or lint run's output, cut down before a model reads it.
 *
 * A tool's result stays in the chat's history and is re-read on every model
 * call after it until the chat compacts, so a few thousand lines of passing
 * tests are paid for many times over (docs/token-efficiency.md, Q4). A
 * command that starts one of these runs is wrapped: its output goes to a
 * file, and the model gets all of it when it is short; when it is long, it
 * gets the lines that look like failures, the tail, and where the whole of it
 * is. The run's exit status is kept.
 */

/** The runs whose output is long and mostly passing lines. */
const NOISY =
  /^(?:bun (?:test|run (?:test|build|lint|typecheck|check))|(?:npm|pnpm|yarn) (?:test|run (?:test|build|lint|typecheck))|(?:npx |bunx )?(?:vitest|jest|tsc|eslint|playwright test)|(?:python3? -m )?pytest|go (?:test|build|vet)|cargo (?:test|build|clippy)|swift (?:test|build)|xcodebuild|make (?:test|check|lint|build|typecheck|tenet)|sh scripts\/tenet\.sh)(?:\s|$)/;

/** Output this short reaches the model whole. */
export const SHOW_ALL_LINES = 120;

/** What would make wrapping wrong: output already piped or redirected, a
 *  heredoc, a run sent to the background, several lines of script. */
const HANDS_OFF = /[|<>`\n]|\$\(|&\s*$|;/;

/** The command to run instead, or undefined to leave it be. */
export function trimCommand(input: { command?: unknown; run_in_background?: unknown }): string | undefined {
  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command || input.run_in_background === true || HANDS_OFF.test(command)) return undefined;
  // `cd somewhere && bun test` is the same run
  const steps = command.split("&&").map((step) => step.trim());
  if (!steps.some((step) => NOISY.test(step))) return undefined;
  return [
    'ruri_out=$(mktemp "${TMPDIR:-/tmp}/ruri-out.XXXXXX")',
    `{ ${command}; } >"$ruri_out" 2>&1`,
    "ruri_status=$?",
    `ruri_lines=$(wc -l <"$ruri_out" | tr -d ' ')`,
    `if [ "$ruri_lines" -le ${SHOW_ALL_LINES} ]; then cat "$ruri_out"; else` +
      ` grep -n -i -E -m 40 'fail|error|✗|✖|panic|exception' "$ruri_out";` +
      ` echo "… the last 60 of $ruri_lines lines:"; tail -n 60 "$ruri_out";` +
      ` echo "[ruri cut this output down; all of it is in $ruri_out]"; fi`,
    '(exit "$ruri_status")',
  ].join("; ");
}
