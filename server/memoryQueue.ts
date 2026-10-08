import * as fs from "node:fs";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { exchangeRef, memoryStack, pushSheet, resolveRef } from "./catchupBrief.js";
import { configPath } from "./configDir.js";
import type { ServerContext } from "./context.js";
import { isMissing, warn } from "./log.js";
import { HOME_ID } from "./manager.js";
import { dayOf } from "./memoryLines.js";
import { foldTurns, outsideTool, turnMaterial, type Ask, type FoldTurn } from "./memoryFold.js";
import { linesWith, MemoryBook } from "./memoryLog.js";
import { projectRelative } from "./recall.js";
import { completeMemory, smallModelEnabled } from "./smallmodel.js";

/**
 * Every finished turn of every chat, folded into its project's memory.
 *
 * Folds used to gather a project's turns and run at most once every ten
 * minutes on the newest five — a sixth turn in the window was dropped
 * without a word, and so was every turn in a batch whose model call
 * failed. Ten agents in one project lost most of what they did. Now each
 * finished turn joins its project's queue, kept on disk
 * (memory/<project>.folds.json) so a quit loses nothing, and the queue is
 * worked through in order: a burst of turns waits a moment and goes
 * together, as many to a fold as fit (chunked by size, never by a count
 * that drops the rest), each read with what it changed — the files, and
 * the diff from its checkpoints. A fold whose model can't answer leaves
 * its turns waiting for the next try; only a turn the model has twice
 * answered with nothing usable is given up on, and counted.
 */

/** How long a queue waits after a turn joins it before it folds — so a
 *  burst of turns ending together is one fold. */
const FOLD_DELAY_MS = Number(process.env["RURI_FOLD_DELAY_MS"]) || 45_000;
/** How long after a failed fold it tries again, doubling to an hour. */
const RETRY_MS = 5 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** How much one fold reads, at most, and how many turns. */
const CHUNK_CHARS = 60_000;
const CHUNK_TURNS = 6;
/** A turn's diff, at most. */
const DIFF_BUDGET = 8_000;
/** Answers with nothing usable before a turn is given up on. */
const GIVE_UP_AFTER = 2;
/** Folds remembered, with the turns each read — `ruri memory log` names
 *  them. */
const FOLDS_KEPT = 300;

interface Waiting {
  chat: string;
  turn: string;
  at: number;
}

/** A project's queue, as it is kept on disk. */
interface QueueFile {
  pending: Waiting[];
  /** Every turn folded (or given up on), by chat. */
  folded: Record<string, string[]>;
  /** Turns the model answered with nothing usable, and how often. */
  failed: Record<string, number>;
  /** The turns given up on, by chat. */
  skipped: Record<string, string[]>;
  /** The folds run, newest last, with the refs of the turns each read. */
  folds: Array<{ id: string; at: number; turns: string[] }>;
}

function queueFile(projectId: string): string {
  return configPath("memory", `${projectId}.folds.json`);
}

function emptyQueue(): QueueFile {
  return { pending: [], folded: {}, failed: {}, skipped: {}, folds: [] };
}

/** The live state of every project's queue. */
export class FoldQueue {
  readonly queues = new Map<string, QueueFile>();
  readonly timers = new Map<string, NodeJS.Timeout>();
  readonly running = new Set<string>();
  readonly backoff = new Map<string, number>();
  /** Who answers a fold — the memory model, unless a test says otherwise. */
  ask: Ask = completeMemory;

  queue(projectId: string): QueueFile {
    let queue = this.queues.get(projectId);
    if (queue) return queue;
    try {
      const raw = JSON.parse(fs.readFileSync(queueFile(projectId), "utf8")) as Partial<QueueFile>;
      queue = {
        pending: Array.isArray(raw.pending) ? raw.pending : [],
        folded: raw.folded && typeof raw.folded === "object" ? raw.folded : {},
        failed: raw.failed && typeof raw.failed === "object" ? raw.failed : {},
        skipped: raw.skipped && typeof raw.skipped === "object" ? raw.skipped : {},
        folds: Array.isArray(raw.folds) ? raw.folds : [],
      };
    } catch (err) {
      if (!isMissing(err)) warn("memory", err, "FoldQueue.queue");
      queue = emptyQueue();
    }
    this.queues.set(projectId, queue);
    return queue;
  }

  save(projectId: string): void {
    const queue = this.queues.get(projectId);
    if (!queue) return;
    try {
      fs.mkdirSync(path.dirname(queueFile(projectId)), { recursive: true });
      writeJsonAtomic(queueFile(projectId), queue);
    } catch (err) {
      warn("memory", err, "FoldQueue.save");
    }
  }

  /** Whether a turn has been folded (or given up on). */
  folded(projectId: string, chat: string, turn: string): boolean {
    return this.queue(projectId).folded[chat]?.includes(turn) ?? false;
  }

  /** The refs of the turns a fold read, if it is one of the recent ones. */
  turnsOf(projectId: string, fold: string): string[] | undefined {
    return this.queue(projectId).folds.find((f) => f.id === fold)?.turns;
  }
}

/** A finished turn joins its project's queue; the queue folds shortly. */
export function enqueueFold(ctx: ServerContext, projectId: string, chat: string, turn: string): void {
  if (chat === HOME_ID || !smallModelEnabled()) return;
  const queue = ctx.folds.queue(projectId);
  const known =
    queue.pending.some((w) => w.chat === chat && w.turn === turn) || ctx.folds.folded(projectId, chat, turn);
  // a project with no memory yet reads its chats whole, these turns among them
  const fresh = !ctx.memory.view(projectId) && Object.keys(queue.folded).length === 0;
  if (fresh) {
    backfillFolds(ctx, projectId);
    return;
  }
  if (!known) {
    queue.pending.push({ chat, turn, at: Date.now() });
    ctx.folds.save(projectId);
  }
  schedule(ctx, projectId, FOLD_DELAY_MS);
}

/**
 * Every finished turn of every chat in the project that hasn't been folded,
 * queued oldest first — what a project with history and no memory does
 * once, and what "Read the chats" does on the page. Answers how many.
 */
export function backfillFolds(ctx: ServerContext, projectId: string): number {
  const project = ctx.store.get(projectId);
  if (!project || !smallModelEnabled()) return 0;
  const queue = ctx.folds.queue(projectId);
  const waiting = new Set(queue.pending.map((w) => `${w.chat}:${w.turn}`));
  const found: Waiting[] = [];
  for (const session of project.sessions) {
    for (const { turnId, ts } of finishedTurns(ctx.archive.allEvents(session.id))) {
      if (waiting.has(`${session.id}:${turnId}`) || ctx.folds.folded(projectId, session.id, turnId)) continue;
      found.push({ chat: session.id, turn: turnId, at: ts });
    }
  }
  found.sort((a, b) => a.at - b.at);
  queue.pending.push(...found);
  ctx.folds.save(projectId);
  if (found.length) {
    ctx.clients.broadcast({
      type: "recall",
      projectId,
      busy: true,
      note: `folding ${found.length} exchanges in…`,
    });
  }
  schedule(ctx, projectId, 0);
  return found.length;
}

/** How much of the project's finished work has been folded. */
export function foldCoverage(
  ctx: ServerContext,
  projectId: string,
): { folded: number; skipped: number; waiting: number; total: number } {
  const project = ctx.store.get(projectId);
  const queue = ctx.folds.queue(projectId);
  let total = 0;
  let folded = 0;
  for (const session of project?.sessions ?? []) {
    const done = new Set(queue.folded[session.id] ?? []);
    for (const { turnId } of finishedTurns(ctx.archive.allEvents(session.id))) {
      total += 1;
      if (done.has(turnId)) folded += 1;
    }
  }
  const skipped = Object.values(queue.skipped).reduce((n, list) => n + list.length, 0);
  return { folded, skipped, waiting: queue.pending.length, total };
}

/** The queues that had turns waiting when ruri last stopped, folding again. */
export function resumeFolds(ctx: ServerContext): void {
  for (const project of ctx.store.list()) {
    if (ctx.folds.queue(project.id).pending.length) schedule(ctx, project.id, FOLD_DELAY_MS);
  }
}

function schedule(ctx: ServerContext, projectId: string, delay: number): void {
  if (ctx.folds.timers.has(projectId) || ctx.folds.running.has(projectId)) return;
  const timer = setTimeout(() => {
    ctx.folds.timers.delete(projectId);
    void runFolds(ctx, projectId);
  }, delay);
  timer.unref?.();
  ctx.folds.timers.set(projectId, timer);
}

/** Each turn of a transcript that has finished, with its prompt's time. */
function finishedTurns(events: TranscriptEvent[]): Array<{ turnId: string; ts: number }> {
  const out: Array<{ turnId: string; ts: number }> = [];
  let open: { turnId: string; ts: number; done: boolean } | null = null;
  for (const event of events) {
    if (event.kind === "user") {
      if (open) out.push(open);
      open = { turnId: event.id, ts: event.ts, done: false };
    } else if (!open) continue;
    else if (event.kind === "result") open.done = true;
    else if (event.kind === "compaction") {
      out.push(open);
      open = null;
    }
  }
  if (open?.done) out.push(open);
  return out;
}

/** One waiting turn, read from its chat: its words, what it changed, and
 *  what it read from outside. Undefined once a rewind took it, or while it
 *  is still running. */
async function readTurn(
  ctx: ServerContext,
  project: { id: string; name: string; path: string },
  waiting: Waiting,
  eventsOf: (chat: string) => TranscriptEvent[],
): Promise<FoldTurn | "gone" | "running"> {
  const events = eventsOf(waiting.chat);
  const at = events.findIndex((event) => event.id === waiting.turn);
  if (at === -1) return "gone";
  const prompt = events[at]!;
  if (prompt.kind !== "user") return "gone";
  let end = at + 1;
  while (end < events.length && events[end]!.kind !== "user" && events[end]!.kind !== "compaction") end++;
  const stretch = events.slice(at + 1, end);
  const finished = end < events.length || stretch.some((event) => event.kind === "result");
  if (!finished) return "running";
  const assistant = stretch.flatMap((event) => (event.kind === "assistant" ? [event.text] : [])).join("\n\n");
  const tools = stretch.flatMap((event) => (event.kind === "tool" ? [event] : []));
  const edited = tools.flatMap((tool) =>
    tool.diff?.path ? [projectRelative(tool.diff.path, project.name)] : [],
  );
  const files = ctx.archive.summaries(waiting.chat)[waiting.turn]?.files ?? [...new Set(edited)];
  const outside = tools.flatMap((tool) => (outsideTool(tool.name, tool.summary) ? [tool.name] : []));
  const diff = await ctx.checkpoints
    .turnDiff(project, waiting.chat, waiting.turn, DIFF_BUDGET)
    .catch(() => undefined);
  const n = ctx.archive.exchangeNo(waiting.chat, waiting.turn) ?? 0;
  const title = ctx.store.findSession(waiting.chat)?.session.title;
  return {
    chat: waiting.chat,
    turnId: waiting.turn,
    ref: exchangeRef(waiting.chat, n),
    ...(title ? { title } : {}),
    day: dayOf(prompt.ts),
    user: prompt.text,
    assistant,
    files,
    ...(diff ? { diff } : {}),
    ...(outside.length ? { outside } : {}),
  };
}

function markFolded(queue: QueueFile, turns: Array<{ chat: string; turn: string }>, skipped = false): void {
  for (const { chat, turn } of turns) {
    const list = (queue.folded[chat] ??= []);
    if (!list.includes(turn)) list.push(turn);
    if (skipped) (queue.skipped[chat] ??= []).push(turn);
    delete queue.failed[`${chat}:${turn}`];
  }
  const done = new Set(turns.map((t) => `${t.chat}:${t.turn}`));
  queue.pending = queue.pending.filter((w) => !done.has(`${w.chat}:${w.turn}`));
}

/**
 * Work through a project's queue, a fold at a time, until it is empty or
 * the model can't be reached (then it tries again later, nothing lost).
 */
export async function runFolds(ctx: ServerContext, projectId: string): Promise<void> {
  if (ctx.folds.running.has(projectId)) return;
  const project = ctx.store.get(projectId);
  if (!project) return;
  ctx.folds.running.add(projectId);
  const queue = ctx.folds.queue(projectId);
  const backlog = queue.pending.length;
  let foldedNow = 0;
  try {
    while (queue.pending.length) {
      // a chunk: as many waiting turns as fit, in the order they finished
      const chunk: FoldTurn[] = [];
      const taken: Waiting[] = [];
      let size = 0;
      // a chat's whole history is read once a chunk, not once a turn
      const read = new Map<string, TranscriptEvent[]>();
      const eventsOf = (chat: string) => {
        let events = read.get(chat);
        if (!events) read.set(chat, (events = ctx.archive.allEvents(chat)));
        return events;
      };
      for (const waiting of [...queue.pending]) {
        if (chunk.length >= CHUNK_TURNS) break;
        const turn = await readTurn(ctx, project, waiting, eventsOf);
        if (turn === "gone") {
          queue.pending = queue.pending.filter((w) => w !== waiting);
          continue;
        }
        if (turn === "running") continue;
        const length = turnMaterial(turn).length;
        if (chunk.length && size + length > CHUNK_CHARS) break;
        chunk.push(turn);
        taken.push(waiting);
        size += length;
      }
      if (chunk.length === 0) break;
      const state = ctx.memory.state(projectId);
      const fold = MemoryBook.foldId();
      let result: Awaited<ReturnType<typeof foldTurns>>;
      try {
        const stack = memoryStack(ctx, projectId);
        result = await foldTurns(
          {
            project: project.name,
            today: dayOf(),
            ...(stack ? { stack } : {}),
            lines: linesWith(state),
            turns: chunk,
            resolve: (ref) => resolveRef(ctx, projectId, ref),
          },
          ctx.folds.ask,
        );
      } catch (err) {
        // the model can't be reached: everything stays waiting
        warn("memory", err, "runFolds");
        const wait = Math.min(RETRY_MAX_MS, (ctx.folds.backoff.get(projectId) ?? RETRY_MS / 2) * 2);
        ctx.folds.backoff.set(projectId, wait);
        ctx.folds.save(projectId);
        ctx.folds.running.delete(projectId);
        schedule(ctx, projectId, wait);
        return;
      }
      ctx.folds.backoff.delete(projectId);
      if (!result.answered) {
        // nothing usable came back: tried again, then given up on
        const giveUp: Waiting[] = [];
        for (const waiting of taken) {
          const key = `${waiting.chat}:${waiting.turn}`;
          queue.failed[key] = (queue.failed[key] ?? 0) + 1;
          if (queue.failed[key]! >= GIVE_UP_AFTER) giveUp.push(waiting);
        }
        markFolded(queue, giveUp, true);
        ctx.folds.save(projectId);
        if (giveUp.length < taken.length) {
          ctx.folds.running.delete(projectId);
          schedule(ctx, projectId, RETRY_MS);
          return;
        }
        continue;
      }
      const { events, refused } = ctx.memory.apply(projectId, result.changes, { by: "model", fold });
      for (const { change, reason } of refused) {
        warn("memory", new Error(`${change.op} refused: ${reason}`), "runFolds");
      }
      markFolded(queue, taken);
      queue.folds.push({ id: fold, at: Date.now(), turns: chunk.map((turn) => turn.ref) });
      if (queue.folds.length > FOLDS_KEPT) queue.folds.splice(0, queue.folds.length - FOLDS_KEPT);
      ctx.folds.save(projectId);
      foldedNow += taken.length;
      if (events.length) pushSheet(ctx, projectId);
      if (backlog > CHUNK_TURNS) {
        ctx.clients.broadcast({
          type: "recall",
          projectId,
          busy: queue.pending.length > 0,
          note: queue.pending.length
            ? `folded ${foldedNow} of ${backlog} exchanges…`
            : `folded ${foldedNow} exchanges in`,
        });
      }
    }
  } catch (err) {
    warn("memory", err, "runFolds");
  } finally {
    ctx.folds.running.delete(projectId);
  }
  // turns that joined while this ran, or were still running
  if (queue.pending.length) schedule(ctx, projectId, FOLD_DELAY_MS);
}
