import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CompactionEntry, TranscriptEvent } from "../shared/protocol.js";
import type { TurnSummary } from "./archive.js";

/**
 * ruri's own compaction, replacing the harness's built-in one. /compact
 * retires the live session and builds a brief from the recall notes the
 * small model already wrote (one per prompt, one per reply — compaction
 * itself calls no model, so it's instant). Each exchange in the brief ends
 * with a file path holding its complete prompt, response, and tool activity;
 * the fresh session can Read it whenever a note isn't detail enough. The
 * brief rides invisibly on the next prompt — the user just sees the zigzag
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

/** A mechanical stand-in for halves the small model never summarized. */
function squash(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
}

/**
 * Write every turn's full record to disk and return the model-facing brief
 * plus its structured prompt/reply pairs (what the UI renders), or null when
 * there's nothing to compact. The brief always covers the whole transcript
 * (summaries persist), so repeated compactions stay complete.
 */
export function buildCompaction(
  channelId: string,
  events: TranscriptEvent[],
  summaries: Record<string, TurnSummary>,
): { brief: string; entries: CompactionEntry[] } | null {
  const turns = groupTurns(events);
  if (turns.length === 0) return null;
  const dir = turnsDir(channelId);
  fs.mkdirSync(dir, { recursive: true });
  const entries: CompactionEntry[] = [];
  const lines = turns.map((turn, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(3, "0")}.md`);
    try {
      fs.writeFileSync(file, turnFile(turn, i + 1));
    } catch {
      // the notes still carry the gist; the hook just won't resolve
    }
    const note = summaries[turn.turnId];
    const user = note?.user?.trim() || squash(turn.user);
    const reply = note?.reply?.trim() || squash(turn.assistant.join(" ")) || "(no reply)";
    entries.push({ user, reply });
    return `${i + 1}. user: ${user}\n   you: ${reply}\n   full: ${file}`;
  });
  const brief =
    "<compacted-history>\n" +
    'You are a fresh session continuing a conversation that was compacted. The numbered exchanges below are that conversation, oldest first, compressed to notes: "user:" is their prompt, "you:" is your reply. Treat them as your own memory — the user assumes you know all of it.\n' +
    'Each exchange ends with "full:" and a file path holding its complete prompt, response, and tool activity. Whenever a note alone is not detailed enough to answer or act on, read that file with your file tools instead of guessing.\n' +
    "\n" +
    lines.join("\n") +
    "\n</compacted-history>\n\n";
  return { brief, entries };
}

/** Forget a removed channel's turn records entirely. */
export function removeTurnFiles(channelId: string): void {
  try {
    fs.rmSync(turnsDir(channelId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
