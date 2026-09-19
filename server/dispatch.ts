/**
 * A prompt's way out: written into the transcript, checkpointed, titled,
 * split or queued as it asks, and handed to the chat's session — plus
 * what a finished turn sets off next (the queue moving, a dropped turn
 * tried again) and ruri's own /compact.
 */
import { randomUUID } from "node:crypto";
import type { AttachmentUpload, TranscriptEvent } from "../shared/protocol.js";
import { busy, channelProject, ownerProject, running } from "./channel.js";
import { pushTranscript } from "./clients.js";
import { knownCommands, splitCommands } from "./commands.js";
import { buildCompaction } from "./compaction.js";
import { mentionBlock, mentionedIn } from "./components.js";
import type { ServerContext } from "./context.js";
import { recordEvent } from "./events.js";
import { pushComponents } from "./handlers/components.js";
import { errorMessage, warn } from "./log.js";
import { HOME_ID } from "./manager.js";
import { backfillNotes } from "./notes.js";
import type { QueueEntry } from "./queue.js";
import { RETRY_NUDGE, RETRY_WAITS_MS } from "./retry.js";
import { sessionRoleTitle, smallModelEnabled, splitPrompt } from "./smallmodel.js";
import { resetContext } from "./turns.js";
import { modelPayload, processAttachments, storeAttachments } from "./uploads.js";

/**
 * Write down the project's files before a prompt goes out, so a rewind to
 * it can put them back whatever harness ran the turn.
 *
 * Home is left out on purpose: its "project" is the whole workspace root,
 * and it orchestrates rather than edits. The capture runs alongside the
 * prompt rather than ahead of it — a harness takes seconds to reach its
 * first edit and git takes milliseconds to read a tree it has read
 * before, and a prompt is never held up waiting for one.
 */
function checkpoint(ctx: ServerContext, channelId: string, eventId: string): void {
  if (channelId === HOME_ID) return;
  const project = channelProject(ctx, channelId);
  if (!project?.path) return;
  void ctx.checkpoints.capture(project, channelId, eventId).catch(() => false);
}

// Sessions get their role title the moment their first prompt goes out —
// in parallel with the turn, not after it. (TurnTracker's post-turn call
// stays as the fallback if this pass fails or returns nothing.)
export function titleSession(ctx: ServerContext, channelId: string, text: string): void {
  if (!smallModelEnabled()) return;
  const found = ctx.store.findSession(channelId);
  if (!found || found.session.title) return;
  sessionRoleTitle({ turnId: "", user: text, assistant: "", tools: [] })
    .then((title) => {
      if (!title || ctx.store.findSession(channelId)?.session.title) return;
      ctx.store.setSessionTitle(channelId, title);
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    })
    .catch(() => {});
}

export function dispatch(ctx: ServerContext, channelId: string, text: string, uploads: AttachmentUpload[], silent = false): void {
  // /compact is ruri's own, not the harness's: summaries + full-turn file
  // hooks into a fresh session, with the zigzag mark in the transcript
  if (!silent && text.trim() === "/compact" && uploads.length === 0) {
    compactChannel(ctx, channelId);
    return;
  }
  const project = channelProject(ctx, channelId);
  if (!project) throw new Error("unknown session");
  titleSession(ctx, channelId, text);
  // a prompt that names something in the component index takes that
  // entry down with it — the model's copy only, never the transcript's
  const owner = ownerProject(ctx, channelId);
  const named = owner ? mentionBlock(mentionedIn(text, ctx.components.items(owner.id))) : "";
  // a new prompt is going out, so nothing is "just named" any more: what
  // this turn names wears the star beside it, and what the last one named
  // keeps its star in the corner until the user has looked
  if (owner && ctx.components.demote(owner.id)) pushComponents(ctx, owner.id, owner.path);
  // the first prompt after a compaction carries the brief, invisibly
  const brief = ctx.archive.takePendingBrief(channelId) ?? "";
  if (silent) {
    // a split sub-prompt: files are already stored, no new user event
    const payload = modelPayload(text, uploads);
    ctx.manager.send(project, brief + payload.text + named, payload.images, undefined, true,
      ctx.archive.events(channelId).findLast((event) => event.kind === "user")?.id);
    return;
  }
  // What the model reads and what the user wrote are two strings: the
  // compaction brief is the model's memory, and a file's marker becomes
  // its path where the model reads it. So the transcript event is written
  // here, from the user's own wording, and the model's copy goes down
  // silently underneath it.
  const processed = processAttachments(text, uploads);
  const userEvent: TranscriptEvent = {
    kind: "user",
    id: randomUUID(),
    text: processed.display,
    ...(processed.attachments.length ? { attachments: processed.attachments } : {}),
    ts: Date.now(),
  };
  recordEvent(ctx, channelId, userEvent);
  checkpoint(ctx, channelId, userEvent.id);
  ctx.manager.send(project, brief + processed.text + named, processed.images, undefined, true, userEvent.id);
}

/**
 * The scissors send: one visible prompt, split by the small model into
 * its separate requests and fed to the harness one turn at a time.
 */
export function dispatchSplit(
  ctx: ServerContext,
  channelId: string,
  text: string,
  uploads: AttachmentUpload[],
  /** Ahead of a queue standing by since a stop — see `send`. */
  ahead = false,
): void {
  // The user sees exactly one thing: their prompt, sent now. The
  // split and the turn-by-turn feed happen entirely out of sight.
  const attachments = storeAttachments(uploads);
  const userEvent: TranscriptEvent = {
    kind: "user",
    id: randomUUID(),
    text: text,
    ...(attachments.length ? { attachments } : {}),
    ts: Date.now(),
  };
  recordEvent(ctx, channelId, userEvent);
  checkpoint(ctx, channelId, userEvent.id);
  // the split is thinking before the harness is; the clock starts with
  // the prompt, not with whichever sub-prompt reaches a session first
  ctx.turns.startTurn(channelId);
  ctx.clients.broadcast({ type: "status", projectId: channelId, status: "working" });
  titleSession(ctx, channelId, text);
  const epoch = ctx.queues.epochs.get(channelId) ?? 0;
  void (smallModelEnabled() ? splitPrompt(text).catch(() => [text]) : Promise.resolve([text])).then(
    (prompts) => {
      if ((ctx.queues.epochs.get(channelId) ?? 0) !== epoch) return; // stopped meanwhile
      // route each attachment to the sub-prompt carrying its marker
      const parts = prompts.map((text) => ({ text, uploads: [] as AttachmentUpload[] }));
      for (const upload of uploads) {
        const marker = `[${upload.kind} #${upload.n}]`;
        const target = parts.find((p) => p.text.includes(marker)) ?? parts[0]!;
        target.uploads.push(upload);
      }
      const entries: QueueEntry[] = parts.map((part) => ({
        id: randomUUID(),
        text: part.text,
        uploads: part.uploads,
        silent: true,
      }));
      const idle = ahead ? !running(ctx, channelId) : !busy(ctx, channelId);
      const first = idle ? entries.shift() : undefined;
      if (entries.length > 0) {
        const queue = ctx.queues.entries.get(channelId) ?? [];
        if (ahead) queue.unshift(...entries);
        else queue.push(...entries);
        ctx.queues.entries.set(channelId, queue);
      }
      if (first) dispatch(ctx, channelId, first.text, first.uploads, true);
    },
  );
}

/** Send the next queued prompt, once the channel settles. Answers whether
 *  one went out — a caller deciding what a finished turn means next needs
 *  to know, and the send itself is a microtask away. */
export function drainQueue(ctx: ServerContext, channelId: string): boolean {
  if (ctx.queues.held.has(channelId)) return false;
  const queue = ctx.queues.entries.get(channelId);
  // the one being rewritten is not in line — whatever is behind it goes
  const at = queue?.findIndex((entry) => !entry.editing) ?? -1;
  if (!queue || at === -1) return false;
  const next = queue[at]!;
  queue.splice(at, 1);
  if (queue.length === 0) ctx.queues.entries.delete(channelId);
  if (!next.silent) ctx.queues.broadcastQueue(channelId);
  // after the session settles its result (it flips to idle right after
  // emitting it) — so the queued turn's "working" sticks
  queueMicrotask(() => {
    try {
      if (next.split) dispatchSplit(ctx, channelId, next.text, next.uploads);
      else dispatch(ctx, channelId, next.text, next.uploads, next.silent);
    } catch (err) {
      // the send failed (the channel vanished, the harness would not
      // start): the prompt goes back to the head of the line rather than
      // into the void, and the user hears why
      warn("server", err, `drainQueue ${channelId}`);
      const back = ctx.queues.entries.get(channelId) ?? [];
      back.unshift(next);
      ctx.queues.entries.set(channelId, back);
      ctx.queues.broadcastQueue(channelId);
      ctx.clients.broadcast({ type: "error", message: `queued prompt not sent: ${errorMessage(err)}` });
    }
  });
  return true;
}

export function maybeRetry(ctx: ServerContext, channelId: string, event: TranscriptEvent): void {
  if (event.kind !== "result") return;
  // a turn that landed clears the count: the next blip starts from one
  if (event.ok || event.stopped) {
    ctx.retries.cancelRetry(channelId);
    return;
  }
  // always: an overload is weather, not a decision, and there is no
  // switch for waiting it out — a dropped turn is picked back up
  if (!event.transient) return;
  // Prompts standing by since an earlier stop are the user's, and they go
  // out on the user's word — a nudge would jump that line. (Prompts merely
  // queued are already handled: the caller only asks when the queue had
  // nothing to send. Note that `running` is still true here, since the
  // session flips to idle just after emitting this result — which is why
  // the wait below, not this, is where "is it busy now" is asked.)
  if (ctx.queues.held.has(channelId)) return;
  const attempt = (ctx.retries.get(channelId)?.attempt ?? 0) + 1;
  const wait = RETRY_WAITS_MS[attempt - 1];
  if (wait === undefined) {
    ctx.retries.cancelRetry(channelId);
    recordEvent(ctx, channelId, {
      kind: "info",
      id: randomUUID(),
      text: `${RETRY_WAITS_MS.length} goes and the API is still dropping it — leaving this one to you`,
      ts: Date.now(),
    });
    return;
  }
  recordEvent(ctx, channelId, {
    kind: "info",
    id: randomUUID(),
    text: `the API dropped that one — going again in ${Math.round(wait / 1000)}s (${attempt} of ${RETRY_WAITS_MS.length})`,
    ts: Date.now(),
  });
  const timer = setTimeout(() => {
    const project = channelProject(ctx, channelId);
    // gone, or busy with something the user sent while we waited
    if (!project || busy(ctx, channelId)) {
      ctx.retries.delete(channelId);
      return;
    }
    try {
      ctx.manager.send(project, RETRY_NUDGE, undefined, undefined, true);
    } catch (err) {
      warn("server", err, "retry nudge");
      ctx.retries.delete(channelId);
    }
  }, wait);
  ctx.retries.set(channelId, { attempt, timer });
}

/**
 * Commands written inside a prompt run before it. Each becomes its own
 * queue entry, in the order written, and the prompt (with them gone)
 * follows — through the queue too, so it cannot overtake them. Returns
 * false when the prompt held no commands, and the caller sends as usual.
 */
export function queueWithCommands(
  ctx: ServerContext,
  channelId: string,
  text: string,
  uploads: AttachmentUpload[],
  split: boolean,
  /** This prompt goes ahead of what is already queued — a queue that has
   *  been standing by since a stop waited for this one, not the reverse. */
  ahead = false,
): boolean {
  const { commands, rest } = splitCommands(text, knownCommands(ownerProject(ctx, channelId)?.path));
  if (commands.length === 0) return false;
  const wasBusy = ahead ? running(ctx, channelId) : busy(ctx, channelId);
  const entries: QueueEntry[] = commands.map((command) => ({
    id: randomUUID(),
    text: command,
    uploads: [],
    silent: false,
  }));
  if (rest || uploads.length > 0) {
    entries.push({
      id: randomUUID(),
      text: rest,
      uploads,
      silent: false,
      ...(split ? { split: true } : {}),
      ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
    });
  }
  const queue = ctx.queues.entries.get(channelId) ?? [];
  if (ahead) queue.unshift(...entries);
  else queue.push(...entries);
  ctx.queues.entries.set(channelId, queue);
  ctx.queues.broadcastQueue(channelId);
  if (!wasBusy) drainQueue(ctx, channelId);
  return true;
}

/**
 * ruri's custom /compact: retire the live session and its resume id, stash
 * the brief (turn summaries + full-record file paths) for the next prompt,
 * and drop the zigzag compaction mark into the transcript. No model call —
 * the summaries are precomputed, so this is instant.
 */
function compactChannel(ctx: ServerContext, channelId: string): void {
  const built = buildCompaction(
    channelId,
    ctx.archive.allEvents(channelId),
    ctx.archive.summaries(channelId),
    ctx.archive.digest(channelId),
  );
  if (built === null) {
    const event: TranscriptEvent = {
      kind: "info",
      id: randomUUID(),
      text: "nothing to compact yet",
      ts: Date.now(),
    };
    ctx.archive.append(channelId, event);
    ctx.clients.pushEvent(channelId, event);
    drainQueue(ctx, channelId);
    return;
  }
  ctx.manager.dispose(channelId);
  ctx.archive.clearLastSessionId(channelId);
  ctx.archive.setPendingBrief(channelId, built.brief);
  resetContext(ctx, channelId);
  const event: TranscriptEvent = {
    kind: "compaction",
    id: randomUUID(),
    text: built.brief,
    entries: built.entries,
    ...(built.digest ? { digest: built.digest } : {}),
    ts: Date.now(),
  };
  // the mark folds everything before it into the history (ctx.archive.ts);
  // every window gets the live part as it now stands — the mark, alone
  ctx.archive.append(channelId, event);
  pushTranscript(ctx, channelId);
  drainQueue(ctx, channelId);
  // what just folded away shows as its notes — any it lacks, now
  backfillNotes(ctx, [channelId], { first: true });
}
