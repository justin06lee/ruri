import * as fs from "node:fs";
import * as path from "node:path";
import type { Attachment, CompactionDigest, CompactionEntry, TranscriptEvent } from "../shared/protocol.js";
import type { TurnSummary } from "./archive.js";
import { storedFilePath } from "./uploads.js";
import { isMissing, warn } from "./log.js";
import { projectRelative, type Exchange } from "./recall.js";
import { turnRecordPath, turnsDir } from "./turnRecords.js";

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

interface ArchivedTurn {
  turnId: string;
  /** Its number in the chat (SessionArchive.exchangeNo): what the brief
   *  lists it as, and its record's file name. */
  n: number;
  user: string;
  attachments: Attachment[];
  assistant: string[];
  tools: string[];
  /** Files it changed, project-relative: as its checkpoints tell it when
   *  they were kept (`summaries`), else as its edit tools' diffs name them. */
  files: string[];
  ts: number;
}

/** Group the flat event stream into prompt→result turns; compaction marks
 *  and pre-prompt stragglers don't make turns. `projectName` turns the
 *  diffs' "<project>/<path>" back into paths relative to the project;
 *  `summaries` carry what each turn's checkpoints say it changed;
 *  `numbers` each exchange's number in the chat — without them, a turn is
 *  numbered by its place. */
function groupTurns(
  events: TranscriptEvent[],
  projectName?: string,
  summaries: Record<string, TurnSummary> = {},
  numbers?: Map<string, number>,
): ArchivedTurn[] {
  const turns: ArchivedTurn[] = [];
  let open: ArchivedTurn | null = null;
  let last = 0;
  for (const event of events) {
    if (event.kind === "user") {
      const n = numbers?.get(event.id) ?? last + 1;
      last = Math.max(last, n);
      open = {
        turnId: event.id,
        n,
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
  for (const turn of turns) {
    const kept = summaries[turn.turnId]?.files;
    if (kept) turn.files = [...new Set([...kept, ...turn.files.filter((f) => !f.startsWith("/"))])];
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

function turnFile(turn: ArchivedTurn): string {
  const parts = [
    `# Exchange ${turn.n} — ${new Date(turn.ts).toISOString()}`,
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
  // a record numbered past every exchange there is was left by a rewind
  // from before rewinds took their records with them — it names nothing.
  // One for an exchange the history's cap dropped stays: it is still that
  // exchange, and the only whole record of it left.
  const top = Math.max(0, ...turns.map((turn) => turn.n));
  try {
    for (const name of fs.readdirSync(dir)) {
      if (/^\d+\.md$/.test(name) && Number.parseInt(name, 10) > top)
        fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch (err) {
    if (!isMissing(err)) warn("compaction", err, "writeTurnFiles");
    // stale records only cost disk
  }
  return turns.map((turn) => {
    const file = turnRecordPath(channelId, turn.n);
    try {
      fs.writeFileSync(file, turnFile(turn));
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

/**
 * The sections a long conversation's condensed past is kept in, fixed
 * (Factory's "anchored iterative summarization"): what the user is after,
 * what was decided and why, what was tried and failed, the rules they set,
 * where the work stands, what is open. A fold changes them by small edits
 * — a line added, one reworded, one dropped — and only for the exchanges
 * newly folded in; nothing is written again from scratch, which is how a
 * summary of a summary drifts (Amp dropped compaction for it). The files
 * the folded exchanges changed are kept by ruri, not the model.
 */
export const DIGEST_SECTIONS = ["intent", "decisions", "failed", "rules", "state", "open"] as const;
export type DigestSection = (typeof DIGEST_SECTIONS)[number];

const DIGEST_TITLES: Record<DigestSection, string> = {
  intent: "What the user is after",
  decisions: "Decided, and why",
  failed: "Tried and failed, and why",
  rules: "The user's rules",
  state: "Where it stood",
  open: "Still open",
};

/** How many lines each section keeps; past it the oldest go. */
const DIGEST_CAPS: Record<DigestSection, number> = {
  intent: 3,
  decisions: 10,
  failed: 8,
  rules: 8,
  state: 6,
  open: 8,
};

/** A long conversation's oldest exchanges, condensed; `through` is the last
 *  of them, by its turn id. `text` is a digest from before the sections. */
export interface Digest {
  through: string;
  text?: string;
  sections?: Partial<Record<DigestSection, Array<{ id: string; text: string }>>>;
  /** Each file the folded exchanges changed, by the exchanges that did. */
  files?: Record<string, number[]>;
}

/** A digest as the brief gives it. */
export function digestText(digest: Digest): string {
  const out: string[] = [];
  if (digest.text?.trim()) out.push(digest.text.trim());
  for (const section of DIGEST_SECTIONS) {
    const lines = digest.sections?.[section] ?? [];
    if (lines.length) out.push(`${DIGEST_TITLES[section]}:`, ...lines.map((line) => `- ${line.text}`));
  }
  const files = Object.entries(digest.files ?? {});
  if (files.length) {
    const ranked = files.sort((a, b) => b[1].length - a[1].length).slice(0, 25);
    out.push(
      "Files changed then (by exchange):",
      `- ${ranked.map(([file, ns]) => `${file} [${ns.join(", ")}]`).join("; ")}${files.length > 25 ? `; and ${files.length - 25} more` : ""}`,
    );
  }
  return out.join("\n");
}

/** An edit a fold asks of the digest's sections. */
export interface DigestOp {
  op: "add" | "edit" | "drop";
  section?: DigestSection;
  id?: string;
  text?: string;
}

/** The digest after a fold's edits: lines added to their sections, reworded
 *  or dropped by id; each section held to its cap, the oldest going. An op
 *  that names nothing there is skipped. */
export function applyDigestOps(digest: Digest | undefined, ops: DigestOp[], through: string): Digest {
  const sections: Record<DigestSection, Array<{ id: string; text: string }>> = Object.fromEntries(
    DIGEST_SECTIONS.map((section) => [section, [...(digest?.sections?.[section] ?? [])]]),
  ) as Record<DigestSection, Array<{ id: string; text: string }>>;
  const taken = new Set(DIGEST_SECTIONS.flatMap((section) => sections[section].map((line) => line.id)));
  let next = taken.size;
  const find = (id: string) => {
    for (const section of DIGEST_SECTIONS) {
      const at = sections[section].findIndex((line) => line.id === id);
      if (at !== -1) return { section, at };
    }
    return undefined;
  };
  for (const op of ops) {
    const text = op.text?.trim();
    if (op.op === "add" && op.section && text) {
      let id: string;
      do id = `${op.section[0]}${++next}`;
      while (taken.has(id));
      taken.add(id);
      sections[op.section].push({ id, text });
    } else if ((op.op === "edit" || op.op === "drop") && op.id) {
      const found = find(op.id);
      if (!found) continue;
      if (op.op === "drop") sections[found.section].splice(found.at, 1);
      else if (text) sections[found.section][found.at] = { id: op.id, text };
    }
  }
  for (const section of DIGEST_SECTIONS) {
    const cap = DIGEST_CAPS[section];
    if (sections[section].length > cap) sections[section].splice(0, sections[section].length - cap);
  }
  return {
    through,
    ...(digest?.text ? { text: digest.text } : {}),
    sections: Object.fromEntries(
      DIGEST_SECTIONS.flatMap((s) => (sections[s].length ? [[s, sections[s]]] : [])),
    ),
    ...(digest?.files ? { files: digest.files } : {}),
  };
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
  exchangeNumbers?(channelId: string): Map<string, number>;
  allEvents(channelId: string): TranscriptEvent[];
  summaries(channelId: string): Record<string, TurnSummary>;
  digest(channelId: string): Digest | undefined;
  setDigest(channelId: string, digest: Digest): void;
}

/** One exchange as a fold of the digest reads it: the user's words as they
 *  wrote them, the reply's note. */
export interface DigestExchange {
  n: number;
  user: string;
  reply: string;
}

/** Asks for the edits that fold exchanges into the digest — the memory
 *  model, in the app (server/digestFold.ts). Undefined when it gave
 *  nothing usable. */
export type FoldDigest = (
  digest: Digest | undefined,
  exchanges: DigestExchange[],
) => Promise<DigestOp[] | undefined>;

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
        const turns = groupTurns(
          this.store.allEvents(channelId),
          undefined,
          summaries,
          this.store.exchangeNumbers?.(channelId),
        ).filter((turn) => wanted.has(turn.turnId));
        // the user's words as they wrote them (a pasted log cut), the
        // reply's note
        const exchanges = turns.map((turn) => ({
          n: turn.n,
          user: cut(turn.user, 1500),
          reply: notesOf(turn, summaries).reply,
        }));
        const ops = await this.fold(digest, exchanges);
        if (!ops) return;
        const through = due[due.length - 1]!;
        // a rewind while the model wrote may have taken what it folded, or
        // the digest it was folding into
        if (!this.store.turnIds(channelId).includes(through)) return;
        if (this.store.digest(channelId)?.through !== digest?.through) return;
        const next = applyDigestOps(digest, ops, through);
        // the files are ruri's to keep, from the turns themselves
        const files: Record<string, number[]> = { ...(digest?.files ?? {}) };
        for (const turn of turns) {
          for (const file of turn.files) files[file] = [...new Set([...(files[file] ?? []), turn.n])];
        }
        this.store.setDigest(channelId, { ...next, ...(Object.keys(files).length ? { files } : {}) });
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
  'You are a fresh session continuing a conversation that was compacted. The numbered exchanges below are that conversation, oldest first: "user wrote:" is their prompt, in their own words, "you:" is your reply. Treat them as your own memory — the user assumes you know all of it.\n' +
  "It opens with <state>: where things stand, read from git and ruri's checkpoints as this brief went out — facts, not recollection; where a note disagrees with it, the state is right — with every file the conversation changed and where it stands now. The user's prompts are here word for word (a very long one cut in its middle), the oldest condensed instead (<condensed>) and, where the brief ran out of room, named by their record files; your replies are compressed to notes, except the last few (<recent>), which come at length.\n" +
  'Each exchange ends with "full:" and a file path holding its complete prompt, response, tool activity, and preserved attachment paths. Whenever a note alone is not detailed enough to answer or act on, read that file with your file tools instead of guessing. If it names an image path, open it with your image-viewing tool to inspect the actual pixels.\n';

const LAYERS_INTRO =
  "After it, <layers>: the parts of the project this conversation worked in, and what sessions learned working there.\n";

const DIGEST_INTRO =
  "The oldest exchanges come first, condensed together into one memory (<condensed>); the ones after it are listed one by one.\n";

/** How many of the last exchanges the brief gives at length. */
export const BRIEF_RECENT = 3;

/**
 * A brief's whole size, at most, in tokens (four characters each, near
 * enough). A brief used to grow with the conversation — 27k characters on
 * a long real chat, and nothing stopped it going further — while a model
 * reads a focused prompt better than a long one (Chroma's "context rot":
 * every model tested did worse as its input grew). So the brief keeps a
 * budget and spends it in order of what a fresh session needs most: the
 * state of things, the last exchanges at length, the layers, the
 * condensed past, then the listed exchanges newest first — and the ones
 * that don't fit are named by their record files, not dropped.
 */
export const BRIEF_BUDGET_TOKENS = Number(process.env["RURI_BRIEF_BUDGET"]) || 16_000;
const CHARS_PER_TOKEN = 4;
/** What the layers and the condensed past may take of it, at most. */
const LAYERS_SHARE = 0.12;
const CONDENSED_SHARE = 0.3;
/** How much of an older prompt the brief gives — all of it, but for the
 *  rare pasted log, which is cut in its middle. */
const LISTED_USER_CHARS = 3000;
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
  /** The layers a set of files is in, as the brief's <layers> block says
   *  it — what they are, how to read each, and what sessions learned there.
   *  Absent, or nothing back, for a project without layer sheets. */
  layers?: (files: string[]) => string;
  /** Each exchange's number in the chat, by its prompt's id
   *  (SessionArchive.exchangeNumbers) — what the brief lists it as. */
  numbers?: Map<string, number>;
  /** How each file the conversation changed stands now — "uncommitted",
   *  "deleted", "" for committed and unchanged since — read from git and
   *  the disk as the brief goes out. */
  standing?: (files: string[]) => Map<string, string>;
  /** The brief's budget in tokens (BRIEF_BUDGET_TOKENS). */
  budget?: number;
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

/** What the brief's <state> says: git's account, and the files the
 *  conversation changed — each with the exchanges that changed it and how
 *  it stands now, kept by ruri from the turns' checkpoints rather than
 *  recalled by a model (Factory's evaluation: artifact tracking scored
 *  about 2.3 of 5 for every summarising method). */
function stateLines(turns: ArchivedTurn[], context: BriefContext): string[] {
  const state: string[] = [];
  for (const line of context.git ?? []) state.push(`- ${line}`);
  const touched = artifacts(turns, context);
  if (touched) {
    state.push(
      `- Files this conversation changed, those more exchanges worked on first (by the exchanges that changed them, and as they stand now): ${touched}`,
    );
  }
  return state;
}

/** The files a stretch of exchanges changed, with the exchanges that changed
 *  each and how each stands now — those more exchanges worked on first. */
function artifacts(turns: ArchivedTurn[], context: BriefContext, max = 30): string {
  const by = new Map<string, number[]>();
  for (const turn of turns) for (const file of turn.files) by.set(file, [...(by.get(file) ?? []), turn.n]);
  const ranked = [...by].sort((a, b) => b[1].length - a[1].length || Math.max(...b[1]) - Math.max(...a[1]));
  const now = context.standing?.(ranked.slice(0, max).map(([file]) => file)) ?? new Map<string, string>();
  const shown = ranked.slice(0, max).map(([file, ns]) => {
    const where = now.get(file);
    const which = ns.length > 4 ? `${ns.slice(0, 2).join(", ")} … ${ns.at(-1)}` : ns.join(", ");
    return `${file} [${which}]${where ? ` ${where}` : ""}`;
  });
  return ranked.length > max ? `${shown.join("; ")}; and ${ranked.length - max} more` : shown.join("; ");
}

/** A block of text kept within `max` characters — whole lines, then a
 *  note of what was left out. */
function within(text: string, max: number, left: string): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > max - left.length - 1) break;
    out.push(line);
    used += line.length + 1;
  }
  return [...out, left].join("\n");
}

/** An older exchange in the list: the user's words as they wrote them,
 *  the reply as its note. */
function listed(turn: ArchivedTurn, reply: string, file: string): string {
  return `${turn.n}. user wrote:\n${quoted(cut(turn.user, LISTED_USER_CHARS))}\n   you: ${reply}\n   full: ${file}`;
}

/** An exchange at length: the user's words as they wrote them, the close of
 *  the reply, what it changed, and where the whole of it is. */
function atLength(turn: ArchivedTurn, file: string, userChars: number, replyChars: number): string {
  const lines = [`${turn.n}. user wrote:`, quoted(cut(turn.user, userChars))];
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
  const turns = groupTurns(events, context.projectName, summaries, context.numbers);
  if (turns.length === 0) return null;
  const files = writeTurnFiles(channelId, turns);
  const end = digestEnd(
    turns.map((turn) => turn.turnId),
    digest,
  );
  const budget = (context.budget ?? BRIEF_BUDGET_TOKENS) * CHARS_PER_TOKEN;
  const entries: CompactionEntry[] = [];
  const recentFrom = Math.max(end, turns.length - BRIEF_RECENT);
  const lines: Array<{ i: number; text: string }> = [];
  const recent: string[] = [];
  turns.slice(end).forEach((turn, k) => {
    const i = end + k;
    const { user, reply } = notesOf(turn, summaries);
    entries.push({ user, reply, n: turn.n });
    if (i < recentFrom) {
      lines.push({ i, text: listed(turn, reply, files[i]!) });
      return;
    }
    const rank = turns.length - 1 - i;
    recent.push(atLength(turn, files[i]!, RECENT_USER_CHARS[rank] ?? 2000, RECENT_REPLY_CHARS[rank] ?? 1500));
  });

  // first what can't be done without: the state, and the last exchanges
  const state = stateLines(turns, context);
  const last = entries.at(-1);
  const next = last ? offered(last.reply) : undefined;
  if (next) {
    const fact = context.facts?.(next) ?? "";
    state.push(`- Your last reply offered to do next: ${next}${fact ? ` ${fact}` : ""}`);
  }
  const stateBlock = state.length ? `<state>\n${state.join("\n")}\n</state>\n\n` : "";
  const recentBlock = recent.length ? `<recent>\n${recent.join("\n\n")}\n</recent>\n` : "";
  // then the layers and the condensed past, each within its share
  const worked = context.layers?.(turns.flatMap((turn) => turn.files)) ?? "";
  const layersBlock = worked
    ? `<layers>\n${within(worked, budget * LAYERS_SHARE, "(more in each layer's sheet)")}\n</layers>\n\n`
    : "";
  const condensed = digest
    ? "<condensed>\n" +
      (end > 0
        ? `Exchanges ${turns[0]!.n}–${turns[end - 1]!.n}, condensed. Their full records are files ${path.basename(files[0]!)} to ${path.basename(files[end - 1]!)} in ${path.dirname(files[0]!)} — read one whenever this memory is not detail enough.\n\n`
        : "The conversation's earliest exchanges, condensed (their full records are no longer kept).\n\n") +
      within(
        digestText(digest),
        budget * CONDENSED_SHARE,
        "(the rest of the condensed memory is cut for room)",
      ) +
      "\n</condensed>\n\n"
    : "";
  const head =
    "<compacted-history>\n" +
    BRIEF_INTRO +
    (layersBlock ? LAYERS_INTRO : "") +
    (digest ? DIGEST_INTRO : "") +
    "\n";
  const tail = "</compacted-history>\n\n";
  // and the listed exchanges with what is left, newest first
  let room = budget - (head + stateBlock + layersBlock + condensed + recentBlock + tail).length;
  const kept: typeof lines = [];
  for (const line of [...lines].reverse()) {
    if (line.text.length + 1 > room) break;
    kept.unshift(line);
    room -= line.text.length + 1;
  }
  const unlisted = lines.slice(0, lines.length - kept.length);
  const skipped = unlisted.length
    ? `Exchanges ${turns[unlisted[0]!.i]!.n}–${turns[unlisted.at(-1)!.i]!.n} aren't listed here, for room; their full records are files ${path.basename(files[unlisted[0]!.i]!)} to ${path.basename(files[unlisted.at(-1)!.i]!)} in ${path.dirname(files[0]!)}.\n\n`
    : "";
  const listedBlock = kept.length ? `${kept.map((line) => line.text).join("\n")}\n` : "";
  const brief =
    head +
    stateBlock +
    layersBlock +
    condensed +
    skipped +
    listedBlock +
    (recentBlock ? `${listedBlock ? "\n" : ""}${recentBlock}` : "") +
    tail;
  return {
    brief,
    entries,
    ...(digest ? { digest: { text: digestText(digest), through: end } } : {}),
  };
}

const AFTER_COMPACT_INTRO =
  'Claude Code just compacted this conversation into its own summary. ruri keeps every exchange whole, and hands you back what a summary loses: where the repo stands now, the layers this conversation works in, and the user\'s last prompts word for word — what "this" and "that" in them point at. Where your summary and these disagree, these are right. Each exchange\'s complete record (prompt, reply, tools, attachments) is the file named after it; read one when the summary isn\'t detail enough.\n';

/** How many of the last prompts go back in after a compaction, and how
 *  much of each — the newest the most. */
const AFTER_COMPACT_PROMPTS = 6;
const AFTER_COMPACT_PROMPT_CHARS = [4000, 2000, 1200, 800, 800, 800];

/**
 * What a session that compacted itself is handed as it starts again
 * (server/sessions.ts onSessionStart): the state, the layers, the user's
 * last few prompts verbatim — the one in flight first among them — and the
 * path to every exchange's record. A summary paraphrases; these don't.
 */
export function buildAfterCompaction(
  channelId: string,
  events: TranscriptEvent[],
  summaries: Record<string, TurnSummary>,
  context: BriefContext = {},
): string {
  const turns = groupTurns(events, context.projectName, summaries, context.numbers);
  if (turns.length === 0) return "";
  const files = writeTurnFiles(channelId, turns);
  const state = stateLines(turns, context);
  const worked = context.layers?.(turns.flatMap((turn) => turn.files)) ?? "";
  const last = turns.slice(-AFTER_COMPACT_PROMPTS).reverse();
  const prompts = last.map((turn, i) => {
    const file = files[turns.indexOf(turn)]!;
    return `${turn.n}. user wrote${i === 0 ? " (the prompt you are working on now)" : ""}:\n${quoted(cut(turn.user, AFTER_COMPACT_PROMPT_CHARS[i] ?? 800))}\n   full: ${file}`;
  });
  return (
    "<ruri:after-compaction>\n" +
    AFTER_COMPACT_INTRO +
    "\n" +
    (state.length ? `<state>\n${state.join("\n")}\n</state>\n\n` : "") +
    (worked ? `<layers>\n${worked}\n</layers>\n\n` : "") +
    `<prompts>\nThe user's last prompts, newest first:\n\n${prompts.join("\n\n")}\n</prompts>\n` +
    `Every exchange's record is in ${path.dirname(files[0]!)} as <number>.md.\n` +
    "</ruri:after-compaction>"
  );
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
  const turns = groupTurns(events, context.projectName, summaries, context.numbers);
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
      lines.push(listed(turn, notesOf(turn, summaries).reply, files[i]!));
      continue;
    }
    const rank = turns.length - 1 - i;
    recent.push(atLength(turn, files[i]!, RECENT_USER_CHARS[rank] ?? 2000, RECENT_REPLY_CHARS[rank] ?? 1500));
  }
  const skipped =
    listedFrom > first
      ? `Exchanges ${turns[first]!.n}–${turns[listedFrom - 1]!.n} happened too, and aren't listed here; their full records are files ${path.basename(files[first]!)} to ${path.basename(files[listedFrom - 1]!)} in ${path.dirname(files[0]!)}.\n\n`
      : "";
  const state: string[] = [];
  for (const line of context.git ?? []) state.push(`- ${line}`);
  const touched = changed(turns.slice(first));
  if (touched) state.push(`- Files changed while you were away: ${touched}`);
  const stateBlock = state.length ? `<state>\n${state.join("\n")}\n</state>\n\n` : "";
  const listedBlock = lines.length ? `${lines.join("\n")}\n` : "";
  const recentBlock = recent.length
    ? `${listedBlock ? "\n" : ""}<recent>\n${recent.join("\n\n")}\n</recent>\n`
    : "";
  return (
    "<while-you-were-away>\n" +
    CATCH_UP_INTRO +
    "\n" +
    stateBlock +
    skipped +
    listedBlock +
    recentBlock +
    "</while-you-were-away>\n\n"
  );
}

/** What the brief's pick found (server/handoff.ts withRelevance ranks it,
 *  project-wide): exchanges from any of the project's chats, and memory
 *  lines, each already labelled. */
export interface Picked {
  exchanges: Array<Exchange & { title?: string }>;
  lines: Array<{ label: string; text: string }>;
}

/**
 * What of the project's chats and memory bears on the prompt the brief
 * rides in with, at more length than the brief gives it. An exchange of
 * this chat names its record; one of another chat names the command that
 * prints it whole. "" when the pick found nothing — nothing is better than
 * a distractor.
 */
export function relevantBlock(channelId: string, picked: Picked): string {
  if (picked.exchanges.length === 0 && picked.lines.length === 0) return "";
  const parts = ["<relevant>"];
  if (picked.exchanges.length) {
    parts.push(
      "Your next message bears on these earlier exchanges in this project, so here they are at more length:",
      "",
      ...[...picked.exchanges]
        .sort((a, b) => (a.chat === b.chat ? a.n - b.n : a.chat === channelId ? 1 : -1))
        .map((item) => {
          const ours = item.chat === channelId;
          const head = ours
            ? `${item.n}. user wrote:`
            : `${item.chat.slice(0, 8)}#${item.n} (in the "${item.title ?? "untitled"}" chat). The user wrote:`;
          const text = [head, quoted(cut(item.user, 1500))];
          text.push(
            ours ? "   you replied:" : "   the agent replied:",
            item.assistant.trim() ? quoted(cut(item.assistant, 1500)) : "(no reply)",
          );
          if (item.files.length) text.push(`   changed: ${item.files.slice(0, 20).join(", ")}`);
          text.push(
            ours
              ? `   full: ${turnRecordPath(item.chat, item.n)}`
              : `   full: \`ruri recall show ${item.chat.slice(0, 8)}#${item.n}\``,
          );
          return text.join("\n");
        }),
    );
  }
  if (picked.lines.length) {
    if (picked.exchanges.length) parts.push("");
    parts.push(
      "From the project's memory (.ruri/catchup.md), lines that bear on it:",
      ...picked.lines.map((line) => `- ${line.label}: ${line.text}`),
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
    const turn = turns.find((t) => t.n === n);
    if (!turn) continue;
    const expected = turn.attachments.flatMap((attachment) =>
      attachment.url ? [JSON.stringify(storedFilePath(attachment.url))] : [],
    );
    if (expected.length === 0) continue;
    const file = path.join(dir, name);
    try {
      const current = fs.readFileSync(file, "utf8");
      if (expected.every((attachmentPath) => current.includes(attachmentPath))) continue;
      fs.writeFileSync(file, turnFile(turn));
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
