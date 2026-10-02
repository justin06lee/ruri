import type { ServerContext } from "./context.js";
import { HOME_ID } from "./manager.js";
import {
  assembleTurns,
  smallModelEnabled,
  summarizePrompt,
  summarizeReply,
  type Turn,
} from "./smallmodel.js";
import { warn } from "./log.js";

/** Store one half of a turn's recall note and push the turn's notes. */
export function noteSummary(
  ctx: ServerContext,
  projectId: string,
  turnId: string,
  part: "user" | "reply",
  note: string,
): void {
  ctx.archive.setSummary(projectId, turnId, part, note);
  ctx.clients.broadcast({
    type: "turn_summary",
    projectId,
    turnId,
    note: ctx.archive.note(projectId, turnId),
  });
  // an exchange just got its last note: the list may be past its cap
  if (part === "reply") void ctx.digests.run(projectId);
}

/**
 * Recall notes the small model never wrote, written now, in the
 * background. A note goes missing whenever the small model can't answer
 * (its subscription out of quota, the machine offline, the app quit
 * mid-call), and a missing note used to stay missing: the folded
 * exchanges above a compaction and every later brief fell back to a raw
 * cut of the text — and a chat opened before its notes were written
 * showed that cut, then swapped to the notes a few seconds later. So the
 * whole backlog is worked through right after launch, and again hourly
 * (after the first run there's nothing left, so that costs nothing); a
 * chat that opens or compacts jumps the queue. NOTE_WORKERS calls run at
 * once. A half the model answered with nothing usable is kept as "" and
 * not asked for again; three failures in a row end the run until the
 * next thing starts one.
 */
export interface NoteJob {
  channelId: string;
  turn: Turn;
  part: "user" | "reply";
  key: string;
}
const NOTE_WORKERS = 3;

/** The backfill's own state: the jobs waiting, and how the run is going. */
/** How long a turn's notes are left to the live path before a pass looks. */
const NOTE_GRACE_MS = 2 * 60_000;

export class NoteBackfill {
  readonly jobs: NoteJob[] = [];
  /** Jobs queued or in flight, by channel:turn:part — never twice at once. */
  readonly keys = new Set<string>();
  workers = 0;
  misses = 0;
}

/**
 * Chats found with every note in place, and how each stood then. Looking
 * for missing notes reads a chat's whole history — its earlier file too,
 * up to megabytes, on the main thread — and the hourly pass looked at
 * every chat to find, nearly always, nothing. One already found whole is
 * looked at again only once it has moved on.
 */
const whole = new Map<string, string>();

/** Where a chat stands: its live events and its notes, as counted cheaply. */
function standing(ctx: ServerContext, channelId: string): string {
  const events = ctx.archive.events(channelId);
  return `${events.length}:${events.at(-1)?.id ?? ""}:${Object.keys(ctx.archive.summaries(channelId)).length}`;
}

export function backfillNotes(
  ctx: ServerContext,
  channelIds: Iterable<string>,
  opts: { first?: boolean } = {},
): void {
  if (!smallModelEnabled()) return;
  const fresh: NoteJob[] = [];
  for (const channelId of channelIds) {
    if (channelId === HOME_ID) continue;
    const stands = standing(ctx, channelId);
    if (whole.get(channelId) === stands) continue;
    const missing = missingNotes(ctx, channelId);
    // a turn younger than the live notes' grace may still be missing one
    // that is on its way, so a chat is only taken as whole once it is older
    const newest = ctx.archive.events(channelId).at(-1)?.ts ?? 0;
    if (missing.length === 0 && newest < Date.now() - NOTE_GRACE_MS) whole.set(channelId, stands);
    else whole.delete(channelId);
    for (const { turn, part } of missing) {
      const key = `${channelId}:${turn.turnId}:${part}`;
      if (ctx.notes.keys.has(key)) {
        // already waiting: a chat on screen pulls its own to the front
        const at = opts.first ? ctx.notes.jobs.findIndex((job) => job.key === key) : -1;
        if (at !== -1) fresh.push(...ctx.notes.jobs.splice(at, 1));
        continue;
      }
      ctx.notes.keys.add(key);
      fresh.push({ channelId, turn, part, key });
    }
  }
  if (opts.first) ctx.notes.jobs.unshift(...fresh);
  else ctx.notes.jobs.push(...fresh);
  // something new asked: the models get a fresh chance
  ctx.notes.misses = 0;
  while (ctx.notes.workers < NOTE_WORKERS && ctx.notes.jobs.length > 0) void noteWorker(ctx);
}

export async function noteWorker(ctx: ServerContext): Promise<void> {
  ctx.notes.workers += 1;
  try {
    while (ctx.notes.jobs.length > 0 && ctx.notes.misses < 3) {
      const job = ctx.notes.jobs.shift()!;
      try {
        // a chat closed meanwhile, or a note the live path wrote first
        if (!ctx.store.sessionIds().includes(job.channelId)) continue;
        if (ctx.archive.summaries(job.channelId)[job.turn.turnId]?.[job.part] !== undefined) continue;
        const note =
          job.part === "user" ? await summarizePrompt(job.turn.user) : await summarizeReply(job.turn);
        ctx.notes.misses = 0;
        // a rewind may have taken the turn while its note was written
        if (!turnStands(ctx, job.channelId, job.turn.turnId)) continue;
        if (note) noteSummary(ctx, job.channelId, job.turn.turnId, job.part, note);
        else ctx.archive.setSummary(job.channelId, job.turn.turnId, job.part, "");
      } catch (err) {
        warn("server", err, "noteWorker");
        ctx.notes.misses += 1;
      } finally {
        ctx.notes.keys.delete(job.key);
      }
    }
    if (ctx.notes.misses >= 3) {
      for (const job of ctx.notes.jobs) ctx.notes.keys.delete(job.key);
      ctx.notes.jobs.length = 0;
    }
  } finally {
    ctx.notes.workers -= 1;
  }
}

/** A chat's missing note halves, newest first — the ones nearest the
 *  bottom of the chat are the ones looked at. */
export function missingNotes(
  ctx: ServerContext,
  channelId: string,
): Array<{ turn: Turn; part: "user" | "reply" }> {
  const notes = ctx.archive.summaries(channelId);
  // anything this young is still being noted live
  const settled = Date.now() - NOTE_GRACE_MS;
  const jobs: Array<{ turn: Turn; part: "user" | "reply" }> = [];
  for (const { turn, ts, finished } of assembleTurns(ctx.archive.allEvents(channelId)).reverse()) {
    if (ts > settled) continue;
    const note = notes[turn.turnId];
    if (note?.user === undefined && turn.user.trim()) jobs.push({ turn, part: "user" });
    if (note?.reply === undefined && finished && turn.assistant.trim()) jobs.push({ turn, part: "reply" });
  }
  return jobs;
}

export function turnStands(ctx: ServerContext, channelId: string, turnId: string): boolean {
  return (
    ctx.archive.events(channelId).some((event) => event.id === turnId) ||
    ctx.archive.earlier(channelId).some((item) => item.kind === "turn" && item.turnId === turnId)
  );
}
