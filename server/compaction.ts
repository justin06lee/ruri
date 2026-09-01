import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Attachment, CompactionEntry, TranscriptEvent } from "../shared/protocol.js";
import type { TurnSummary } from "./archive.js";
import { storedFilePath } from "./uploads.js";

/**
 * ruri's own compaction, replacing the harness's built-in one. /compact
 * retires the live session and builds a brief from the recall notes the
 * small model already wrote (one per prompt, one per reply — compaction
 * itself calls no model, so it's instant). Each exchange in the brief ends
 * with a file path holding its complete prompt, response, tool activity, and
 * preserved attachments; the fresh session can Read it whenever a note isn't
 * detail enough, then open an image path to see its pixels. The brief rides
 * invisibly on the next prompt — the user just sees the zigzag "compacted"
 * line in the transcript.
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
  attachments: Attachment[];
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
      open = {
        turnId: event.id,
        user: event.text,
        attachments: event.attachments ?? [],
        assistant: [],
        tools: [],
        ts: event.ts,
      };
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

function attachmentLines(attachments: Attachment[]): string[] {
  const stored = attachments.flatMap((attachment) => {
    if (!attachment.url) return [];
    const marker = `[${attachment.kind} #${attachment.n}]`;
    const file = storedFilePath(attachment.url);
    return [`- ${marker} (${attachment.mediaType}): ${JSON.stringify(file)}`];
  });
  if (stored.length === 0) return [];
  const hasImage = attachments.some((attachment) => attachment.kind === "image" && attachment.url);
  return [
    "",
    "## Attachments",
    "",
    "The prompt markers above refer to these preserved files:",
    ...stored,
    ...(hasImage
      ? ["", "Open image paths with your image-viewing tool to inspect their actual pixels."]
      : []),
  ];
}

function turnFile(turn: ArchivedTurn, n: number): string {
  const parts = [
    `# Exchange ${n} — ${new Date(turn.ts).toISOString()}`,
    "",
    "## User",
    "",
    turn.user,
    ...attachmentLines(turn.attachments),
  ];
  if (turn.tools.length > 0) {
    parts.push("", "## Tools", "", ...turn.tools.map((t) => `- ${t}`));
  }
  parts.push("", "## Assistant", "", turn.assistant.join("\n\n") || "(no response)");
  return parts.join("\n") + "\n";
}

function writeTurnFiles(channelId: string, turns: ArchivedTurn[]): string[] {
  const dir = turnsDir(channelId);
  fs.mkdirSync(dir, { recursive: true });
  return turns.map((turn, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(3, "0")}.md`);
    try {
      fs.writeFileSync(file, turnFile(turn, i + 1));
    } catch {
      // the notes still carry the gist; the hook just won't resolve
    }
    return file;
  });
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
  const files = writeTurnFiles(channelId, turns);
  const entries: CompactionEntry[] = [];
  const lines = turns.map((turn, i) => {
    const file = files[i]!;
    const note = summaries[turn.turnId];
    const user = note?.user?.trim() || squash(turn.user);
    const reply = note?.reply?.trim() || squash(turn.assistant.join(" ")) || "(no reply)";
    entries.push({ user, reply });
    return `${i + 1}. user: ${user}\n   you: ${reply}\n   full: ${file}`;
  });
  const brief =
    "<compacted-history>\n" +
    'You are a fresh session continuing a conversation that was compacted. The numbered exchanges below are that conversation, oldest first, compressed to notes: "user:" is their prompt, "you:" is your reply. Treat them as your own memory — the user assumes you know all of it.\n' +
    'Each exchange ends with "full:" and a file path holding its complete prompt, response, tool activity, and preserved attachment paths. Whenever a note alone is not detailed enough to answer or act on, read that file with your file tools instead of guessing. If it names an image path, open it with your image-viewing tool to inspect the actual pixels.\n' +
    "\n" +
    lines.join("\n") +
    "\n</compacted-history>\n\n";
  return { brief, entries };
}

/**
 * Upgrade turn records written by older Ruri versions, which kept an image's
 * marker but omitted its stored path. Only an existing compaction directory
 * is refreshed: merely launching Ruri must not archive active sessions.
 */
export function refreshArchivedTurnFiles(channelId: string, events: TranscriptEvent[]): void {
  const dir = turnsDir(channelId);
  if (!fs.existsSync(dir)) return;
  const turns = groupTurns(events);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((file) => /^\d+\.md$/.test(file));
  } catch {
    return;
  }
  for (const name of files) {
    const n = Number.parseInt(name, 10);
    const turn = turns[n - 1];
    if (!turn) continue;
    const expected = turn.attachments.flatMap((attachment) =>
      attachment.url ? [JSON.stringify(storedFilePath(attachment.url))] : [],
    );
    if (expected.length === 0) continue;
    const file = path.join(dir, name);
    try {
      const current = fs.readFileSync(file, "utf8");
      if (expected.every((attachmentPath) => current.includes(attachmentPath))) continue;
      fs.writeFileSync(file, turnFile(turn, n));
    } catch {
      // best-effort migration; a future /compact gets another chance
    }
  }
}

/** Forget a removed channel's turn records entirely. */
export function removeTurnFiles(channelId: string): void {
  try {
    fs.rmSync(turnsDir(channelId), { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
