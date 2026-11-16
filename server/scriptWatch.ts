/**
 * What a background script has printed, and when.
 *
 * A script left running is a question the user keeps asking: is it getting
 * anywhere, or is it stuck? What it prints is the only answer there is —
 * so while one runs, ruri looks at the file its output goes to every
 * couple of seconds and keeps two things:
 *
 *  - its newest line, and when it last printed at all, told to whoever is
 *    watching (the session, which puts them on the script's card — so the
 *    chat shows how far along it is, and how long it has been quiet,
 *    without anyone opening anything);
 *  - marks: how much of the file had been printed by when. The file holds
 *    no times of its own, and a page that shows the output in the
 *    stretches it arrived in, each with its time, is what makes "nothing
 *    for four minutes" visible (server/scripts.ts).
 *
 * The marks are kept in memory for as long as ruri runs, the script's end
 * included; a relaunch forgets them, and its page shows the output whole.
 */
import * as fs from "node:fs";

/** Everything up to `offset` (bytes into the file) had been printed by `ts`. */
export interface OutputMark {
  offset: number;
  ts: number;
}

/** How often a running script's output is looked at. */
const LOOK_MS = 2_000;
/** How often, at most, the watcher is told it printed: each telling is the
 *  script's card sent to every window, and a script may print all day. */
const TELL_MS = 5_000;

/** RURI_SCRIPT_LOOK_MS and RURI_SCRIPT_TELL_MS shorten the two — a test's,
 *  which has no seconds to spend. */
function wait(name: string, usual: number): number {
  const said = Number(process.env[name]);
  return Number.isFinite(said) && said > 0 ? said : usual;
}
/** How many marks one script keeps, and how many scripts keep theirs. */
const MARKS_KEPT = 600;
const FILES_KEPT = 200;
/** How much of what is new is read for its newest line. */
const READ_BYTES = 16 * 1024;

const marks = new Map<string, OutputMark[]>();

/** The marks kept for a script's output file, oldest first. */
export function outputMarks(file: string): OutputMark[] {
  return marks.get(file) ?? [];
}

/** Colour and cursor codes, which a page of text has no use for. */
// eslint-disable-next-line no-control-regex -- ESC and BEL are the point: this strips terminal codes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

/**
 * Output as a terminal would leave it on screen: no colour codes, and a
 * line redrawn in place (a progress bar's carriage returns) as its last
 * drawing rather than every one it went through.
 */
export function shown(text: string): string {
  return text
    .replace(ANSI, "")
    .split("\n")
    .map((line) => {
      const drawn = line.replace(/\r+$/, "");
      return drawn.slice(drawn.lastIndexOf("\r") + 1);
    })
    .join("\n");
}

/** The newest line with anything on it, cut to fit a card. */
export function lastLine(text: string, max = 200): string {
  const lines = shown(text).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line) return line.length > max ? `${line.slice(0, max - 1)}…` : line;
  }
  return "";
}

/**
 * Watch a running script's output file. `printed` hears its newest line
 * and when it came, each time it has printed more (at most every
 * TELL_MS). Returns the stop — called when the script ends, it takes one
 * last look, so the last thing printed is marked and told.
 */
export function watchScript(
  file: string,
  printed: (line: string, at: number) => void,
  every: { lookMs?: number; tellMs?: number } = {},
): () => void {
  const tellMs = every.tellMs ?? wait("RURI_SCRIPT_TELL_MS", TELL_MS);
  const kept = marks.get(file) ?? [];
  // the newest watch is the one worth keeping, when there are too many
  marks.delete(file);
  marks.set(file, kept);
  while (marks.size > FILES_KEPT) marks.delete(marks.keys().next().value!);

  /** How much of the file has been looked at, and how much of it marked. */
  let seen = kept.at(-1)?.offset ?? 0;
  let marked = seen;
  let waiting: { line: string; at: number } | null = null;
  let toldAt = 0;

  const look = (last: boolean): void => {
    const now = Date.now();
    let fd: number | undefined;
    try {
      fd = fs.openSync(file, "r");
      const size = fs.fstatSync(fd).size;
      if (size < seen) {
        // written afresh: what was marked is of a file that is gone
        kept.length = 0;
        seen = 0;
        marked = 0;
      }
      if (size > seen) {
        // from the last whole line on, so a line that came in two halves
        // is read as the one line it is
        const from = Math.max(marked, size - READ_BYTES);
        const buffer = Buffer.alloc(size - from);
        fs.readSync(fd, buffer, 0, buffer.length, from);
        // a mark ends on a whole line (or a redrawn one), so no stretch of
        // output is ever cut through a line — or through a character
        const end = Math.max(buffer.lastIndexOf(0x0a), buffer.lastIndexOf(0x0d));
        const whole = last ? size : end === -1 ? marked : from + end + 1;
        if (whole > marked) {
          kept.push({ offset: whole, ts: now });
          if (kept.length > MARKS_KEPT) kept.shift();
          marked = whole;
        }
        seen = size;
        const line = lastLine(buffer.toString("utf8"));
        if (line) waiting = { line, at: now };
      }
    } catch {
      // not written yet, or cleared away with its session: nothing to say
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (waiting && (last || now - toldAt >= tellMs)) {
      const { line, at } = waiting;
      waiting = null;
      toldAt = now;
      printed(line, at);
    }
  };

  // the first look is a look's wait away, never inside this call: whoever
  // is watching has the stop in hand before they first hear anything
  const timer = setInterval(() => look(false), every.lookMs ?? wait("RURI_SCRIPT_LOOK_MS", LOOK_MS));
  timer.unref();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    look(true);
  };
}
