/**
 * A script's page: a shell command the model left running in the
 * background, as the agents page opens it — the command, and what it has
 * printed so far. The printing is read from the file the harness writes it
 * to (its card's `output`), afresh each time the page asks; the page asks
 * again every couple of seconds for as long as the script runs.
 */
import * as fs from "node:fs";
import type { SubagentState, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
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

/** The last TAIL_BYTES of a file, from a whole line on — or null when it
 *  cannot be read (not written yet, or cleared away with the session). */
function tail(file: string): { text: string; cut: boolean } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    return start > 0 ? { text: text.slice(text.indexOf("\n") + 1), cut: true } : { text, cut: false };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Text as a code block that nothing inside it can close. */
function fenced(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\n+$/, "")}\n${fence}`;
}

/**
 * The page of the script under `key` — its command, then its output — or
 * null when `key` is not a script (an agent's log is read as usual).
 */
export function scriptLog(ctx: ServerContext, chatId: string, key: string): TranscriptEvent[] | null {
  const script = findScript(ctx, chatId, key);
  if (!script) return null;
  const command = ctx.secrets.redact(script.prompt ?? script.description);
  const read = script.output && SCRIPT_OUTPUT.test(script.output) ? tail(script.output) : null;
  const output = read?.text.trim()
    ? `${read.cut ? "*…the end of it:*\n\n" : ""}${fenced(ctx.secrets.redact(read.text))}`
    : script.status === "running"
      ? "*nothing printed yet*"
      : "*it printed nothing that was kept*";
  return [
    { kind: "user", id: `${key}:command`, text: fenced(command, "sh"), ts: script.startedAt },
    { kind: "assistant", id: `${key}:output`, text: output, ts: script.endedAt ?? Date.now() },
  ];
}
