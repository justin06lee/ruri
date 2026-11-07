/**
 * A long prompt cut into its tasks, each sent as a turn of its own. One
 * session compacts through handoff notes, and a job that spans a compaction
 * is the one that loses detail; a prompt's tasks that went out one by one
 * each have every word on file, under their own exchange.
 *
 * The small model never writes a word of what goes out: it is shown the
 * prompt in numbered pieces and answers with numbers, and each task is cut
 * from the user's own text. Whatever goes wrong — the model is off, slow,
 * wrong, or sees only one task — the prompt goes as it was written.
 *
 * Meanwhile the prompt waits in the queue, where the user can see it and
 * take it out, and nothing behind it can overtake it (drainQueue).
 */
import { randomUUID } from "node:crypto";
import { HOME_ID } from "./manager.js";
import { SPLIT_PREF, type AttachmentUpload, type TranscriptEvent } from "../shared/protocol.js";
import { running, ownerProject } from "./channel.js";
import { knownCommands, splitCommands } from "./commands.js";
import type { ServerContext } from "./context.js";
import { drainQueue } from "./dispatch.js";
import { warn } from "./log.js";
import type { QueueEntry } from "./queue.js";
import { smallModelEnabled, taskCuts, type TaskCuts } from "./smallmodel.js";

/** A prompt shorter than this is sent as it is. */
export const SPLIT_LONGER_THAN = 1200;
/** How long a prompt waits on the small model before going whole. */
const SPLIT_WAIT_MS = 20_000;
/** More pieces than this and a prompt is a paste, cut more coarsely. */
const MAX_PIECES = 300;
const MAX_TASKS = 12;
/** Past this share of the prompt, "shared" means the model didn't divide it. */
const MAX_SHARED = 0.3;
const PIECE_SHOWN = 240;

/** Whether this prompt is one to cut. midna's are not: it follows a prompt
 *  by its own id, and manages its jobs one at a time already. */
export function wantsSplit(
  ctx: ServerContext,
  channelId: string,
  text: string,
  clientId: string | undefined,
): boolean {
  if (text.length < SPLIT_LONGER_THAN || channelId === HOME_ID || clientId?.startsWith("midna-")) return false;
  if (ctx.prefs.all()[SPLIT_PREF] === "off" || !smallModelEnabled()) return false;
  return splitCommands(text, knownCommands(ownerProject(ctx, channelId)?.path)).commands.length === 0;
}

/** Lines, or a fence whole: nothing cuts inside pasted code. */
function lines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    if (fenced) out[out.length - 1] += line;
    else out.push(line);
    if (/^\s*```/.test(line)) fenced = !fenced;
  }
  return out;
}

/** Each piece carries the blank space after it, so the pieces in order are
 *  the text exactly. */
function gathered(raw: string[]): string[] {
  const out: string[] = [];
  for (const piece of raw) {
    if (out.length > 0 && !piece.trim()) out[out.length - 1] += piece;
    else out.push(piece);
  }
  return out;
}

/** The prompt in pieces to choose from: sentences, or lines if that is too
 *  many, or paragraphs; undefined when even those are too many. */
export function pieces(text: string): string[] | undefined {
  const byLine = gathered(lines(text));
  const bySentence = gathered(byLine.flatMap((line) => (line.includes("```") ? [line] : line.split(/(?<=[.!?]\s+)(?=\S)/))));
  if (bySentence.length <= MAX_PIECES) return bySentence;
  if (byLine.length <= MAX_PIECES) return byLine;
  const paragraphs: string[] = [];
  let open = false;
  for (const line of byLine) {
    if (open) paragraphs[paragraphs.length - 1] += line;
    else paragraphs.push(line);
    open = !/\n\s*\n\s*$/.test(line);
  }
  return paragraphs.length <= MAX_PIECES ? paragraphs : undefined;
}

/** The pieces as the model is shown them. */
function numbered(parts: string[]): string {
  return parts
    .map((part, i) => {
      const flat = part.trim().replace(/\s+/g, " ");
      const shown = flat.length > PIECE_SHOWN ? `${flat.slice(0, PIECE_SHOWN - 40)} … ${flat.slice(-40)}` : flat;
      return `[${i + 1}] ${shown}`;
    })
    .join("\n");
}

/**
 * The tasks the model's numbers make of the pieces, in the user's own words:
 * each task's pieces, with the shared ones around it where they stood. Any
 * pieces before the first task are shared too (an opening that sets up all
 * of them). Undefined for fewer than two tasks or numbers that don't hold.
 */
export function cutAt(parts: string[], cuts: TaskCuts): string[] | undefined {
  const { tasks, shared } = cuts;
  const fits = (n: number) => Number.isInteger(n) && n >= 1 && n <= parts.length;
  if (tasks.length < 2 || tasks.length > MAX_TASKS || !tasks.every(fits) || !shared.every(fits)) return undefined;
  if (tasks.some((n, i) => i > 0 && n <= tasks[i - 1]!)) return undefined;
  if (shared.some((n) => tasks.includes(n))) return undefined;
  const common = new Set(shared.map((n) => n - 1));
  for (let i = 0; i < tasks[0]! - 1; i++) common.add(i);
  const size = parts.reduce((sum, part, i) => sum + (common.has(i) ? part.length : 0), 0);
  if (size > MAX_SHARED * parts.join("").length) return undefined;
  const out: string[] = [];
  for (let t = 0; t < tasks.length; t++) {
    const from = tasks[t]! - 1;
    const to = t + 1 < tasks.length ? tasks[t + 1]! - 1 : parts.length;
    const own = (i: number) => i >= from && i < to && !common.has(i);
    const words = (keep: (i: number) => boolean) =>
      parts.filter((_, i) => keep(i)).join("").trim();
    const body = words(own);
    // a task of shared pieces alone is no task
    if (!body) return undefined;
    const before = words((i) => common.has(i) && i < from);
    const after = words((i) => common.has(i) && i >= from);
    out.push([before, body, after].filter(Boolean).join("\n\n"));
  }
  return out;
}

/** The attachments a task names, by their markers; each keeps its number,
 *  so "[image #3]" still means the same picture. One no task names goes with
 *  the first. */
export function routeUploads(tasks: string[], uploads: AttachmentUpload[]): AttachmentUpload[][] {
  const routed = tasks.map((): AttachmentUpload[] => []);
  for (const upload of uploads) {
    const markers = [
      `[${upload.kind} #${upload.n}]`,
      ...(upload.regions ?? []).map((region) => `[region #${region.n}]`),
    ];
    const naming = tasks.flatMap((task, i) => (markers.some((marker) => task.includes(marker)) ? [i] : []));
    for (const i of naming.length > 0 ? naming : [0]) routed[i]!.push(upload);
  }
  return routed;
}

/** The tasks in a prompt, or undefined when it should go whole. */
async function tasksIn(text: string): Promise<string[] | undefined> {
  const parts = pieces(text);
  if (!parts || parts.length < 2) return undefined;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), SPLIT_WAIT_MS);
    timer.unref?.();
  });
  try {
    const cuts = await Promise.race([taskCuts(numbered(parts)), late]);
    return cuts ? cutAt(parts, cuts) : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** The entry's tasks in its place: the first under its id, so the card the
 *  window shows becomes that task's bubble. */
function asTasks(entry: QueueEntry, tasks: string[]): QueueEntry[] {
  const routed = routeUploads(tasks, entry.uploads);
  return tasks.map((text, i) => {
    const uploads = routed[i]!;
    const attachments = entry.attachments?.filter((att) => uploads.some((upload) => upload.id === att.id));
    return {
      id: i === 0 ? entry.id : randomUUID(),
      text,
      uploads,
      silent: false,
      part: { n: i + 1, of: tasks.length },
      ...(attachments?.length ? { attachments } : {}),
      ...(entry.cut ? { cut: true } : {}),
    };
  });
}

/**
 * Cut the queued prompt `id` into tasks. It holds its place in the line
 * until the answer is in; by then it may have been taken out or rewritten,
 * which is the user's word over the model's. The queue moves on either way.
 */
export function splitQueued(ctx: ServerContext, channelId: string, id: string): void {
  const entry = ctx.queues.entries.get(channelId)?.find((e) => e.id === id);
  if (!entry) return;
  entry.splitting = true;
  ctx.queues.broadcastQueue(channelId);
  void tasksIn(entry.text)
    .catch((err: unknown) => {
      warn("split", err, channelId);
      return undefined;
    })
    .then((tasks) => {
      const queue = ctx.queues.entries.get(channelId);
      const now = queue?.find((e) => e.id === id && e.splitting);
      if (queue && now) {
        delete now.splitting;
        if (tasks) {
          queue.splice(queue.indexOf(now), 1, ...asTasks(now, tasks));
          const said: TranscriptEvent = {
            kind: "info",
            id: randomUUID(),
            text: `Split into ${tasks.length} tasks, sent one at a time.`,
            ts: Date.now(),
          };
          ctx.archive.append(channelId, said);
          ctx.clients.pushEvent(channelId, said);
        }
        ctx.queues.broadcastQueue(channelId);
      }
      if (!running(ctx, channelId)) drainQueue(ctx, channelId);
    });
}
