import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { excerpt, keepRecent, unmarked, type EarlierItem, type TranscriptEvent, type TurnNote } from "../shared/protocol.js";

/**
 * Per-project session archive: the single source of truth for transcripts,
 * turn summaries, and the resumable Claude session id — persisted so nothing
 * is lost across app restarts and compaction can be instant (summaries are
 * precomputed).
 *
 * A channel's transcript is kept in two parts. The live part —
 * ~/.config/ruri/sessions/<id>.json — runs from the newest compaction mark
 * to now; it is what the chat shows, what every event rewrites, and so it
 * stays small. Everything before that mark is the history —
 * ~/.config/ruri/history/<id>.jsonl, one event per line — which a compaction
 * appends to and nothing else touches: it is read only for a rewind or a
 * fork that reaches back past the mark, a compaction's brief (which covers
 * the whole conversation), and the chat's "earlier" view. The history is
 * capped (HISTORY_MAX_BYTES); past that its oldest exchanges are dropped.
 */

/** A turn's recall notes: the prompt's and the reply's, each written by the
 *  small model the moment its half exists. An empty string is a half the
 *  model was asked for and gave nothing usable — asked, so not asked again. */
export type TurnSummary = TurnNote;

interface ArchiveData {
  events: TranscriptEvent[];
  /** Turn summaries keyed by the turn's opening user-event id. */
  summaries: Record<string, TurnSummary>;
  lastSessionId?: string;
  /** Every CLI session id this channel has ever run on (compaction and
   *  rewind move it along; the old ones stay ruri's). What keeps a chat
   *  ruri made from being offered back to it as somebody else's. */
  sessionIds?: string[];
  /** A finished compaction's brief, waiting to ride the next prompt into the
   *  fresh session (persisted so a restart in between loses nothing). */
  pendingBrief?: string;
  /** SDK chain uuids per turn (keyed by the opening user-event id): the
   *  prompt's own uuid (`user` — the file-rewind target) and the turn's
   *  latest chain uuid (`last` — the fork point when rewinding PAST it). */
  chain?: Record<string, { user?: string; last?: string }>;
  /** A rewind's fork point: the next Claude session resumes truncated here. */
  resumeAt?: string;
  /** The next Claude session forks the resumed one at its tip — a chat
   *  forked at its latest exchange shares the file up to there and then
   *  goes its own way, leaving the original's file alone. */
  forkNext?: boolean;
  /** Tokens in the window after the channel's last API call. Persisted so the
   *  context gauge reads the real occupancy on launch instead of zero until
   *  the next turn happens to refill it. */
  contextTokens?: number;
  /** The context window that channel's harness reported for its model —
   *  Codex names its own, and it is not one of Claude's two sizes. */
  contextWindow?: number;
  /** Which model that window belongs to. A reported window is only true of
   *  the model that reported it: a channel switched to Codex for one turn
   *  and switched back must not go on measuring Claude against Codex's
   *  window, which is what pinned the context dragon full. */
  contextWindowModel?: string;
}

/** A turn's notes as the wire carries them: only the halves with words in. */
function wireNote(note: TurnSummary | undefined): TurnNote {
  const out: TurnNote = {};
  if (note?.user?.trim()) out.user = note.user.trim();
  if (note?.reply?.trim()) out.reply = note.reply.trim();
  return out;
}

/** How much of a prompt, and of a reply's last message, stands in for its
 *  note in the earlier view until the note is written. */
const PROMPT_EXCERPT = 220;
const REPLY_EXCERPT = 240;

/**
 * What the earlier view needs of a history: each exchange — its id, a cut
 * of its prompt and its last reply for while its notes are missing, how
 * many events it holds — and each compaction mark, without the bodies. A
 * history is mostly tool output and briefs (megabytes, for a long chat);
 * this is a few dozen kilobytes, and the bodies come only for an exchange
 * somebody opens.
 */
function outline(events: TranscriptEvent[]): EarlierItem[] {
  const items: EarlierItem[] = [];
  let open: Extract<EarlierItem, { kind: "turn" }> | null = null;
  let reply = "";
  for (const event of events) {
    if (event.kind === "compaction" || event.kind === "user") {
      if (open) open.reply = excerpt(unmarked(reply), REPLY_EXCERPT);
      open = null;
      reply = "";
    }
    if (event.kind === "compaction") {
      items.push({ kind: "compaction", id: event.id, ts: event.ts });
    } else if (event.kind === "user") {
      open = { kind: "turn", turnId: event.id, prompt: excerpt(event.text, PROMPT_EXCERPT), reply: "", count: 1, ts: event.ts };
      items.push(open);
    } else if (open) {
      open.count += 1;
      if (event.kind === "assistant" && event.text.trim()) reply = event.text;
    }
  }
  if (open) open.reply = excerpt(unmarked(reply), REPLY_EXCERPT);
  return items;
}

function archiveDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "sessions",
  );
}

function historyDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "history",
  );
}

function historyFile(projectId: string): string {
  return path.join(historyDir(), `${projectId}.jsonl`);
}

/** How big a channel's history may grow before its oldest exchanges go. */
const HISTORY_MAX_BYTES = Number(process.env["RURI_HISTORY_MAX_BYTES"]) || 16 * 1024 * 1024;
/** What a trim cuts it back to, as a share of the cap — so a history at the
 *  cap is trimmed once in a while rather than on every compaction. */
const HISTORY_TRIM_TO = 0.75;

/** The index of the newest compaction mark, or -1. */
function lastMark(events: TranscriptEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.kind === "compaction") return i;
  return -1;
}

/**
 * How long a change waits before the file is rewritten. A turn streams
 * many events a second, and every one of them used to schedule a rewrite
 * of the whole transcript half a second later — a chat a few megabytes long
 * was serialised twice a second for as long as the reply lasted. A second
 * is still well inside what a crash can afford to lose.
 */
const WRITE_DELAY_MS = 1000;

export class SessionArchive {
  private readonly data = new Map<string, ArchiveData>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  /** Channels that keep only their newest events (Home), and how many. */
  private readonly caps = new Map<string, number>();
  private readonly outlines = new Map<string, { size: number; mtimeMs: number; items: EarlierItem[] }>();
  private readonly historyMax: number;

  constructor(options: { historyMaxBytes?: number } = {}) {
    this.historyMax = options.historyMaxBytes ?? HISTORY_MAX_BYTES;
  }

  /** Keep only the newest `max` events of this channel, from now on. */
  cap(projectId: string, max: number): void {
    this.caps.set(projectId, max);
    const entry = this.data.get(projectId);
    if (entry && this.trim(projectId, entry)) this.scheduleWrite(projectId);
  }

  /** Apply a channel's cap; true when anything was dropped. The dropped
   *  turns' notes and chain uuids go with them. */
  private trim(projectId: string, entry: ArchiveData): boolean {
    const max = this.caps.get(projectId);
    if (max === undefined || entry.events.length <= max) return false;
    const kept = keepRecent(entry.events, max);
    const dropped = entry.events.slice(0, entry.events.length - kept.length);
    entry.events = kept;
    for (const event of dropped) {
      delete entry.summaries[event.id];
      if (entry.chain) delete entry.chain[event.id];
    }
    return true;
  }

  private load(projectId: string): ArchiveData {
    let entry = this.data.get(projectId);
    if (entry) return entry;
    try {
      const raw = JSON.parse(
        fs.readFileSync(path.join(archiveDir(), `${projectId}.json`), "utf8"),
      ) as Partial<ArchiveData>;
      // summaries were single combined strings before the prompt/reply
      // split — an old note covered the whole turn, so it lands as `reply`
      const summaries: Record<string, TurnSummary> = {};
      if (raw.summaries && typeof raw.summaries === "object") {
        for (const [turnId, value] of Object.entries(raw.summaries)) {
          if (typeof value === "string") summaries[turnId] = { reply: value };
          else if (value && typeof value === "object") summaries[turnId] = value as TurnSummary;
        }
      }
      entry = {
        events: Array.isArray(raw.events) ? raw.events : [],
        summaries,
        ...(typeof raw.lastSessionId === "string" ? { lastSessionId: raw.lastSessionId } : {}),
        ...(Array.isArray(raw.sessionIds) ? { sessionIds: raw.sessionIds.filter((id) => typeof id === "string") } : {}),
        ...(typeof raw.pendingBrief === "string" ? { pendingBrief: raw.pendingBrief } : {}),
        ...(raw.chain && typeof raw.chain === "object" ? { chain: raw.chain } : {}),
        ...(typeof raw.resumeAt === "string" ? { resumeAt: raw.resumeAt } : {}),
        ...(raw.forkNext === true ? { forkNext: true } : {}),
        ...(typeof raw.contextTokens === "number" ? { contextTokens: raw.contextTokens } : {}),
        // an unattributed window is from before it was recorded whose it is
        // — it can't be checked against the current model, so it is dropped
        ...(typeof raw.contextWindow === "number" && typeof raw.contextWindowModel === "string"
          ? { contextWindow: raw.contextWindow, contextWindowModel: raw.contextWindowModel }
          : {}),
      };
    } catch {
      entry = { events: [], summaries: {} };
    }
    this.trim(projectId, entry);
    this.data.set(projectId, entry);
    // an archive from before the history carries every compaction's past
    // inline — moved out once, here, and the smaller file written at once
    if (this.fold(projectId, entry)) this.flush(projectId);
    return entry;
  }

  /* ── the history ─────────────────────────────────────────────────── */

  /** Everything before the live part, oldest first. Read from disk each
   *  time: it is never wanted on the hot path. */
  history(projectId: string): TranscriptEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(historyFile(projectId), "utf8");
    } catch {
      return [];
    }
    const events: TranscriptEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        events.push(JSON.parse(line) as TranscriptEvent);
      } catch {
        // a line torn by a crash mid-append
      }
    }
    return events;
  }

  /** The history's outline (see `outline`), kept while its file is unchanged
   *  — every opening of a chat asks for it, and the file changes only when
   *  a compaction, a rewind or the cap rewrites it. */
  earlier(projectId: string): EarlierItem[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(historyFile(projectId));
    } catch {
      this.outlines.delete(projectId);
      return [];
    }
    const kept = this.outlines.get(projectId);
    if (kept && kept.size === stat.size && kept.mtimeMs === stat.mtimeMs) return kept.items;
    const items = outline(this.history(projectId));
    this.outlines.set(projectId, { size: stat.size, mtimeMs: stat.mtimeMs, items });
    return items;
  }

  hasHistory(projectId: string): boolean {
    try {
      return fs.statSync(historyFile(projectId)).size > 0;
    } catch {
      return false;
    }
  }

  /** The whole conversation: the history, then the live part. */
  allEvents(projectId: string): TranscriptEvent[] {
    const live = this.load(projectId).events;
    const earlier = this.history(projectId);
    return earlier.length > 0 ? [...earlier, ...live] : live;
  }

  /**
   * Move everything before the newest compaction mark into the history.
   * Idempotent — what the history already holds is not written again, so a
   * crash between the append and the live file's rewrite heals on the next
   * load. True when anything moved.
   */
  private fold(projectId: string, entry: ArchiveData): boolean {
    const mark = lastMark(entry.events);
    if (mark <= 0) return false;
    const moved = entry.events.splice(0, mark);
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      const have = this.hasHistory(projectId)
        ? new Set(this.history(projectId).map((event) => event.id))
        : new Set<string>();
      const fresh = moved.filter((event) => !have.has(event.id));
      if (fresh.length > 0) {
        fs.appendFileSync(historyFile(projectId), fresh.map((event) => JSON.stringify(event)).join("\n") + "\n");
      }
      this.capHistory(projectId, entry);
    } catch {
      // best-effort, like the live file
    }
    return true;
  }

  /** Hold the history to its cap: the oldest exchanges go, cut where a turn
   *  starts, and their notes and chain uuids with them. */
  private capHistory(projectId: string, entry: ArchiveData): void {
    let size: number;
    try {
      size = fs.statSync(historyFile(projectId)).size;
    } catch {
      return;
    }
    if (size <= this.historyMax) return;
    const events = this.history(projectId);
    const budget = this.historyMax * HISTORY_TRIM_TO;
    let used = 0;
    let start = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      const bytes = JSON.stringify(events[i]).length + 1;
      if (used + bytes > budget) break;
      used += bytes;
      start = i;
    }
    let cut = start;
    while (cut < events.length && events[cut]!.kind !== "user" && events[cut]!.kind !== "compaction") cut++;
    if (cut >= events.length) cut = start;
    for (const event of events.slice(0, cut)) {
      delete entry.summaries[event.id];
      if (entry.chain) delete entry.chain[event.id];
    }
    this.writeHistory(projectId, events.slice(cut));
  }

  private writeHistory(projectId: string, events: TranscriptEvent[]): void {
    const file = historyFile(projectId);
    if (events.length === 0) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(historyDir(), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    fs.renameSync(tmp, file);
  }

  /** Write the live file now rather than on the debounce. */
  private flushNow(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    this.flush(projectId);
  }

  private scheduleWrite(projectId: string): void {
    if (this.timers.has(projectId)) return;
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        this.flush(projectId);
      }, WRITE_DELAY_MS),
    );
  }

  private flush(projectId: string): void {
    const entry = this.data.get(projectId);
    if (!entry) return;
    try {
      fs.mkdirSync(archiveDir(), { recursive: true });
      const file = path.join(archiveDir(), `${projectId}.json`);
      // Compact: nobody reads these by eye, and the indentation was a third
      // of every file and of every write. Written beside and renamed over,
      // so a crash mid-write leaves the last good file rather than half of
      // this one.
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(entry));
      fs.renameSync(tmp, file);
    } catch {
      // persistence is best-effort; in-memory state stays correct
    }
  }

  events(projectId: string): TranscriptEvent[] {
    return this.load(projectId).events;
  }

  append(projectId: string, event: TranscriptEvent): void {
    const events = this.load(projectId).events;
    const existing = events.findIndex((candidate) => candidate.id === event.id);
    if (existing === -1) events.push(event);
    else events[existing] = event;
    const entry = this.load(projectId);
    this.trim(projectId, entry);
    // a compaction mark: everything before it moves to the history, and
    // the live file shrinks to the mark — written at once, so the two agree
    if (event.kind === "compaction" && this.fold(projectId, entry)) {
      this.flushNow(projectId);
      return;
    }
    this.scheduleWrite(projectId);
  }

  /** Remove one event; a user event takes the rest of its turn (everything
   *  up to the next user/compaction event) with it. Returns removed ids. */
  removeTurn(projectId: string, eventId: string): string[] {
    const entry = this.load(projectId);
    const start = entry.events.findIndex((e) => e.id === eventId);
    if (start === -1) return [];
    let end = start + 1;
    if (entry.events[start]!.kind === "user") {
      while (
        end < entry.events.length &&
        entry.events[end]!.kind !== "user" &&
        entry.events[end]!.kind !== "compaction"
      ) {
        end++;
      }
    }
    const removed = entry.events.slice(start, end).map((e) => e.id);
    entry.events.splice(start, end - start);
    delete entry.summaries[eventId];
    this.scheduleWrite(projectId);
    return removed;
  }

  summaries(projectId: string): Record<string, TurnSummary> {
    return this.load(projectId).summaries;
  }

  setSummary(projectId: string, turnId: string, part: keyof TurnSummary, note: string): void {
    const entry = this.load(projectId);
    (entry.summaries[turnId] ??= {})[part] = note;
    this.scheduleWrite(projectId);
  }

  /** A turn's notes as the wire carries them. */
  note(projectId: string, turnId: string): TurnNote {
    return wireNote(this.load(projectId).summaries[turnId]);
  }

  contextTokens(projectId: string): number | undefined {
    return this.load(projectId).contextTokens;
  }

  /** Record an occupancy reading. `model` is the channel's model at the time,
   *  which is what makes a reported `window` believable later — and what
   *  retires one left behind by a model this channel no longer runs. */
  setContextTokens(projectId: string, tokens: number, window?: number, model?: string): void {
    const entry = this.load(projectId);
    entry.contextTokens = tokens;
    if (window && model) {
      entry.contextWindow = window;
      entry.contextWindowModel = model;
    } else if (model && entry.contextWindowModel !== model) {
      delete entry.contextWindow;
      delete entry.contextWindowModel;
    }
    this.scheduleWrite(projectId);
  }

  /** The window a harness last reported for this channel — only when the
   *  channel still runs the model that reported it. */
  contextWindowOf(projectId: string, model: string): number | undefined {
    const entry = this.load(projectId);
    return entry.contextWindowModel === model ? entry.contextWindow : undefined;
  }

  lastSessionId(projectId: string): string | undefined {
    return this.load(projectId).lastSessionId;
  }

  setLastSessionId(projectId: string, sessionId: string): void {
    const entry = this.load(projectId);
    entry.lastSessionId = sessionId;
    entry.sessionIds ??= [];
    if (!entry.sessionIds.includes(sessionId)) entry.sessionIds = [...entry.sessionIds.slice(-59), sessionId];
    this.scheduleWrite(projectId);
  }

  /** Every CLI session id these channels have run on, present or past. */
  ownedSessionIds(projectIds: Iterable<string>): Set<string> {
    const owned = new Set<string>();
    for (const id of projectIds) {
      const entry = this.load(id);
      if (entry.lastSessionId) owned.add(entry.lastSessionId);
      for (const sessionId of entry.sessionIds ?? []) owned.add(sessionId);
    }
    return owned;
  }

  /** Forget the resumable session id — the next send starts a fresh one. */
  clearLastSessionId(projectId: string): void {
    delete this.load(projectId).lastSessionId;
    this.scheduleWrite(projectId);
  }

  /** Record a turn's SDK chain uuid (see ArchiveData.chain). */
  setChain(projectId: string, eventId: string, kind: "user" | "last", uuid: string): void {
    const entry = this.load(projectId);
    entry.chain ??= {};
    (entry.chain[eventId] ??= {})[kind] = uuid;
    this.scheduleWrite(projectId);
  }

  chain(projectId: string): Record<string, { user?: string; last?: string }> {
    return this.load(projectId).chain ?? {};
  }

  setResumeAt(projectId: string, uuid: string): void {
    this.load(projectId).resumeAt = uuid;
    this.scheduleWrite(projectId);
  }

  /** Claim the pending rewind fork point (cleared once taken). */
  takeResumeAt(projectId: string): string | undefined {
    const entry = this.load(projectId);
    const at = entry.resumeAt;
    if (at !== undefined) {
      delete entry.resumeAt;
      this.scheduleWrite(projectId);
    }
    return at;
  }

  setForkNext(projectId: string): void {
    this.load(projectId).forkNext = true;
    this.scheduleWrite(projectId);
  }

  /** Claim the pending tip fork (cleared once taken). */
  takeForkNext(projectId: string): boolean {
    const entry = this.load(projectId);
    if (!entry.forkNext) return false;
    delete entry.forkNext;
    this.scheduleWrite(projectId);
    return true;
  }

  /**
   * Give a session history it did not live through: a fork's copy of the
   * exchanges it branches from. Everything is copied — events, the notes
   * on them, the chain uuids a later rewind would want, the context
   * reading — so the new session is, on screen and on disk, the old one up
   * to the branch point.
   */
  seed(
    projectId: string,
    from: {
      events: TranscriptEvent[];
      summaries: Record<string, TurnSummary>;
      chain: Record<string, { user?: string; last?: string }>;
      contextTokens?: number;
      contextWindow?: number;
      contextWindowModel?: string;
    },
  ): void {
    const kept = new Set(from.events.map((e) => e.id));
    const entry: ArchiveData = {
      events: from.events.map((e) => ({ ...e })),
      summaries: Object.fromEntries(
        Object.entries(from.summaries).filter(([id]) => kept.has(id)).map(([id, n]) => [id, { ...n }]),
      ),
      chain: Object.fromEntries(
        Object.entries(from.chain).filter(([id]) => kept.has(id)).map(([id, c]) => [id, { ...c }]),
      ),
      ...(from.contextTokens !== undefined ? { contextTokens: from.contextTokens } : {}),
      ...(from.contextWindow !== undefined && from.contextWindowModel !== undefined
        ? { contextWindow: from.contextWindow, contextWindowModel: from.contextWindowModel }
        : {}),
    };
    this.data.set(projectId, entry);
    // a fork of a compacted conversation gets the same split: its own
    // history up to the newest mark, its live part from there
    try {
      this.writeHistory(projectId, []);
    } catch {
      // nothing there to clear
    }
    if (this.fold(projectId, entry)) this.flushNow(projectId);
    else this.scheduleWrite(projectId);
  }

  /** Everything the archive holds for a channel, for a fork to copy from. */
  raw(projectId: string): Readonly<ArchiveData> {
    return this.load(projectId);
  }

  /** Drop everything from this event to the end (a rewind's discard),
   *  along with the dropped turns' summaries and chain uuids. */
  truncateFrom(projectId: string, eventId: string): string[] {
    const entry = this.load(projectId);
    const start = entry.events.findIndex((e) => e.id === eventId);
    let removed: string[];
    if (start !== -1) {
      removed = entry.events.splice(start).map((e) => e.id);
    } else {
      // A prompt from before the newest compaction: everything kept is
      // history now, so both parts are rebuilt from it — the history up to
      // the kept part's own newest mark, the live part from there.
      const earlier = this.history(projectId);
      const at = earlier.findIndex((e) => e.id === eventId);
      if (at === -1) return [];
      removed = [...earlier.slice(at), ...entry.events].map((e) => e.id);
      const kept = earlier.slice(0, at);
      const mark = lastMark(kept);
      entry.events = mark > 0 ? kept.slice(mark) : kept;
      try {
        this.writeHistory(projectId, mark > 0 ? kept.slice(0, mark) : []);
      } catch {
        // the live file below still holds what matters most
      }
    }
    for (const id of removed) {
      delete entry.summaries[id];
      if (entry.chain) delete entry.chain[id];
    }
    this.flushNow(projectId);
    return removed;
  }

  setPendingBrief(projectId: string, brief: string): void {
    this.load(projectId).pendingBrief = brief;
    this.scheduleWrite(projectId);
  }

  /** Claim the pending compaction brief (cleared once taken). */
  takePendingBrief(projectId: string): string | undefined {
    const entry = this.load(projectId);
    const brief = entry.pendingBrief;
    if (brief !== undefined) {
      delete entry.pendingBrief;
      this.scheduleWrite(projectId);
    }
    return brief;
  }

  /** Forget a removed project entirely (memory + file). */
  remove(projectId: string): void {
    this.data.delete(projectId);
    this.outlines.delete(projectId);
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    try {
      fs.rmSync(path.join(archiveDir(), `${projectId}.json`), { force: true });
      fs.rmSync(historyFile(projectId), { force: true });
    } catch {
      // best-effort
    }
  }

  /** Transcripts for a set of projects (used for the connect snapshot). */
  transcripts(projectIds: Iterable<string>): Record<string, TranscriptEvent[]> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.events(id)]));
  }

  /**
   * The last `count` events of each — what the connect snapshot carries.
   *
   * The snapshot used to carry every transcript whole: thirty chats, tens of
   * megabytes of JSON, serialised on every connect and held in the window's
   * memory for as long as it stayed open, when all but one of them showed
   * three lines on the Home board. A tail is enough for those lines; a chat
   * gets its whole history when it is opened (`transcript_get`).
   */
  tails(projectIds: Iterable<string>, count: number): Record<string, TranscriptEvent[]> {
    return Object.fromEntries(
      [...projectIds].map((id) => {
        const events = this.events(id);
        return [id, events.length > count ? events.slice(-count) : events];
      }),
    );
  }

  /** Recall notes for the wire, both halves apart — a folded exchange shows
   *  the prompt's in a bubble and the reply's under it. */
  allSummaries(projectIds: Iterable<string>): Record<string, Record<string, TurnNote>> {
    return Object.fromEntries(
      [...projectIds].map((id) => [
        id,
        Object.fromEntries(
          Object.entries(this.summaries(id))
            .map(([turnId, note]) => [turnId, wireNote(note)] as const)
            .filter(([, note]) => note.user !== undefined || note.reply !== undefined),
        ),
      ]),
    );
  }

  flushAll(): void {
    for (const [projectId, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(projectId);
      this.flush(projectId);
    }
  }
}
