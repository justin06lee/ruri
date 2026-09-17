import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "./configDir.js";
import type { Attachment, CompactionDigest, CompactionEntry, TranscriptEvent } from "../shared/protocol.js";
import type { TurnSummary } from "./archive.js";
import { storedFilePath } from "./uploads.js";
import { isMissing, warn } from "./log.js";

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
  return configPath("turns", channelId);
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
  // records past the end are from exchanges that are gone (a rewind, the
  // history's cap) — numbered as they were, and naming nothing now
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^\d+\.md$/.test(name) && Number.parseInt(name, 10) > turns.length) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch (err) {
    if (!isMissing(err)) warn("compaction", err, "writeTurnFiles");
    // stale records only cost disk
  }
  return turns.map((turn, i) => {
    const file = path.join(dir, `${String(i + 1).padStart(3, "0")}.md`);
    try {
      fs.writeFileSync(file, turnFile(turn, i + 1));
    } catch (err) {
      warn("compaction", err, "writeTurnFiles");
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

/** An exchange's two notes: the small model's, or a cut of the text itself
 *  where it wrote none. */
function notesOf(turn: ArchivedTurn, summaries: Record<string, TurnSummary>): { user: string; reply: string } {
  const note = summaries[turn.turnId];
  return {
    user: note?.user?.trim() || squash(turn.user),
    reply: note?.reply?.trim() || squash(turn.assistant.join(" ")) || "(no reply)",
  };
}

/* ── the digest ──────────────────────────────────────────────────── */

/**
 * How many exchanges a brief lists one by one.
 *
 * A brief used to list every exchange the conversation had ever had, so
 * each compaction handed the fresh session a longer one than the last — a
 * chat a hundred-odd exchanges long opened every new session on over ten
 * thousand tokens of notes, most of them about work long finished. Past
 * this many, the oldest are folded into the digest: one condensed memory
 * the small model keeps, which grows by merging rather than by lines. What
 * a fold leaves out is not gone — every exchange's full record stays on
 * disk, and the digest's head says where.
 */
export const BRIEF_LISTED = Number(process.env["RURI_BRIEF_LISTED"]) || 40;
/** What a fold brings the list back down to — so a fold runs every ten or
 *  so exchanges, not after every one. */
const LISTED_AFTER_FOLD = Math.floor(BRIEF_LISTED * 0.75);
/** At most this many exchanges go into one fold; a long chat's first
 *  catch-up takes a few. */
const FOLD_MAX = 40;

/** A long conversation's oldest exchanges, condensed; `through` is the last
 *  of them, by its turn id. */
export interface Digest {
  text: string;
  through: string;
}

/** Where the digest ends: the index just past its last exchange — 0 when
 *  there is none, or when the history's cap has since dropped that exchange
 *  (the cap drops the oldest, so everything left is newer than it). */
function digestEnd(turnIds: string[], digest: Digest | undefined): number {
  return digest ? turnIds.indexOf(digest.through) + 1 : 0;
}

/** The oldest exchanges past the cap, due to be folded into the digest —
 *  none while the list is within it. */
export function dueForDigest(turnIds: string[], digest: Digest | undefined): string[] {
  const start = digestEnd(turnIds, digest);
  if (turnIds.length - start <= BRIEF_LISTED) return [];
  return turnIds.slice(start, Math.min(turnIds.length - LISTED_AFTER_FOLD, start + FOLD_MAX));
}

/** What the folder reads and writes — the archive, in the app. */
export interface DigestStore {
  turnIds(channelId: string): string[];
  allEvents(channelId: string): TranscriptEvent[];
  summaries(channelId: string): Record<string, TurnSummary>;
  digest(channelId: string): Digest | undefined;
  setDigest(channelId: string, digest: Digest): void;
}

/** Folds exchanges into a memory — the small model, in the app. */
export type FoldDigest = (
  memory: string,
  exchanges: Array<{ n: number; user: string; reply: string }>,
) => Promise<string>;

/**
 * Keeps each conversation's digest caught up, in the background. Asked after
 * every reply's note lands and whenever a chat is opened, it folds whatever
 * is past the cap, one fold at a time per chat. The check is cheap — the
 * history's outline, cached — and only a fold that is due reads the history
 * itself. A compaction never waits on it: it takes the digest as it stands,
 * which after the last reply is already caught up.
 */
export class DigestFolder {
  private readonly running = new Set<string>();

  constructor(
    private readonly store: DigestStore,
    private readonly fold: FoldDigest,
  ) {}

  /** Resolves once nothing is due, or the model gave nothing usable. */
  async run(channelId: string): Promise<void> {
    if (this.running.has(channelId)) return;
    if (dueForDigest(this.store.turnIds(channelId), this.store.digest(channelId)).length === 0) return;
    this.running.add(channelId);
    try {
      // a long chat's first catch-up takes a few folds; a stuck one stops
      for (let round = 0; round < 8; round++) {
        const digest = this.store.digest(channelId);
        const due = dueForDigest(this.store.turnIds(channelId), digest);
        if (due.length === 0) return;
        const wanted = new Set(due);
        const summaries = this.store.summaries(channelId);
        const exchanges = groupTurns(this.store.allEvents(channelId)).flatMap((turn, i) =>
          wanted.has(turn.turnId) ? [{ n: i + 1, ...notesOf(turn, summaries) }] : [],
        );
        const text = await this.fold(digest?.text ?? "", exchanges);
        if (!text) return;
        const through = due[due.length - 1]!;
        // a rewind while the model wrote may have taken what it folded, or
        // the digest it was folding into
        if (!this.store.turnIds(channelId).includes(through)) return;
        if (this.store.digest(channelId)?.through !== digest?.through) return;
        this.store.setDigest(channelId, { text, through });
      }
    } catch (err) {
      warn("compaction", err, "run");
      // folded next time: a digest that lags only means a longer brief
    } finally {
      this.running.delete(channelId);
    }
  }
}

const BRIEF_INTRO =
  'You are a fresh session continuing a conversation that was compacted. The numbered exchanges below are that conversation, oldest first, compressed to notes: "user:" is their prompt, "you:" is your reply. Treat them as your own memory — the user assumes you know all of it.\n' +
  'Each exchange ends with "full:" and a file path holding its complete prompt, response, tool activity, and preserved attachment paths. Whenever a note alone is not detailed enough to answer or act on, read that file with your file tools instead of guessing. If it names an image path, open it with your image-viewing tool to inspect the actual pixels.\n';

const DIGEST_INTRO =
  "The oldest exchanges come first, condensed together into one memory (<condensed>); the ones after it are listed one by one.\n";

/**
 * Write every turn's full record to disk and return the model-facing brief
 * plus its structured prompt/reply pairs (what the UI renders), or null when
 * there's nothing to compact. The brief covers the whole conversation: what
 * the digest has folded, condensed at its head, and every exchange after
 * that listed by its notes — at most BRIEF_LISTED of them, give or take a
 * fold still in flight. Listed exchanges keep their numbers in the whole
 * conversation, so each one's number is its record's file.
 */
export function buildCompaction(
  channelId: string,
  events: TranscriptEvent[],
  summaries: Record<string, TurnSummary>,
  digest?: Digest,
): { brief: string; entries: CompactionEntry[]; digest?: CompactionDigest } | null {
  const turns = groupTurns(events);
  if (turns.length === 0) return null;
  const files = writeTurnFiles(channelId, turns);
  const end = digestEnd(
    turns.map((turn) => turn.turnId),
    digest,
  );
  const entries: CompactionEntry[] = [];
  const lines = turns.slice(end).map((turn, k) => {
    const i = end + k;
    const { user, reply } = notesOf(turn, summaries);
    entries.push({ user, reply, n: i + 1 });
    return `${i + 1}. user: ${user}\n   you: ${reply}\n   full: ${files[i]!}`;
  });
  const condensed = digest
    ? "<condensed>\n" +
      (end > 0
        ? `Exchanges 1–${end}, condensed. Their full records are files 001.md to ${String(end).padStart(3, "0")}.md in ${path.dirname(files[0]!)} — read one whenever this memory is not detail enough.\n\n`
        : "The conversation's earliest exchanges, condensed (their full records are no longer kept).\n\n") +
      digest.text.trim() +
      "\n</condensed>\n\n"
    : "";
  const brief =
    "<compacted-history>\n" +
    BRIEF_INTRO +
    (digest ? DIGEST_INTRO : "") +
    "\n" +
    condensed +
    lines.join("\n") +
    "\n</compacted-history>\n\n";
  return { brief, entries, ...(digest ? { digest: { text: digest.text.trim(), through: end } } : {}) };
}

/**
 * Upgrade turn records written by older Ruri versions, which kept an image's
 * marker but omitted its stored path. Only an existing compaction directory
 * is refreshed: merely launching Ruri must not archive active sessions. It
 * is a one-time repair, so a directory it has been through is marked and
 * skipped from then on — the events are only read when it has work to do,
 * and every launch used to read every transcript here to find out.
 */
const REFRESHED = ".refreshed";

export function refreshArchivedTurnFiles(channelId: string, events: () => TranscriptEvent[]): void {
  const dir = turnsDir(channelId);
  if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, REFRESHED))) return;
  const turns = groupTurns(events());
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((file) => /^\d+\.md$/.test(file));
  } catch (err) {
    if (!isMissing(err)) warn("compaction", err, "refreshArchivedTurnFiles");
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
    } catch (err) {
      if (!isMissing(err)) warn("compaction", err, "refreshArchivedTurnFiles");
      // best-effort migration; a future /compact gets another chance
    }
  }
  try {
    fs.writeFileSync(path.join(dir, REFRESHED), "");
  } catch (err) {
    warn("compaction", err, "refreshArchivedTurnFiles");
    // it only means the check runs again next launch
  }
}

/** Forget a removed channel's turn records entirely. */
export function removeTurnFiles(channelId: string): void {
  try {
    fs.rmSync(turnsDir(channelId), { recursive: true, force: true });
  } catch (err) {
    warn("compaction", err, "removeTurnFiles");
    // best-effort
  }
}
