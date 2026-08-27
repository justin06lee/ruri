import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * ruri's own compaction, replacing the harness's built-in one. /compact
 * retires the live session and builds a brief from the turn summaries the
 * small model already wrote (one per finished turn — compaction itself calls
 * no model, so it's instant). Each entry in the brief ends with a file path
 * holding that exchange's complete prompt, response, and tool activity; the
 * fresh session can Read it whenever a summary isn't detail enough. The
 * brief rides invisibly on the next prompt — the user just sees the jagged
 * "compacted" line in the transcript.
 */

function turnsDir(channelId: string): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "turns",
    channelId,
  );
}

interface ArchivedTurn {
  turnId: string;
  user: string;
  assistant: string[];
  tools: string[];
  ts: number;
}

/** Group the flat event stream into prompt→result turns; compaction marks
 *  and pre-prompt stragglers don't make turns. */
function groupTurns(events: TranscriptEvent[]): ArchivedTurn[] {
  const turns: ArchivedTurn[] = [];
  let open: ArchivedTurn | null = null;
  for (const event of events) {
    if (event.kind === "user") {
      open = { turnId: event.id, user: event.text, assistant: [], tools: [], ts: event.ts };
      turns.push(open);
    } else if (!open) {
      continue;
    } else if (event.kind === "assistant") {
      open.assistant.push(event.text);
    } else if (event.kind === "tool") {
      open.tools.push(`${event.name} — ${event.summary}`);
    } else if (event.kind === "compaction") {
      open = null;
    }
  }
  return turns;
}

function turnFile(turn: ArchivedTurn, n: number): string {
  const parts = [
    `# Exchange ${n} — ${new Date(turn.ts).toISOString()}`,
    "",
    "## User",
    "",
    turn.user,
  ];
  if (turn.tools.length > 0) {
    parts.push("", "## Tools", "", ...turn.tools.map((t) => `- ${t}`));
  }
  parts.push("", "## Assistant", "", turn.assistant.join("\n\n") || "(no response)");
  return parts.join("\n") + "\n";
}

/** A mechanical stand-in for turns the small model never summarized. */
function fallbackSummary(turn: ArchivedTurn): string {
  const user = turn.user.replace(/\s+/g, " ").trim();
  return user.length > 160 ? `${user.slice(0, 157)}…` : user;
}

/**
 * Write every turn's full record to disk and return the model-facing brief,
 * or null when there's nothing to compact. The brief always covers the whole
 * transcript (summaries persist), so repeated compactions stay complete.
 */
export function buildCompaction(
  channelId: string,
  events: TranscriptEvent[],
  summaries: Record<string, string>,
): string | null {
  const turns = groupTurns(events);
  if (turns.length === 0) return null;
  const dir = turnsDir(channelId);
  fs.mkdirSync(dir, { recursive: true });
  const entries = turns.map((turn, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(3, "0")}.md`);
    try {
      fs.writeFileSync(file, turnFile(turn, i + 1));
    } catch {
      // the summary still carries the gist; the hook just won't resolve
    }
    const summary = summaries[turn.turnId]?.trim() || fallbackSummary(turn);
    return `${i + 1}. ${summary}\n   full: ${file}`;
  });
  return (
    "<compacted-history>\n" +
    "This session restarted fresh after a compaction. Everything that happened before is summarized below, oldest first — treat it as your memory of the conversation; the user assumes you know all of it.\n" +
    'Each entry ends with "full:" and a file path holding that exchange\'s complete prompt, response, and tool activity. Whenever a summary alone is not detailed enough to answer or act on, read that file with your file tools instead of guessing.\n' +
    "\n" +
    entries.join("\n") +
    "\n</compacted-history>\n\n"
  );
}

/** Forget a removed channel's turn records entirely. */
export function removeTurnFiles(channelId: string): void {
  try {
    fs.rmSync(turnsDir(channelId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
