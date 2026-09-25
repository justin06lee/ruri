import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "./configDir.js";
import type { Attachment, CompactionDigest, CompactionEntry, TranscriptEvent } from "../shared/protocol.js";
import type { TurnSummary } from "./archive.js";
import { storedFilePath } from "./uploads.js";
import { isMissing, warn } from "./log.js";
import { projectRelative, rank, rankExchanges, type Exchange } from "./recall.js";

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
 *
 * What a fresh session needs is not every exchange at the same weight, so
 * the brief isn't that. It opens with where things stand as git and the
 * transcript record them — the branch, what's uncommitted, what's
 * unmerged, the files this conversation changed, what the last reply
 * offered to do next — facts rather than anyone's recollection. The last
 * few exchanges come at length, the user's words as they wrote them (what
 * "this" and "that" in the next prompt point at). Older ones are notes, the
 * oldest the digest. And when the brief goes out, it knows the prompt it
 * rides with: exchanges and memory lines that share its words are added at
 * length (`relevantBlock`), the long-folded ones included.
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
  /** Files its tools changed, as the transcript's diffs name them. */
  files: string[];
  ts: number;
}

/** Group the flat event stream into prompt→result turns; compaction marks
 *  and pre-prompt stragglers don't make turns. `projectName` turns the
 *  diffs' "<project>/<path>" back into paths relative to the project. */
function groupTurns(events: TranscriptEvent[], projectName?: string): ArchivedTurn[] {
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
        files: [],
        ts: event.ts,
      };
      turns.push(open);
    } else if (!open) {
      continue;
    } else if (event.kind === "assistant") {
      open.assistant.push(event.text);
    } else if (event.kind === "tool") {
      open.tools.push(`${event.name} — ${event.summary}`);
      const file = event.diff?.path && projectRelative(event.diff.path, projectName);
      if (file && !open.files.includes(file)) open.files.push(file);
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
      if (/^\d+\.md$/.test(name) && Number.parseInt(name, 10) > turns.length)
        fs.rmSync(path.join(dir, name), { force: true });
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
function notesOf(
  turn: ArchivedTurn,
  summaries: Record<string, TurnSummary>,
): { user: string; reply: string } {
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
  'You are a fresh session continuing a conversation that was compacted. The numbered exchanges below are that conversation, oldest first: "user:" is their prompt, "you:" is your reply. Treat them as your own memory — the user assumes you know all of it.\n' +
  "It opens with <state>: where things stand, read from git and the transcript's own record as the conversation was compacted — facts, not recollection; where a note disagrees with it, the state is right. The last exchanges (<recent>) come at length, with the user's words exactly as they wrote them; older ones are compressed to notes.\n" +
  'Each exchange ends with "full:" and a file path holding its complete prompt, response, tool activity, and preserved attachment paths. Whenever a note alone is not detailed enough to answer or act on, read that file with your file tools instead of guessing. If it names an image path, open it with your image-viewing tool to inspect the actual pixels.\n';

const DIGEST_INTRO =
  "The oldest exchanges come first, condensed together into one memory (<condensed>); the ones after it are listed one by one.\n";

/** How many of the last exchanges the brief gives at length. */
export const BRIEF_RECENT = 3;
/** How much of each: the very last the most. */
const RECENT_USER_CHARS = [4000, 2000, 2000];
const RECENT_REPLY_CHARS = [3000, 1500, 1500];

/** What the brief is told beyond the transcript: git's account of the
 *  repo, and what git says about the branches a line names. */
export interface BriefContext {
  git?: string[];
  facts?: (text: string) => string;
  /** The project's name, which the transcript's paths start with. */
  projectName?: string;
}

/** A text cut to `max`, from the middle: the opening kept, and the close —
 *  where a reply says what it did and what it would do next. */
function cut(text: string, max: number): string {
  const flat = text.trim();
  if (flat.length <= max) return flat;
  const head = Math.floor(max / 3);
  return `${flat.slice(0, head)}\n[…]\n${flat.slice(flat.length - (max - head))}`;
}

/** A block of text set off so the model reads it as one quotation. */
const quoted = (text: string) => `"""\n${text}\n"""`;

/** The work a reply put forward and hadn't done: the notes' " · next: ". */
function offered(reply: string): string | undefined {
  const at = reply.indexOf(" · next: ");
  return at >= 0 ? reply.slice(at + " · next: ".length).trim() : undefined;
}

/** Files a stretch of exchanges changed, those more exchanges worked on
 *  first. */
function changed(turns: ArchivedTurn[], max = 25): string {
  const counts = new Map<string, number>();
  for (const turn of turns) for (const file of turn.files) counts.set(file, (counts.get(file) ?? 0) + 1);
  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = ranked.slice(0, max).map(([file, n]) => (n > 1 ? `${file} (in ${n})` : file));
  return ranked.length > max ? `${shown.join(", ")}, and ${ranked.length - max} more` : shown.join(", ");
}

/** An exchange at length: the user's words as they wrote them, the close of
 *  the reply, what it changed, and where the whole of it is. */
function atLength(
  turn: ArchivedTurn,
  n: number,
  file: string,
  userChars: number,
  replyChars: number,
): string {
  const lines = [`${n}. user wrote:`, quoted(cut(turn.user, userChars))];
  const reply = turn.assistant.join("\n\n").trim();
  lines.push(
    "   you replied (its close, where it's long):",
    reply ? quoted(cut(reply, replyChars)) : "(no reply)",
  );
  if (turn.files.length) lines.push(`   changed: ${turn.files.slice(0, 20).join(", ")}`);
  lines.push(`   full: ${file}`);
  return lines.join("\n");
}

/**
 * Write every turn's full record to disk and return the model-facing brief
 * plus its structured prompt/reply pairs (what the UI renders), or null when
 * there's nothing to compact. The brief covers the whole conversation: git's
 * account and the transcript's at the head, what the digest has folded
 * condensed after it, then every exchange after that listed by its notes —
 * at most BRIEF_LISTED of them, give or take a fold still in flight — the
 * last few at length. Listed exchanges keep their numbers in the whole
 * conversation, so each one's number is its record's file.
 */
export function buildCompaction(
  channelId: string,
  events: TranscriptEvent[],
  summaries: Record<string, TurnSummary>,
  digest?: Digest,
  context: BriefContext = {},
): { brief: string; entries: CompactionEntry[]; digest?: CompactionDigest } | null {
  const turns = groupTurns(events, context.projectName);
  if (turns.length === 0) return null;
  const files = writeTurnFiles(channelId, turns);
  const end = digestEnd(
    turns.map((turn) => turn.turnId),
    digest,
  );
  const entries: CompactionEntry[] = [];
  const recentFrom = Math.max(end, turns.length - BRIEF_RECENT);
  const lines: string[] = [];
  const recent: string[] = [];
  turns.slice(end).forEach((turn, k) => {
    const i = end + k;
    const { user, reply } = notesOf(turn, summaries);
    entries.push({ user, reply, n: i + 1 });
    if (i < recentFrom) {
      lines.push(`${i + 1}. user: ${user}\n   you: ${reply}\n   full: ${files[i]!}`);
      return;
    }
    const rank = turns.length - 1 - i;
    recent.push(
      atLength(turn, i + 1, files[i]!, RECENT_USER_CHARS[rank] ?? 2000, RECENT_REPLY_CHARS[rank] ?? 1500),
    );
  });

  const state: string[] = [];
  for (const line of context.git ?? []) state.push(`- ${line}`);
  const touched = changed(turns);
  if (touched) {
    state.push(
      `- Files this conversation changed with its edit tools (shell edits don't show), those more exchanges worked on first: ${touched}`,
    );
  }
  const last = entries.at(-1);
  const next = last ? offered(last.reply) : undefined;
  if (next) {
    const fact = context.facts?.(next) ?? "";
    state.push(`- Your last reply offered to do next: ${next}${fact ? ` ${fact}` : ""}`);
  }
  const stateBlock = state.length ? `<state>\n${state.join("\n")}\n</state>\n\n` : "";

  const condensed = digest
    ? "<condensed>\n" +
      (end > 0
        ? `Exchanges 1–${end}, condensed. Their full records are files 001.md to ${String(end).padStart(3, "0")}.md in ${path.dirname(files[0]!)} — read one whenever this memory is not detail enough.\n\n`
        : "The conversation's earliest exchanges, condensed (their full records are no longer kept).\n\n") +
      digest.text.trim() +
      "\n</condensed>\n\n"
    : "";
  const listed = lines.length ? `${lines.join("\n")}\n` : "";
  const recentBlock = recent.length
    ? `${listed ? "\n" : ""}<recent>\n${recent.join("\n\n")}\n</recent>\n`
    : "";
  const brief =
    "<compacted-history>\n" +
    BRIEF_INTRO +
    (digest ? DIGEST_INTRO : "") +
    "\n" +
    stateBlock +
    condensed +
    listed +
    recentBlock +
    "</compacted-history>\n\n";
  return { brief, entries, ...(digest ? { digest: { text: digest.text.trim(), through: end } } : {}) };
}

const CATCH_UP_INTRO =
  'This conversation went on without you for a while: the user switched to another model, and it carried on there. The numbered exchanges below are what happened while you were away, oldest first, picking up right after the last one you took part in — "user" is their prompt, "you replied" is what was answered (by the other model, but it was this conversation\'s answer, and it is yours to stand behind now). Treat them as your own memory; the user assumes you know all of it.\n' +
  'Each ends with "full:" and a file path holding its complete prompt, response, tool activity, and preserved attachment paths. Whenever what is here is not detailed enough to answer or act on, read that file with your file tools instead of guessing. The files may have changed under you meanwhile — look before you edit.\n';

/**
 * What a session missed while the chat ran on other harnesses: every
 * exchange after `since` (the last it holds, by its prompt's event id), the
 * last few at length and any before them as notes, each with its full
 * record's path. Where a compaction brief retells the whole conversation to
 * a fresh session, this is for one that already holds most of it — a Claude
 * session the chat is switching back to after a run on Codex — and tells it
 * only the part it wasn't there for. Null when there is nothing it missed.
 * `events` is the whole conversation up to the prompt going out, so the
 * records are numbered as the compaction brief numbers them.
 */
export function buildCatchUp(
  channelId: string,
  events: TranscriptEvent[],
  summaries: Record<string, TurnSummary>,
  since: string,
  context: BriefContext = {},
): string | null {
  const turns = groupTurns(events, context.projectName);
  const at = turns.findIndex((turn) => turn.turnId === since);
  const first = at + 1;
  if (at === -1 || first >= turns.length) return null;
  const files = writeTurnFiles(channelId, turns);
  // a long absence lists its latest exchanges; the rest are in their files
  const listedFrom = Math.max(first, turns.length - BRIEF_LISTED);
  const recentFrom = Math.max(listedFrom, turns.length - BRIEF_RECENT);
  const lines: string[] = [];
  const recent: string[] = [];
  for (let i = listedFrom; i < turns.length; i++) {
    const turn = turns[i]!;
    if (i < recentFrom) {
      const { user, reply } = notesOf(turn, summaries);
      lines.push(`${i + 1}. user: ${user}\n   you: ${reply}\n   full: ${files[i]!}`);
      continue;
    }
    const rank = turns.length - 1 - i;
    recent.push(
      atLength(turn, i + 1, files[i]!, RECENT_USER_CHARS[rank] ?? 2000, RECENT_REPLY_CHARS[rank] ?? 1500),
    );
  }
  const skipped =
    listedFrom > first
      ? `Exchanges ${first + 1}–${listedFrom} happened too, and aren't listed here; their full records are files ${String(first + 1).padStart(3, "0")}.md to ${String(listedFrom).padStart(3, "0")}.md in ${path.dirname(files[0]!)}.\n\n`
      : "";
  const state: string[] = [];
  for (const line of context.git ?? []) state.push(`- ${line}`);
  const touched = changed(turns.slice(first));
  if (touched) state.push(`- Files changed while you were away, with the edit tools: ${touched}`);
  const stateBlock = state.length ? `<state>\n${state.join("\n")}\n</state>\n\n` : "";
  const listed = lines.length ? `${lines.join("\n")}\n` : "";
  const recentBlock = recent.length
    ? `${listed ? "\n" : ""}<recent>\n${recent.join("\n\n")}\n</recent>\n`
    : "";
  return (
    "<while-you-were-away>\n" +
    CATCH_UP_INTRO +
    "\n" +
    stateBlock +
    skipped +
    listed +
    recentBlock +
    "</while-you-were-away>\n\n"
  );
}

/** How many exchanges the prompt's pick brings in at length, at most. */
const RELEVANT_EXCHANGES = 2;
const RELEVANT_LINES = 4;

/**
 * What of the conversation and the project's memory bears on the prompt
 * the brief rides in with, at more length than the brief gives it — the
 * exchanges already at length in the brief aside. Picked by the words the
 * prompt shares with them (server/recall.ts), so it costs no model call
 * and the send stays instant. "" when nothing shares enough.
 */
export function relevantBlock(
  channelId: string,
  exchanges: Exchange[],
  memory: Array<{ label: string; text: string }>,
  prompt: string,
): string {
  if (!prompt.trim()) return "";
  const skip = new Set(exchanges.slice(-BRIEF_RECENT).map((ex) => ex.turnId));
  // ranked among them all, the brief's own recent ones included: when the
  // best match is one the brief already gives at length, an older one has
  // to come close to it to be worth adding — a prompt about the work in
  // hand shares a word or two with half the conversation
  const hits = rankExchanges(exchanges, prompt, { limit: RELEVANT_EXCHANGES + BRIEF_RECENT + 2 });
  const top = hits[0]?.score ?? 0;
  const picked = hits
    .filter((hit) => !skip.has(hit.item.turnId) && hit.score >= top * 0.5)
    .slice(0, RELEVANT_EXCHANGES);
  const lines = rank(memory, prompt, (line) => [[line.text, 1]], { limit: RELEVANT_LINES });
  if (picked.length === 0 && lines.length === 0) return "";
  const dir = turnsDir(channelId);
  const parts = ["<relevant>"];
  if (picked.length) {
    parts.push(
      "Your next message shares words with these earlier exchanges, so here they are at more length:",
      "",
      ...picked
        .sort((a, b) => a.item.n - b.item.n)
        .map(({ item }) => {
          const file = path.join(dir, `${String(item.n).padStart(3, "0")}.md`);
          const text = [`${item.n}. user wrote:`, quoted(cut(item.user, 1500))];
          text.push(
            "   you replied:",
            item.assistant.trim() ? quoted(cut(item.assistant, 1500)) : "(no reply)",
          );
          if (item.files.length) text.push(`   changed: ${item.files.slice(0, 20).join(", ")}`);
          text.push(`   full: ${file}`);
          return text.join("\n");
        }),
    );
  }
  if (lines.length) {
    if (picked.length) parts.push("");
    parts.push(
      "From the project's memory (.ruri/catchup.md), lines that bear on it:",
      ...lines.map(({ item }) => `- ${item.label}: ${item.text}`),
    );
  }
  parts.push("</relevant>", "", "");
  return parts.join("\n");
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
