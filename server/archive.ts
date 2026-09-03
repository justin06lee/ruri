import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * Per-project session archive: the single source of truth for transcripts,
 * turn summaries, and the resumable Claude session id — persisted under
 * ~/.config/ruri/sessions/<projectId>.json so nothing is lost across app
 * restarts and compaction can be instant (summaries are precomputed).
 */

/** A turn's recall notes: the prompt's and the reply's, each written by the
 *  small model the moment its half exists. */
export interface TurnSummary {
  user?: string;
  reply?: string;
}

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

/** Collapse a turn's two notes into the single fold-note string the UI shows. */
function displaySummary(note: TurnSummary | undefined): string {
  const user = note?.user?.trim();
  const reply = note?.reply?.trim();
  if (user && reply) return `${user} — ${reply}`;
  return user || reply || "";
}

function archiveDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "sessions",
  );
}

const WRITE_DELAY_MS = 500;

export class SessionArchive {
  private readonly data = new Map<string, ArchiveData>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

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
    this.data.set(projectId, entry);
    return entry;
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
      fs.writeFileSync(
        path.join(archiveDir(), `${projectId}.json`),
        JSON.stringify(entry, null, 2),
      );
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

  /** A turn's fold note for the UI: "prompt — reply", whichever halves exist. */
  summaryDisplay(projectId: string, turnId: string): string {
    return displaySummary(this.load(projectId).summaries[turnId]);
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
    this.scheduleWrite(projectId);
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
    if (start === -1) return [];
    const removed = entry.events.splice(start).map((e) => e.id);
    for (const id of removed) {
      delete entry.summaries[id];
      if (entry.chain) delete entry.chain[id];
    }
    this.scheduleWrite(projectId);
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
    const timer = this.timers.get(projectId);
    if (timer) clearTimeout(timer);
    this.timers.delete(projectId);
    try {
      fs.rmSync(path.join(archiveDir(), `${projectId}.json`), { force: true });
    } catch {
      // best-effort
    }
  }

  /** Transcripts for a set of projects (used for the connect snapshot). */
  transcripts(projectIds: Iterable<string>): Record<string, TranscriptEvent[]> {
    return Object.fromEntries([...projectIds].map((id) => [id, this.events(id)]));
  }

  /** Fold notes for the connect snapshot — the wire keeps single strings. */
  allSummaries(projectIds: Iterable<string>): Record<string, Record<string, string>> {
    return Object.fromEntries(
      [...projectIds].map((id) => [
        id,
        Object.fromEntries(
          Object.entries(this.summaries(id))
            .map(([turnId, note]) => [turnId, displaySummary(note)])
            .filter(([, display]) => display !== ""),
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
