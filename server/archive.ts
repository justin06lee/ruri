import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { writeJsonAtomic, writeTextAtomic, writeTextAtomicAsync } from "./atomic.js";
import { configPath } from "./configDir.js";
import {
  excerpt,
  keepRecent,
  unmarked,
  type EarlierItem,
  type TranscriptEvent,
  type TurnNote,
} from "../shared/protocol.js";
import { settleAgent } from "./agents.js";
import type { Digest } from "./compaction.js";
import { isMissing, warn } from "./log.js";

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

/**
 * The harness a session id belongs to. Claude's are bare uuids; every other
 * harness's are kept as "<provider>:<its own id>" (server/sessions.ts), so
 * the prefix says whose it is.
 */
export function harnessOfSession(sessionId: string): string {
  const colon = sessionId.indexOf(":");
  return colon === -1 ? "claude" : sessionId.slice(0, colon);
}

/**
 * A chat's session on one harness.
 *
 * A chat can move between harnesses as often as its model does — Claude,
 * then Codex for a turn, then OpenCode, then back — and each harness keeps
 * a conversation of its own that only it can resume. So the chat keeps one
 * of these per harness it has run on, and a switch back picks up the
 * session that harness already had rather than starting it over; what
 * happened on the others while it was away goes to it as a catch-up
 * (server/handoff.ts).
 *
 * What a session holds is told by two exchanges, each named by its prompt's
 * event id. `seen` is the newest it is known to hold: a turn it ran on it
 * ended, so the prompt and whatever brief rode with it are in its own
 * record. `sent` is the newest that went to it at all, taken up or not. The
 * catch-up counts from `seen`, so a turn that never finished is told again
 * rather than assumed (telling a session twice costs a few tokens; telling
 * it nothing costs the conversation); a rewind counts from `sent`, so a
 * session that may hold an exchange the rewind took out is let go of.
 */
export interface HarnessSession {
  /** Unset while a fresh session has been sent its first prompt but has not
   *  said what it is called — a start that may yet fail. */
  session?: string;
  seen?: string;
  sent?: string;
}

interface ArchiveData {
  events: TranscriptEvent[];
  /** Turn summaries keyed by the turn's opening user-event id. */
  summaries: Record<string, TurnSummary>;
  /** The session the chat last ran on, whichever harness it is — the one
   *  of `harnesses` that is current. */
  lastSessionId?: string;
  /** The chat's session on each harness it has run on, keyed by harness
   *  ("claude", "codex", "opencode", …) — see HarnessSession. */
  harnesses?: Record<string, HarnessSession>;
  /** Every CLI session id this channel has ever run on (compaction and
   *  rewind move it along; the old ones stay ruri's). What keeps a chat
   *  ruri made from being offered back to it as somebody else's. */
  sessionIds?: string[];
  /** A finished compaction's brief, waiting to ride the next prompt into the
   *  fresh session (persisted so a restart in between loses nothing). */
  pendingBrief?: string;
  /** The conversation's oldest exchanges, condensed by the small model, and
   *  the last of them — what a brief opens with instead of listing them
   *  (see server/compaction.ts). */
  digest?: Digest;
  /** SDK chain uuids per turn (keyed by the opening user-event id): the
   *  prompt's own uuid (`user` — the file-rewind target) and the turn's
   *  latest chain uuid (`last` — the fork point when rewinding PAST it) —
   *  and the harness whose ids they are, since a chat that moved between
   *  harnesses has a chain in each and a fork point is only good in its own. */
  chain?: Record<string, ChainEntry>;
  /** A rewind's fork point: the next Claude session resumes truncated at
   *  `uuid` — a message in `session`'s transcript, and in no other. The
   *  session it belongs to is part of it: a bare uuid outlived the session
   *  it named (a /compact moves the chat to a new one) and was handed to
   *  the next, which fails every resume with "No message found with
   *  message.uuid". */
  resumeAt?: { session: string; uuid: string };
  /** The next session forks `forkNext` (a session id) at its tip — a chat
   *  forked at its latest exchange shares the file up to there and then
   *  goes its own way, leaving the original's file alone. */
  forkNext?: string;
  /** Tokens in the window after the channel's last API call. Persisted so the
   *  context gauge reads the real occupancy on launch instead of zero until
   *  the next turn happens to refill it. */
  contextTokens?: number;
  /** The occupancy as each turn left it, keyed by the turn's opening
   *  user-event id — what the context was once that exchange was over, and
   *  so what it is again when a rewind or a fork goes back to it. */
  contextAt?: Record<string, number>;
  /** The context window that channel's harness reported for its model —
   *  Codex names its own, and it is not one of Claude's two sizes. */
  contextWindow?: number;
  /** Which model that window belongs to. A reported window is only true of
   *  the model that reported it: a channel switched to Codex for one turn
   *  and switched back must not go on measuring Claude against Codex's
   *  window, which is what pinned the context dragon full. */
  contextWindowModel?: string;
}

/** One turn's place in its harness's own record (ArchiveData.chain). An entry
 *  from before they said which harness is taken to be anyone's. */
export interface ChainEntry {
  user?: string;
  last?: string;
  harness?: string;
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
      open = {
        kind: "turn",
        turnId: event.id,
        prompt: excerpt(event.text, PROMPT_EXCERPT),
        reply: "",
        count: 1,
        ts: event.ts,
      };
      items.push(open);
    } else if (open) {
      open.count += 1;
      if (event.kind === "assistant" && event.text.trim()) reply = event.text;
    }
  }
  if (open) open.reply = excerpt(unmarked(reply), REPLY_EXCERPT);
  return items;
}

/** A stored per-harness map, kept only where it has the shape it should. */
function readHarnesses(raw: unknown): Record<string, HarnessSession> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, HarnessSession> = {};
  for (const [harness, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const { session, seen, sent } = value as Record<string, unknown>;
    out[harness] = {
      ...(typeof session === "string" ? { session } : {}),
      ...(typeof seen === "string" ? { seen } : {}),
      ...(typeof sent === "string" ? { sent } : {}),
    };
  }
  return out;
}

function archiveDir(): string {
  return configPath("sessions");
}

function historyDir(): string {
  return configPath("history");
}

function historyFile(projectId: string): string {
  return path.join(historyDir(), `${projectId}.jsonl`);
}

/** How big a channel's history may grow before its oldest exchanges go. */
/** How much of the history file is held in hand at a time while it is
 *  read. Large enough that the syscalls are few, small enough that the
 *  file's own size never becomes the process's. */
const HISTORY_CHUNK = 256 * 1024;

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
  /** Per channel, moved on by every flush — how a slower write knows a
   *  newer one has passed it (see flush). */
  private readonly generations = new Map<string, number>();
  /** Channels with a write in the air. */
  private readonly inflight = new Set<string>();
  /** Channels that keep only their newest events (Home), and how many. */
  private readonly caps = new Map<string, number>();
  private readonly outlines = new Map<string, { size: number; mtimeMs: number; items: EarlierItem[] }>();
  /**
   * Where each of a channel's live events sits, by id.
   *
   * Adding an event used to scan the whole live transcript for its id
   * first — which is O(the conversation) per event, so a busy turn's
   * hundredth event cost a hundred times its first, and a subagent's card
   * moving along paid the same on every step. The map is built when a
   * channel is first touched and dropped whenever anything moves the
   * events about (a trim, a fold, a rewind), to be built again on demand.
   */
  private readonly places = new Map<string, Map<string, number>>();
  /** Every harness session id ruri has run, to the chat it belongs to —
   *  built on demand and dropped whenever one is recorded or forgotten
   *  (see channelOfSession). */
  private owners: Map<string, string> | undefined;
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
    this.restack(projectId);
    for (const event of dropped) {
      delete entry.summaries[event.id];
      if (entry.chain) delete entry.chain[event.id];
    }
    return true;
  }

  /** Forget where this channel's events sit: something moved them. */
  private restack(projectId: string): void {
    this.places.delete(projectId);
  }

  /** Where each event sits, built if it is not already known. */
  private placesOf(projectId: string, events: TranscriptEvent[]): Map<string, number> {
    let at = this.places.get(projectId);
    if (at === undefined) {
      at = new Map();
      for (let i = 0; i < events.length; i++) at.set(events[i]!.id, i);
      this.places.set(projectId, at);
    }
    return at;
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
        // an agent card still running on disk belonged to a process that
        // ended with the last run: it was stopped, whatever it last said
        events: Array.isArray(raw.events) ? raw.events.map(settleAgent) : [],
        summaries,
        ...(typeof raw.lastSessionId === "string" ? { lastSessionId: raw.lastSessionId } : {}),
        ...(Array.isArray(raw.sessionIds)
          ? { sessionIds: raw.sessionIds.filter((id) => typeof id === "string") }
          : {}),
        ...(typeof raw.pendingBrief === "string" ? { pendingBrief: raw.pendingBrief } : {}),
        ...(raw.digest && typeof raw.digest.text === "string" && typeof raw.digest.through === "string"
          ? { digest: { text: raw.digest.text, through: raw.digest.through } }
          : {}),
        ...(raw.chain && typeof raw.chain === "object" ? { chain: raw.chain } : {}),
        // an anchor from before they named their session is dropped: nothing
        // says which session it belongs to, which is the bug they had
        ...(raw.resumeAt &&
        typeof raw.resumeAt === "object" &&
        typeof raw.resumeAt.session === "string" &&
        typeof raw.resumeAt.uuid === "string"
          ? { resumeAt: { session: raw.resumeAt.session, uuid: raw.resumeAt.uuid } }
          : {}),
        ...(typeof raw.forkNext === "string" ? { forkNext: raw.forkNext } : {}),
        ...(typeof raw.contextTokens === "number" ? { contextTokens: raw.contextTokens } : {}),
        ...(raw.contextAt && typeof raw.contextAt === "object" ? { contextAt: raw.contextAt } : {}),
        // an unattributed window is from before it was recorded whose it is
        // — it can't be checked against the current model, so it is dropped
        ...(typeof raw.contextWindow === "number" && typeof raw.contextWindowModel === "string"
          ? { contextWindow: raw.contextWindow, contextWindowModel: raw.contextWindowModel }
          : {}),
      };
      const harnesses = readHarnesses(raw.harnesses);
      if (harnesses) entry.harnesses = harnesses;
      else if (entry.lastSessionId) {
        // From before a chat kept a session per harness: the one it was on
        // is the one it has, and it has everything the transcript does —
        // it ran every turn since the chat last moved harness, and a move
        // then started it over with nothing, which is the bug this fixes.
        const newest = entry.events.findLast((event) => event.kind === "user")?.id;
        entry.harnesses = {
          [harnessOfSession(entry.lastSessionId)]: {
            session: entry.lastSessionId,
            ...(newest ? { seen: newest, sent: newest } : {}),
          },
        };
      }
    } catch (err) {
      if (!isMissing(err)) warn("archive", err, "load");
      entry = { events: [], summaries: {} };
    }
    this.trim(projectId, entry);
    this.data.set(projectId, entry);
    // a channel this run had not seen before brings its session ids with it
    this.owners = undefined;
    // an archive from before the history carries every compaction's past
    // inline — moved out once, here, and the smaller file written at once
    if (this.fold(projectId, entry)) void this.flush(projectId);
    return entry;
  }

  /* ── the history ─────────────────────────────────────────────────── */

  /** Everything before the live part, oldest first. Read from disk each
   *  time: it is never wanted on the hot path. */
  history(projectId: string): TranscriptEvent[] {
    return this.readHistory(projectId).events;
  }

  /**
   * The history file, a line at a time.
   *
   * It used to be read whole and then split: a sixteen-megabyte string and
   * an array of every line in it, both alive at once and both thrown away
   * immediately, on top of the events they were read to make. Here the file
   * goes past in chunks and each line is turned into its event and let go,
   * so the only thing that grows is the answer.
   *
   * Each line's size on disk comes back with it, which is what the cap
   * measures against — measuring used to mean serialising every event in
   * the history a second time, just to count its characters.
   */
  private readHistory(projectId: string): { events: TranscriptEvent[]; bytes: number[] } {
    const events: TranscriptEvent[] = [];
    const bytes: number[] = [];
    let handle: number;
    try {
      handle = fs.openSync(historyFile(projectId), "r");
    } catch (err) {
      if (!isMissing(err)) warn("archive", err, "history");
      return { events, bytes };
    }
    const take = (line: string): void => {
      if (!line) return;
      try {
        events.push(settleAgent(JSON.parse(line) as TranscriptEvent));
        bytes.push(Buffer.byteLength(line) + 1);
      } catch (err) {
        if (!(err instanceof SyntaxError)) warn("archive", err, "history");
        // a line torn by a crash mid-append
      }
    };
    const chunk = Buffer.allocUnsafe(HISTORY_CHUNK);
    const decoder = new StringDecoder("utf8");
    let held = "";
    try {
      for (;;) {
        const read = fs.readSync(handle, chunk, 0, chunk.length, null);
        if (read === 0) break;
        held += decoder.write(chunk.subarray(0, read));
        let from = 0;
        for (;;) {
          const stop = held.indexOf("\n", from);
          if (stop === -1) break;
          take(held.slice(from, stop));
          from = stop + 1;
        }
        if (from > 0) held = held.slice(from);
      }
      held += decoder.end();
      take(held);
    } catch (err) {
      warn("archive", err, "history");
    } finally {
      try {
        fs.closeSync(handle);
      } catch {
        // already gone
      }
    }
    return { events, bytes };
  }

  /** The history's outline (see `outline`), kept while its file is unchanged
   *  — every opening of a chat asks for it, and the file changes only when
   *  a compaction, a rewind or the cap rewrites it. */
  earlier(projectId: string): EarlierItem[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(historyFile(projectId));
    } catch (err) {
      if (!isMissing(err)) warn("archive", err, "earlier");
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
    } catch (err) {
      if (!isMissing(err)) warn("archive", err, "hasHistory");
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
    this.restack(projectId);
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      const have = this.hasHistory(projectId)
        ? new Set(this.history(projectId).map((event) => event.id))
        : new Set<string>();
      const fresh = moved.filter((event) => !have.has(event.id));
      if (fresh.length > 0) {
        fs.appendFileSync(
          historyFile(projectId),
          fresh.map((event) => JSON.stringify(event)).join("\n") + "\n",
        );
      }
      this.capHistory(projectId, entry);
    } catch (err) {
      warn("archive", err, "fold");
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
    } catch (err) {
      if (!isMissing(err)) warn("archive", err, "capHistory");
      return;
    }
    if (size <= this.historyMax) return;
    const { events, bytes } = this.readHistory(projectId);
    const budget = this.historyMax * HISTORY_TRIM_TO;
    let used = 0;
    let start = events.length;
    for (let i = events.length - 1; i >= 0; i--) {
      const size = bytes[i] ?? 0;
      if (used + size > budget) break;
      used += size;
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
    writeTextAtomic(file, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  }

  /** Write the live file now, on this thread, rather than on the debounce:
   *  a compaction or a rewind wants the file and the memory to agree the
   *  moment it returns. */
  private flushNow(projectId: string): void {
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    this.writeLive(projectId);
  }

  /** The synchronous write. Taking the number moves any flush still in the
   *  air on to discard its bytes, so it cannot land over this one. */
  private writeLive(projectId: string): void {
    const entry = this.data.get(projectId);
    if (!entry) return;
    this.generations.set(projectId, (this.generations.get(projectId) ?? 0) + 1);
    this.inflight.delete(projectId);
    try {
      writeJsonAtomic(path.join(archiveDir(), `${projectId}.json`), entry);
    } catch (err) {
      warn("archive", err, "writeLive");
    }
  }

  private scheduleWrite(projectId: string): void {
    if (this.timers.has(projectId)) return;
    this.timers.set(
      projectId,
      setTimeout(() => {
        this.timers.delete(projectId);
        void this.flush(projectId);
      }, WRITE_DELAY_MS),
    );
  }

  /**
   * The live file, written off the main thread. Two flushes of one file
   * never interleave: each takes a number on the way in, and a write that
   * finds a newer number by the time its bytes are down discards them —
   * the newer flush carries everything this one did. The rename itself is
   * synchronous (atomic.ts), so that check and the rename are one step.
   */
  private async flush(projectId: string): Promise<void> {
    const entry = this.data.get(projectId);
    if (!entry) return;
    const generation = (this.generations.get(projectId) ?? 0) + 1;
    this.generations.set(projectId, generation);
    this.inflight.add(projectId);
    try {
      // Compact: nobody reads these by eye, and the indentation was a third
      // of every file and of every write.
      await writeTextAtomicAsync(
        path.join(archiveDir(), `${projectId}.json`),
        JSON.stringify(entry),
        () => this.generations.get(projectId) !== generation,
      );
    } catch (err) {
      warn("archive", err, "flush");
      // persistence is best-effort; in-memory state stays correct
    } finally {
      if (this.generations.get(projectId) === generation) this.inflight.delete(projectId);
    }
  }

  events(projectId: string): TranscriptEvent[] {
    return this.load(projectId).events;
  }

  append(projectId: string, event: TranscriptEvent): void {
    const entry = this.load(projectId);
    const events = entry.events;
    const at = this.placesOf(projectId, events);
    const existing = at.get(event.id);
    if (existing === undefined) {
      at.set(event.id, events.length);
      events.push(event);
    } else events[existing] = event;
    this.trim(projectId, entry);
    // a compaction mark: everything before it moves to the history, and
    // the live file shrinks to the mark — written at once, so the two agree
    if (event.kind === "compaction" && this.fold(projectId, entry)) {
      this.flushNow(projectId);
      return;
    }
    this.scheduleWrite(projectId);
  }

  /** Replace an event still in the live transcript — a subagent's card
   *  moving along. One already folded into the history, or removed, is
   *  left there: an update is never a reason to bring it back. */
  replace(projectId: string, event: TranscriptEvent): boolean {
    const events = this.load(projectId).events;
    const at = this.placesOf(projectId, events).get(event.id);
    if (at === undefined) return false;
    events[at] = event;
    this.scheduleWrite(projectId);
    return true;
  }

  /** Remove one event; a user event takes the rest of its turn (everything
   *  up to the next user/compaction event) with it. Returns removed ids. */
  removeTurn(projectId: string, eventId: string): string[] {
    const entry = this.load(projectId);
    const start = this.placesOf(projectId, entry.events).get(eventId) ?? -1;
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
    this.restack(projectId);
    delete entry.summaries[eventId];
    // the digest ended on this exchange: with it gone there is no telling
    // where the digest stops, so it is folded again from the start
    if (entry.digest?.through === eventId) delete entry.digest;
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

  /** Put the reading down against the turn in flight — the newest prompt.
   *  The last one a turn makes is where it left the context. */
  noteTurnContext(projectId: string, tokens: number): void {
    const entry = this.load(projectId);
    const turn = entry.events.findLast((event) => event.kind === "user");
    if (!turn) return;
    (entry.contextAt ??= {})[turn.id] = tokens;
    this.scheduleWrite(projectId);
  }

  /** How full the context was once this exchange was over, if a reading
   *  was taken then. */
  contextAfter(projectId: string, turnId: string): number | undefined {
    return this.load(projectId).contextAt?.[turnId];
  }

  /** Each model's window as these channels' turns last reported it — the
   *  larger, where two chats on one model disagree. What a relaunch knows
   *  of a model before any chat has run a turn on it this time. */
  reportedWindows(projectIds: Iterable<string>): Map<string, number> {
    const windows = new Map<string, number>();
    for (const id of projectIds) {
      const { contextWindow: window, contextWindowModel: model } = this.load(id);
      if (window && model && window > (windows.get(model) ?? 0)) windows.set(model, window);
    }
    return windows;
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

  /**
   * A session reported its id: it is the chat's current session, and its
   * harness's. A new id on a harness — a fork a rewind asked for, a fresh
   * start — carries what the old one held (a fork holds it all; a fresh
   * start's entry was dropped before it began, so there is nothing to
   * carry), and settles the fork point or tip fork that was waiting for
   * it: that fork has now been made.
   *
   * Written at once when anything changed, rather than on the debounce: the
   * id is how the conversation is found again, and a quit or a crash in the
   * second after a session starts used to leave the chat on disk with the
   * brief its first prompt carried already spent and no session to show
   * for it.
   */
  setLastSessionId(projectId: string, sessionId: string): void {
    const entry = this.load(projectId);
    this.owners = undefined;
    const harness = harnessOfSession(sessionId);
    const had = entry.harnesses?.[harness];
    const changed = entry.lastSessionId !== sessionId || had?.session !== sessionId;
    entry.lastSessionId = sessionId;
    entry.harnesses = { ...entry.harnesses, [harness]: { ...had, session: sessionId } };
    if (had?.session !== undefined && had.session !== sessionId) {
      if (entry.resumeAt?.session === had.session) delete entry.resumeAt;
      if (entry.forkNext === had.session) delete entry.forkNext;
    }
    entry.sessionIds ??= [];
    if (!entry.sessionIds.includes(sessionId)) entry.sessionIds = [...entry.sessionIds.slice(-59), sessionId];
    if (changed) this.flushNow(projectId);
    else this.scheduleWrite(projectId);
  }

  /** The chat's session on a harness, and what it holds. */
  harnessSession(projectId: string, harness: string): Readonly<HarnessSession> | undefined {
    return this.load(projectId).harnesses?.[harness];
  }

  /** Every harness the chat has a session on. */
  harnessSessions(projectId: string): Readonly<Record<string, HarnessSession>> {
    return this.load(projectId).harnesses ?? {};
  }

  /** The session a build on this harness resumes, if the chat has one. */
  sessionOn(projectId: string, harness: string): string | undefined {
    return this.load(projectId).harnesses?.[harness]?.session;
  }

  /** A prompt (its event id) is going to the chat's session on a harness —
   *  a fresh one, when the chat has none there yet. The exchange is marked
   *  as that harness's in the chain, which is how a rewind later tells
   *  which harness ran what. */
  noteSent(projectId: string, harness: string, eventId: string): void {
    const entry = this.load(projectId);
    entry.harnesses = { ...entry.harnesses, [harness]: { ...entry.harnesses?.[harness], sent: eventId } };
    entry.chain ??= {};
    const at = (entry.chain[eventId] ??= {});
    if (at.harness !== harness) {
      delete at.user;
      delete at.last;
      at.harness = harness;
    }
    this.scheduleWrite(projectId);
  }

  /**
   * After a rewind: the session on `harness` holds the conversation through
   * `seen` and no further (a fork taken back to there). Unset: it holds
   * nothing that can be placed, and is told everything next time.
   */
  rewoundTo(projectId: string, harness: string, seen: string | undefined): void {
    const entry = this.load(projectId);
    const had = entry.harnesses?.[harness];
    if (!had) return;
    const { seen: _seen, sent: _sent, ...rest } = had;
    entry.harnesses = { ...entry.harnesses, [harness]: { ...rest, ...(seen ? { seen, sent: seen } : {}) } };
    this.flushNow(projectId);
  }

  /** A turn on `sessionId` ended, the prompt `eventId` in it: that session
   *  holds the conversation through there. A session the chat has since
   *  let go of (or never had) has no say. */
  noteSeen(projectId: string, sessionId: string, eventId: string): void {
    const entry = this.load(projectId);
    const harness = harnessOfSession(sessionId);
    const had = entry.harnesses?.[harness];
    if (had?.session !== sessionId) return;
    if (had.seen === eventId && had.sent !== undefined) return;
    entry.harnesses = { ...entry.harnesses, [harness]: { ...had, seen: eventId, sent: had.sent ?? eventId } };
    this.scheduleWrite(projectId);
  }

  /**
   * A session that holds exactly the conversation as it stands, through
   * `seen` — a fork's copy of its source, an imported chat's own session.
   */
  adoptSession(projectId: string, sessionId: string, seen: string | undefined): void {
    this.setLastSessionId(projectId, sessionId);
    const entry = this.load(projectId);
    const harness = harnessOfSession(sessionId);
    entry.harnesses = {
      ...entry.harnesses,
      [harness]: { session: sessionId, ...(seen ? { seen, sent: seen } : {}) },
    };
    this.flushNow(projectId);
  }

  /**
   * Let go of the chat's session on one harness: the next prompt there
   * starts afresh, briefed. A fork point or tip fork waiting in that session
   * goes with it, and the chat's current session too when it was that one.
   * The others are untouched — a Claude session that has gone missing says
   * nothing about the chat's Codex thread.
   */
  dropHarness(projectId: string, harness: string): void {
    const entry = this.load(projectId);
    const had = entry.harnesses?.[harness];
    if (entry.harnesses) {
      const { [harness]: _gone, ...rest } = entry.harnesses;
      entry.harnesses = rest;
    }
    const mine = (id: string | undefined) =>
      id !== undefined && (harnessOfSession(id) === harness || id === had?.session);
    if (mine(entry.lastSessionId)) delete entry.lastSessionId;
    if (mine(entry.resumeAt?.session)) delete entry.resumeAt;
    if (mine(entry.forkNext)) delete entry.forkNext;
    this.flushNow(projectId);
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

  /**
   * Whose a harness session id is.
   *
   * A running harness is told on its command line which session to resume,
   * and every session id a chat has ever run on is recorded here — so a
   * process on this machine can be traced back to the conversation it is
   * having (server/resources.ts). Built from what is already loaded and
   * from the ids on disk, and kept until a channel records a new one.
   */
  channelOfSession(sessionId: string): string | undefined {
    if (this.owners === undefined) {
      this.owners = new Map();
      for (const [channelId, entry] of this.data) {
        if (entry.lastSessionId) this.owners.set(entry.lastSessionId, channelId);
        for (const id of entry.sessionIds ?? []) this.owners.set(id, channelId);
      }
    }
    return this.owners.get(sessionId);
  }

  /** Forget every resumable session, on every harness — the next send
   *  starts a fresh one wherever it goes (a /compact), and a fork point
   *  pending in the old ones goes with them. */
  clearLastSessionId(projectId: string): void {
    const entry = this.load(projectId);
    delete entry.lastSessionId;
    delete entry.harnesses;
    delete entry.resumeAt;
    delete entry.forkNext;
    this.flushNow(projectId);
  }

  /** Record a turn's SDK chain uuid (see ArchiveData.chain), and whose. */
  setChain(projectId: string, eventId: string, kind: "user" | "last", uuid: string, harness?: string): void {
    const entry = this.load(projectId);
    entry.chain ??= {};
    const at = (entry.chain[eventId] ??= {});
    // a turn's ids are one harness's: a prompt that went again elsewhere
    // (a lost session's resend) starts its entry over
    if (harness && at.harness && at.harness !== harness) {
      delete at.user;
      delete at.last;
    }
    at[kind] = uuid;
    if (harness) at.harness = harness;
    this.scheduleWrite(projectId);
  }

  chain(projectId: string): Record<string, ChainEntry> {
    return this.load(projectId).chain ?? {};
  }

  /** A rewind's fork point: `uuid`, in `session`'s transcript. */
  setResumeAt(projectId: string, session: string, uuid: string): void {
    this.load(projectId).resumeAt = { session, uuid };
    this.flushNow(projectId);
  }

  /**
   * The pending rewind fork point for a session about to resume `resumeId`
   * — handed over only when it is that session's: a point in any other
   * session's transcript is one its harness can't find.
   *
   * It stays where it is until the fork has been made. It used to be taken
   * the moment a session was built, whatever came of the build — so a build
   * on another harness (the chat switched model after the rewind), or a
   * start that a quit or a crash cut off before the fork was written, spent
   * it, and the next build resumed the old session at its tip: every
   * exchange the rewind took out, back in the model's memory. Now the fork's
   * own new session id settles it (setLastSessionId), and letting go of its
   * session takes it too (dropHarness, clearLastSessionId).
   */
  resumeAtFor(projectId: string, resumeId: string | undefined): string | undefined {
    const at = this.load(projectId).resumeAt;
    return at !== undefined && resumeId !== undefined && at.session === resumeId ? at.uuid : undefined;
  }

  /** The next session forks `session` at its tip. */
  setForkNext(projectId: string, session: string): void {
    this.load(projectId).forkNext = session;
    this.flushNow(projectId);
  }

  /** Whether a session about to resume `resumeId` is to fork it at its tip
   *  — kept, like resumeAtFor's point, until that fork has been made. */
  forkNextFor(projectId: string, resumeId: string | undefined): boolean {
    const session = this.load(projectId).forkNext;
    return session !== undefined && resumeId !== undefined && session === resumeId;
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
      chain: Record<string, ChainEntry>;
      contextTokens?: number;
      contextAt?: Record<string, number>;
      contextWindow?: number;
      contextWindowModel?: string;
    },
  ): void {
    const kept = new Set(from.events.map((e) => e.id));
    const entry: ArchiveData = {
      events: from.events.map((e) => ({ ...e })),
      summaries: Object.fromEntries(
        Object.entries(from.summaries)
          .filter(([id]) => kept.has(id))
          .map(([id, n]) => [id, { ...n }]),
      ),
      chain: Object.fromEntries(
        Object.entries(from.chain)
          .filter(([id]) => kept.has(id))
          .map(([id, c]) => [id, { ...c }]),
      ),
      ...(from.contextTokens !== undefined ? { contextTokens: from.contextTokens } : {}),
      ...(from.contextAt
        ? { contextAt: Object.fromEntries(Object.entries(from.contextAt).filter(([id]) => kept.has(id))) }
        : {}),
      ...(from.contextWindow !== undefined && from.contextWindowModel !== undefined
        ? { contextWindow: from.contextWindow, contextWindowModel: from.contextWindowModel }
        : {}),
    };
    this.data.set(projectId, entry);
    this.restack(projectId);
    this.owners = undefined;
    // a fork of a compacted conversation gets the same split: its own
    // history up to the newest mark, its live part from there
    try {
      this.writeHistory(projectId, []);
    } catch (err) {
      warn("archive", err, "seed");
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
      this.restack(projectId);
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
      this.restack(projectId);
      try {
        this.writeHistory(projectId, mark > 0 ? kept.slice(0, mark) : []);
      } catch (err) {
        warn("archive", err, "truncateFrom");
        // the live file below still holds what matters most
      }
    }
    for (const id of removed) {
      delete entry.summaries[id];
      if (entry.chain) delete entry.chain[id];
      if (entry.contextAt) delete entry.contextAt[id];
    }
    // rewound back past what the digest folded in: it remembers exchanges
    // that, as far as the conversation now goes, never happened
    if (entry.digest && removed.includes(entry.digest.through)) delete entry.digest;
    this.flushNow(projectId);
    return removed;
  }

  setPendingBrief(projectId: string, brief: string): void {
    this.load(projectId).pendingBrief = brief;
    this.scheduleWrite(projectId);
  }

  /** The conversation's condensed oldest exchanges, once it is long enough
   *  to have any. */
  digest(projectId: string): Digest | undefined {
    return this.load(projectId).digest;
  }

  setDigest(projectId: string, digest: Digest): void {
    this.load(projectId).digest = digest;
    this.scheduleWrite(projectId);
  }

  /** Every exchange's id, oldest first: the history's, off its outline
   *  (kept while the file is unchanged), then the live part's. Cheap enough
   *  to ask after every turn, which reading the history itself is not. */
  turnIds(projectId: string): string[] {
    const earlier = this.earlier(projectId).flatMap((item) => (item.kind === "turn" ? [item.turnId] : []));
    const live = this.load(projectId).events.flatMap((event) => (event.kind === "user" ? [event.id] : []));
    return earlier.length > 0 ? [...earlier, ...live] : live;
  }

  /** Whether a brief is waiting for the next prompt. */
  hasPendingBrief(projectId: string): boolean {
    return this.load(projectId).pendingBrief !== undefined;
  }

  /** The pending rewind fork point, left where it is. */
  resumePoint(projectId: string): { session: string; uuid: string } | undefined {
    return this.load(projectId).resumeAt;
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
    this.places.delete(projectId);
    this.owners = undefined;
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    try {
      fs.rmSync(path.join(archiveDir(), `${projectId}.json`), { force: true });
      fs.rmSync(historyFile(projectId), { force: true });
    } catch (err) {
      warn("archive", err, "remove");
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

  /** Everything pending, written now and on this thread: the process is
   *  going, and a write still in the air would go with it. */
  flushAll(): void {
    const due = new Set([...this.timers.keys(), ...this.inflight]);
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const projectId of due) this.writeLive(projectId);
  }
}
