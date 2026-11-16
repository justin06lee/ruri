/**
 * A script's page: a shell command the model left running in the
 * background, as the agents page opens it — the command, and what it has
 * printed so far, in the stretches it arrived in. The printing is read
 * from the file the harness writes it to (its card's `output`), afresh
 * each time the page asks; the page asks again every couple of seconds
 * for as long as the script runs.
 */
import * as fs from "node:fs";
import type { SubagentState, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { type OutputMark, outputMarks, shown } from "./scriptWatch.js";
import { SCRIPT_OUTPUT } from "./sessions.js";

/** How much of the end of a script's output its page shows. */
const TAIL_BYTES = 48 * 1024;

/** The script under `key` in a chat: left running by the chat's own turn,
 *  or by one of the agents it started (then its card is in that log). */
function findScript(ctx: ServerContext, chatId: string, key: string): SubagentState | undefined {
  const cards = ctx.archive
    .events(chatId)
    .flatMap((event) => (event.kind === "tool" && event.agent ? [event.agent] : []));
  const top = cards.find((agent) => agent.key === key);
  if (top) return top.script ? top : undefined;
  for (const agent of cards) {
    if (agent.script) continue;
    const found = ctx.agentLogs
      .read(chatId, agent.key)
      .find((e) => e.kind === "tool" && e.agent?.key === key);
    if (found?.kind === "tool" && found.agent?.script) return found.agent;
  }
  return undefined;
}

/** The last TAIL_BYTES of a file, from a whole line on, and where in the
 *  file that begins — or null when it cannot be read (not written yet, or
 *  cleared away with the session). */
function tail(file: string): { bytes: Buffer; from: number; cut: boolean } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    if (start === 0) return { bytes: buffer, from: 0, cut: false };
    const line = buffer.indexOf(0x0a) + 1;
    return { bytes: buffer.subarray(line), from: start + line, cut: true };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Marks closer together than this are one stretch of printing; a gap of
 *  more begins another, with its own time. A few looks of the watcher. */
const PAUSE_MS = 7_000;

/**
 * The output in the stretches it arrived in: each run of printing with no
 * pause in it is one piece, with when it began (`ts`) and when its newest
 * line came (`until`). Both are absent when nothing is known of when (no
 * marks: the script ran before this ruri did, or ended before anything
 * looked).
 */
export function stretches(
  read: { bytes: Buffer; from: number },
  marks: OutputMark[],
): Array<{ from: number; text: string; ts?: number; until?: number }> {
  const end = read.from + read.bytes.length;
  const text = (from: number, to: number): string =>
    shown(read.bytes.subarray(from - read.from, to - read.from).toString("utf8"));
  const inside = marks.filter((mark) => mark.offset > read.from && mark.offset <= end);
  if (inside.length === 0) return [{ from: read.from, text: text(read.from, end) }];
  const pieces: Array<{ from: number; to: number; ts: number; until: number }> = [];
  for (const mark of inside) {
    const last = pieces.at(-1);
    if (last && mark.ts - last.until < PAUSE_MS) {
      last.to = mark.offset;
      last.until = mark.ts;
    } else {
      pieces.push({ from: last?.to ?? read.from, to: mark.offset, ts: mark.ts, until: mark.ts });
    }
  }
  // what came since the last look, or a line still being written
  pieces.at(-1)!.to = end;
  return pieces.map((piece) => ({
    from: piece.from,
    text: text(piece.from, piece.to),
    ts: piece.ts,
    until: piece.until,
  }));
}

/** "42s", "3m 05s". */
function howLong(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** Text as a code block that nothing inside it can close. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/**
 * The page of the script under `key` — its command, then what it printed —
 * or null when `key` is not a script (an agent's log is read as usual).
 *
 * What it printed comes as a conversation nobody can answer: one message
 * for each stretch of printing, timed by when it began (scriptWatch.ts
 * keeps the times while the script runs), and between two of them a line
 * saying how long it printed nothing — so a script that went quiet shows
 * as exactly that. Those messages' ids hold ":out:" — how the page knows
 * their times are real. With no times known, the output is one message,
 * as it always was.
 */
export function scriptLog(ctx: ServerContext, chatId: string, key: string): TranscriptEvent[] | null {
  const script = findScript(ctx, chatId, key);
  if (!script) return null;
  const command = ctx.secrets.redact(script.prompt ?? script.description);
  const asked: TranscriptEvent = {
    kind: "user",
    id: `${key}:command`,
    text: fenced(command, "sh"),
    ts: script.startedAt,
  };
  const file = script.output && SCRIPT_OUTPUT.test(script.output) ? script.output : undefined;
  const read = file ? tail(file) : null;
  const pieces = read ? stretches(read, outputMarks(file!)).filter((piece) => piece.text.trim()) : [];
  if (pieces.length === 0) {
    const none = script.status === "running" ? "*nothing printed yet*" : "*it printed nothing that was kept*";
    return [asked, { kind: "assistant", id: `${key}:output`, text: none, ts: script.endedAt ?? Date.now() }];
  }
  return [
    asked,
    ...pieces.flatMap((piece, i): TranscriptEvent[] => {
      const lead = i === 0 && read?.cut ? "*…the end of it:*\n\n" : "";
      const before = pieces[i - 1];
      const quiet = piece.ts !== undefined && before?.until !== undefined ? piece.ts - before.until : 0;
      return [
        ...(quiet >= PAUSE_MS
          ? [
              {
                kind: "info" as const,
                id: `${key}:quiet:${piece.from}`,
                text: `printed nothing for ${howLong(quiet)}`,
                ts: piece.ts!,
              },
            ]
          : []),
        {
          kind: "assistant",
          id: piece.ts === undefined ? `${key}:output` : `${key}:out:${piece.from}`,
          text: `${lead}${fenced(ctx.secrets.redact(piece.text))}`,
          ts: piece.ts ?? script.endedAt ?? Date.now(),
        },
      ];
    }),
  ];
}
