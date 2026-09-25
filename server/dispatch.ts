/**
 * A prompt's way out: written into the transcript, checkpointed, titled,
 * split or queued as it asks, and handed to the chat's session — plus
 * what a finished turn sets off next (the queue moving, a dropped turn
 * tried again) and ruri's own /compact.
 */
import { randomUUID } from "node:crypto";
import type { AttachmentUpload, LetterFrom, TranscriptEvent } from "../shared/protocol.js";
import { busy, channelProject, ownerProject, running } from "./channel.js";
import { pushTranscript } from "./clients.js";
import { knownCommands, splitCommands } from "./commands.js";
import { buildCompaction } from "./compaction.js";
import { mentionBlock, mentionedIn } from "./components.js";
import type { ServerContext } from "./context.js";
import { recordEvent } from "./events.js";
import { pushComponents } from "./handlers/components.js";
import { briefContext, catchUp, checkResumable } from "./handoff.js";
import { errorMessage, warn } from "./log.js";
import { HOME_ID } from "./manager.js";
import { backfillNotes } from "./notes.js";
import type { QueueEntry } from "./queue.js";
import { RETRY_NUDGE, RETRY_WAITS_MS } from "./retry.js";
import { sessionRoleTitle, smallModelEnabled, splitPrompt } from "./smallmodel.js";
import { answerPrompt, letterPrompt } from "./talk.js";
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

export function dispatch(
  ctx: ServerContext,
  channelId: string,
  text: string,
  uploads: AttachmentUpload[],
  silent = false,
  /** Another agent sent it (server/talk.ts): the transcript says whose,
   *  and the model reads it wrapped as a message, not as the user. */
  from?: LetterFrom,
): void {
  // /compact is ruri's own, not the harness's: summaries + full-turn file
  // hooks into a fresh session, with the zigzag mark in the transcript —
  // the user's to ask for, never another agent's
  if (!silent && !from && text.trim() === "/compact" && uploads.length === 0) {
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
  // a session to resume that Claude no longer has is let go of first, for
  // a brief — which this prompt then carries
  checkResumable(ctx, channelId);
  if (silent) {
    // a split sub-prompt: files are already stored, no new user event
    const visible = ctx.archive.events(channelId).findLast((event) => event.kind === "user")?.id;
    const { brief, harness } = catchUp(ctx, channelId, text, visible);
    if (visible) ctx.archive.noteSent(channelId, harness, visible);
    const payload = modelPayload(text, uploads);
    ctx.manager.send(project, brief + payload.text + named, payload.images, undefined, true, visible);
    return;
  }
  // Whatever the session this goes to doesn't hold rides in ahead of it,
  // invisibly: the whole conversation for a fresh one (after a compaction,
  // on a harness the chat has not run on), the exchanges it missed for one
  // the chat is coming back to — with what of the conversation bears on
  // this prompt at more length. Decided before the prompt joins the
  // transcript, so it is never told about itself.
  const { brief, harness } = catchUp(ctx, channelId, text);
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
    ...(from ? { from } : {}),
    ts: Date.now(),
  };
  recordEvent(ctx, channelId, userEvent);
  checkpoint(ctx, channelId, userEvent.id);
  const said = from
    ? (from.answer ? answerPrompt : letterPrompt)(from, ctx.talk.handleOf(from.agent), processed.text)
    : processed.text;
  ctx.archive.noteSent(channelId, harness, userEvent.id);
  ctx.manager.send(project, brief + said + named, processed.images, undefined, true, userEvent.id);
  // a message the other chat has now started on — or an answer now in the
  // sender's hands, which is that letter done with. Only once it has gone:
  // one that fails to go goes back in line, and stays in the book
  if (from) ctx.talk.arrived(from);
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
  // standing by since a stop — unless the stop was a prompt cutting in,
  // which goes now, with the queue behind it moving again
  if (ctx.queues.held.has(channelId)) {
    if (!ctx.queues.cutIn.has(channelId)) return false;
    ctx.queues.releaseQueue(channelId);
  }
  ctx.queues.cutIn.delete(channelId);
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
      else dispatch(ctx, channelId, next.text, next.uploads, next.silent, next.from);
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
  // the wait below, not this, is where "is it busy now" is asked.) A queue
  // held for the connection is another matter: the dropped turn was ahead
  // of it, and picking that back up jumps no one.
  if (ctx.queues.held.get(channelId)?.by === "stop") return;
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
  const offline = event.blocked === "network";
  recordEvent(ctx, channelId, {
    kind: "info",
    id: randomUUID(),
    text: offline
      ? `the connection dropped — going again once it is back (${attempt} of ${RETRY_WAITS_MS.length})`
      : `the API dropped that one — going again in ${Math.round(wait / 1000)}s (${attempt} of ${RETRY_WAITS_MS.length})`,
    ts: Date.now(),
  });
  const nudge = () => {
    const project = channelProject(ctx, channelId);
    // gone, or busy with something the user sent while we waited
    if (!project || busy(ctx, channelId)) {
      ctx.retries.delete(channelId);
      return;
    }
    try {
      // the chat may have moved to another harness while it waited: then
      // the nudge goes to a session that was not there for the dropped
      // turn, and is told about it first
      const { brief, harness } = catchUp(ctx, channelId, RETRY_NUDGE);
      const last = ctx.archive.events(channelId).findLast((event) => event.kind === "user")?.id;
      if (brief && last) ctx.archive.noteSent(channelId, harness, last);
      ctx.manager.send(project, brief + RETRY_NUDGE, undefined, undefined, true);
    } catch (err) {
      warn("server", err, "retry nudge");
      ctx.retries.delete(channelId);
    }
  };
  // a dropped connection is waited out, not timed: a nudge down a dead
  // line fails the same way, and spends a try doing it
  const key = `retry:${channelId}`;
  const timer = setTimeout(() => (offline ? ctx.connection.whenBack(key, nudge) : nudge()), wait);
  ctx.retries.set(channelId, {
    attempt,
    cancel: () => {
      clearTimeout(timer);
      ctx.connection.cancel(key);
    },
  });
}

/**
 * A prompt as the queue holds it: each command written inside it as its
 * own entry, in the order written, then the prompt with them gone.
 */
export function promptEntries(
  ctx: ServerContext,
  channelId: string,
  text: string,
  uploads: AttachmentUpload[],
  split: boolean,
): { entries: QueueEntry[]; commands: number } {
  const { commands, rest } = splitCommands(text, knownCommands(ownerProject(ctx, channelId)?.path));
  const entries: QueueEntry[] = commands.map((command) => ({
    id: randomUUID(),
    text: command,
    uploads: [],
    silent: false,
  }));
  if (commands.length === 0 || rest || uploads.length > 0) {
    entries.push({
      id: randomUUID(),
      text: commands.length === 0 ? text : rest,
      uploads,
      silent: false,
      ...(split ? { split: true } : {}),
      ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
    });
  }
  return { entries, commands: commands.length };
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
  const { commands } = splitCommands(text, knownCommands(ownerProject(ctx, channelId)?.path));
  if (commands.length === 0) return false;
  const wasBusy = ahead ? running(ctx, channelId) : busy(ctx, channelId);
  const { entries } = promptEntries(ctx, channelId, text, uploads, split);
  const queue = ctx.queues.entries.get(channelId) ?? [];
  if (ahead) queue.unshift(...entries);
  else queue.push(...entries);
  ctx.queues.entries.set(channelId, queue);
  ctx.queues.broadcastQueue(channelId);
  if (!wasBusy) drainQueue(ctx, channelId);
  return true;
}

/**
 * A turn the connection or the account let down: the queue behind it
 * stands by rather than spend itself against the same wall, one prompt
 * after another, and says why — and a queue held for the connection hears
 * when the line is back.
 */
export function holdForTheWorld(
  ctx: ServerContext,
  channelId: string,
  blocked: "network" | "limit",
  resetsAt: number | undefined,
): void {
  ctx.queues.holdQueue(
    channelId,
    blocked === "network" ? { by: "network" } : { by: "limit", ...(resetsAt ? { resetsAt } : {}) },
  );
  if (blocked === "network" && ctx.queues.held.has(channelId)) {
    ctx.connection.whenBack(`hold:${channelId}`, () => ctx.queues.connectionBack(channelId));
  }
}

/**
 * Stop the running turn: its answer is dropped, a retry it had coming is
 * not tried, and the queue behind it stands by (it moves again on the next
 * prompt, or from its own card).
 */
export function stopTurn(ctx: ServerContext, channelId: string): void {
  ctx.queues.epochs.set(channelId, (ctx.queues.epochs.get(channelId) ?? 0) + 1);
  ctx.retries.cancelRetry(channelId);
  ctx.queues.holdQueue(channelId);
  ctx.manager.interrupt(channelId);
  // settle the optimistic "working" a pending split may have shown
  ctx.clients.broadcast({
    type: "status",
    projectId: channelId,
    status: ctx.manager.statuses()[channelId] ?? "idle",
  });
}

/** How long a cut-in waits for the turn it stopped to say it has. */
const CUT_IN_WAIT_MS = 15_000;

/**
 * A prompt that cuts in: the running turn is stopped and this goes out
 * the moment it has — ahead of the queue, which falls in behind it and
 * moves again once it is answered, the way it does behind any prompt
 * sent after a stop. Until then it stands at the head of the line, on
 * screen. Returns false when nothing is running to cut into.
 */
export function cutIn(
  ctx: ServerContext,
  channelId: string,
  text: string,
  uploads: AttachmentUpload[],
  split: boolean,
): boolean {
  if (!running(ctx, channelId)) return false;
  stopTurn(ctx, channelId);
  const { entries } = promptEntries(ctx, channelId, text, uploads, split);
  const queue = ctx.queues.entries.get(channelId) ?? [];
  const front = queue.findIndex((entry) => !entry.silent);
  queue.splice(front === -1 ? queue.length : front, 0, ...entries);
  ctx.queues.entries.set(channelId, queue);
  ctx.queues.cutIn.add(channelId);
  ctx.queues.broadcastQueue(channelId);
  // the stopped turn's result is what sends it (drainQueue); a harness
  // that never says it stopped must not keep the prompt waiting forever
  const timer = setTimeout(() => {
    if (ctx.queues.cutIn.has(channelId) && !running(ctx, channelId)) drainQueue(ctx, channelId);
  }, CUT_IN_WAIT_MS);
  timer.unref?.();
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
    briefContext(ctx, channelId),
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
  // the mark folds everything before it into the history (archive.ts);
  // every window gets the live part as it now stands — the mark, alone
  ctx.archive.append(channelId, event);
  pushTranscript(ctx, channelId);
  drainQueue(ctx, channelId);
  // what just folded away shows as its notes — any it lacks, now
  backfillNotes(ctx, [channelId], { first: true });
}
