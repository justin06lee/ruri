/**
 * A prompt's way out: written into the transcript, checkpointed, titled,
 * queued as it asks, and handed to the chat's session — plus
 * what a finished turn sets off next (the queue moving, a dropped turn
 * tried again) and ruri's own /compact.
 */
import { randomUUID } from "node:crypto";
import { leadOf, type AttachmentUpload, type LetterFrom, type TranscriptEvent } from "../shared/protocol.js";
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
import { answerPrompt, letterPrompt, seatName, stoppedLine } from "./talk.js";
import { contextWindow, resetContext } from "./turns.js";
import { modelPayload, processAttachments, storeAttachments } from "./uploads.js";
import { sessionsMode } from "./sessionsMode.js";
import { beginTask } from "./workers.js";

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

export function dispatch(
  ctx: ServerContext,
  channelId: string,
  text: string,
  uploads: AttachmentUpload[],
  silent = false,
  /** Another agent sent it (server/talk.ts): the transcript says whose,
   *  and the model reads it wrapped as a message, not as the user. */
  from?: LetterFrom,
  /** The id the user event should go by — the one the window already shows
   *  the prompt under, or the queue entry it waited in (see userEventId). */
  eventId?: string,
): string | undefined {
  // /compact is ruri's own, not the harness's: summaries + full-turn file
  // hooks into a fresh session, with the zigzag mark in the transcript —
  // the user's to ask for, never another agent's
  if (!silent && !from && text.trim() === "/compact" && uploads.length === 0) {
    compactChannel(ctx, channelId);
    return undefined;
  }
  // a worker's letter that starts a task starts it in a fresh session, on
  // the task's model — before anything below reads the chat
  if (!sessionsMode(ctx)) beginTask(ctx, channelId, from);
  const project = channelProject(ctx, channelId);
  if (!project) throw new Error("unknown session");
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
    // a prompt riding under one already shown: files are already stored, no new user event
    const visible = ctx.archive.events(channelId).findLast((event) => event.kind === "user")?.id;
    const { brief, harness } = catchUp(ctx, channelId, text, visible);
    if (visible) ctx.archive.noteSent(channelId, harness, visible);
    const payload = modelPayload(text, uploads);
    ctx.manager.send(
      project,
      brief + afterStop(ctx, channelId, payload.text) + named,
      payload.images,
      undefined,
      true,
      visible,
    );
    return undefined;
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
    id: userEventId(ctx, channelId, eventId),
    text: processed.display,
    ...(processed.attachments.length ? { attachments: processed.attachments } : {}),
    ...(from ? { from } : {}),
    ts: Date.now(),
  };
  // a lead's teammates' finished reports, held for its next prompt rather
  // than each waking it (TalkBook.held): into the transcript just ahead of
  // this prompt, and read first, as the messages they are
  const held = ctx.talk.takeHeld(channelId);
  for (const one of held)
    recordEvent(ctx, channelId, { kind: "user", id: randomUUID(), text: one.text, from: one.from, ts: Date.now() });
  const reports = held.map((one) => `${wrapped(ctx, channelId, one.from, one.text)}\n\n`).join("");
  recordEvent(ctx, channelId, userEvent);
  checkpoint(ctx, channelId, userEvent.id);
  const said = afterStop(
    ctx,
    channelId,
    from ? wrapped(ctx, channelId, from, processed.text) : processed.text,
  );
  ctx.archive.noteSent(channelId, harness, userEvent.id);
  ctx.manager.send(project, brief + reports + said + named, processed.images, undefined, true, userEvent.id);
  // a message the other chat has now started on — or an answer now in the
  // sender's hands, which is that letter done with. Only once it has gone:
  // one that fails to go goes back in line, and stays in the book
  if (from) ctx.talk.arrived(from);
  for (const one of held) ctx.talk.arrived(one.from);
  return userEvent.id;
}

/**
 * A prompt as the model reads it, after a teammate was stopped mid-turn
 * from the team page or by a lead: who stopped it, first — whatever the
 * prompt is, another agent's message, the user's own words or ruri's — so
 * the call the stop cut off isn't taken for a refusal, and the note never
 * waits for a later prompt it isn't about.
 */
export function afterStop(ctx: ServerContext, channelId: string, said: string): string {
  const stopped = ctx.talk.stopNotes.get(channelId);
  if (!stopped) return said;
  ctx.talk.stopNotes.delete(channelId);
  return `${stoppedLine(stopped.who, stopped.call)}\n\n${said}`;
}

/**
 * What the model reads for a prompt another agent's letter brought: the
 * message, wrapped as whose it is — told, for a lead or a liaison, that it
 * may hand the job on; an answer, told when it is the one owed onward; or
 * ruri's own words carrying the chat on with a message after compacting.
 */
function wrapped(ctx: ServerContext, channelId: string, from: LetterFrom, text: string): string {
  const handle = ctx.talk.handleOf(from.agent);
  // ruri's own words carrying the chat on after it compacted itself: they
  // say whose job it is (server/selfCompaction.ts continuePrompt)
  if (from.carried) return text;
  if (!from.answer) {
    const found = ctx.store.findSession(channelId);
    const head = !!found && (found.session.liaison === true || leadOf(found.project)?.id === channelId);
    return letterPrompt(from, handle, text, head);
  }
  const owed = from.owes ? ctx.talk.pending.get(from.owes) : undefined;
  return answerPrompt(
    from,
    handle,
    text,
    owed && owed.to === channelId && !owed.ending
      ? {
          who: owed.sender ? seatName(owed.sender.project, owed.sender.title) : "another agent",
          more: ctx.talk.outstanding(owed.id, from.letter),
        }
      : undefined,
  );
}

/**
 * The id a prompt's user event goes by: the one asked for — what the
 * window has been showing the prompt under since it was sent, or the queue
 * entry it waited in, which the window showed as that — so the real event
 * replaces the window's own copy where it stands instead of arriving
 * beside it. A fresh one when none was asked for, or when the transcript
 * already holds an event by that name (a prompt sent again after it failed
 * on its way to the harness).
 */
function userEventId(ctx: ServerContext, channelId: string, wanted: string | undefined): string {
  if (wanted && !holdsEvent(ctx, channelId, wanted)) return wanted;
  return randomUUID();
}

/** Whether the chat's live transcript has an event by this id — read from
 *  the end, where a prompt just sent is. */
export function holdsEvent(ctx: ServerContext, channelId: string, eventId: string): boolean {
  const events = ctx.archive.events(channelId);
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.id === eventId) return true;
  return false;
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
      // the user event takes the entry's id: the card the window showed in
      // the queue becomes the bubble in the transcript, in place
      dispatch(ctx, channelId, next.text, next.uploads, next.silent, next.from, next.id);
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
  /** The window's id for the prompt: the entry carrying its words goes by
   *  it (each command gets one of its own). */
  clientId?: string,
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
      id: clientId ?? randomUUID(),
      text: commands.length === 0 ? text : rest,
      uploads,
      silent: false,
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
  /** This prompt goes ahead of what is already queued — a queue that has
   *  been standing by since a stop waited for this one, not the reverse. */
  ahead = false,
  /** The window's id for the prompt (see promptEntries). */
  clientId?: string,
): boolean {
  const { commands } = splitCommands(text, knownCommands(ownerProject(ctx, channelId)?.path));
  if (commands.length === 0) return false;
  const wasBusy = ahead ? running(ctx, channelId) : busy(ctx, channelId);
  const { entries } = promptEntries(ctx, channelId, text, uploads, clientId);
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
  ctx.retries.cancelRetry(channelId);
  ctx.queues.holdQueue(channelId);
  ctx.manager.interrupt(channelId);
  // settle the "working" the stopped turn showed
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
  /** The window's id for the prompt (see promptEntries). */
  clientId?: string,
): boolean {
  if (!running(ctx, channelId)) return false;
  cutInWith(ctx, channelId, promptEntries(ctx, channelId, text, uploads, clientId).entries);
  return true;
}

/** The same cut-in, for entries made elsewhere — another agent's message
 *  (server/handlers/talk.ts), which carries who it is from. The caller has
 *  checked that a turn is running. */
export function cutInWith(ctx: ServerContext, channelId: string, entries: QueueEntry[]): void {
  // one already cutting in has stopped the turn, or is stopping it
  if (running(ctx, channelId)) stopTurn(ctx, channelId);
  const queue = ctx.queues.entries.get(channelId) ?? [];
  // at the head of the line, behind whatever cut in before it (and the
  // silent ones, which were always first) — but ahead of the prompt that
  // takes the chat back to its work, which follows every cut-in
  const front = queue.findIndex((entry) => !entry.silent && (!entry.cut || entry.resume === true));
  queue.splice(front === -1 ? queue.length : front, 0, ...entries.map((entry) => ({ ...entry, cut: true })));
  ctx.queues.entries.set(channelId, queue);
  ctx.queues.cutIn.add(channelId);
  ctx.queues.broadcastQueue(channelId);
  // the stopped turn's result is what sends it (drainQueue); a harness
  // that never says it stopped must not keep the prompt waiting forever
  const timer = setTimeout(() => {
    if (ctx.queues.cutIn.has(channelId) && !running(ctx, channelId)) drainQueue(ctx, channelId);
  }, CUT_IN_WAIT_MS);
  timer.unref?.();
}

/**
 * Where ruri compacts a chat before its harness would: a share of the
 * model's window, below each harness's own trigger — Claude Code's fires
 * near the top of the window, Codex's at about nine tenths, Gemini CLI's at
 * seven tenths — so the compaction that happens is ruri's: a brief that
 * keeps every prompt word for word and every exchange on file, not the
 * harness's own summary. RURI_AUTO_COMPACT_AT sets one share for every
 * harness; the "ruri-auto-compact" preference "off" leaves it to /compact.
 */
const AUTO_COMPACT_AT: Record<string, number> = {
  claude: 0.8,
  codex: 0.8,
  opencode: 0.8,
  gemini: 0.6,
  goose: 0.75,
};

/** The share of the window where ruri compacts a chat on `harness`. */
export function autoCompactShare(harness: string): number {
  return Number(process.env["RURI_AUTO_COMPACT_AT"]) || AUTO_COMPACT_AT[harness] || 0.8;
}

/** ruri's soft limit, in tokens: a chat whose context comes this close to
 *  it compacts at its turn's end, however big its window — a 1M window
 *  would otherwise run to 800k, every call re-reading all of it. */
export const SOFT_COMPACT_TOKENS = 434_000;
/** How near the soft limit counts as reaching it: the next turn would
 *  likely cross it, so the compaction comes before that turn. */
export const SOFT_MARGIN = 0.05;

/** The soft limit — RURI_COMPACT_SOFT_TOKENS, then the
 *  "ruri-compact-soft-tokens" preference ("434000", "434k", "1M"), else
 *  SOFT_COMPACT_TOKENS; undefined when either says "off". */
export function softCompactTokens(ctx: ServerContext): number | undefined {
  const env = process.env["RURI_COMPACT_SOFT_TOKENS"]?.trim();
  const said = (env || ctx.prefs.all()["ruri-compact-soft-tokens"])?.trim().toLowerCase();
  if (said === "off") return undefined;
  const m = said ? /^(\d+(?:\.\d+)?)\s*(k|m)?$/.exec(said) : null;
  const n = m ? Number(m[1]) * (m[2] === "k" ? 1000 : m[2] === "m" ? 1_000_000 : 1) : 0;
  return n >= 1000 ? Math.round(n) : SOFT_COMPACT_TOKENS;
}

/** Where ruri compacts a chat at a turn's end, in tokens, and which limit
 *  that is: its harness's share of the window, or near the soft limit —
 *  whichever comes first. Undefined when ruri's compaction is off. */
export function autoCompactPoint(
  ctx: ServerContext,
  channelId: string,
): { tokens: number; soft?: number } | undefined {
  if (channelId === HOME_ID || ctx.prefs.all()["ruri-auto-compact"] === "off") return undefined;
  const project = channelProject(ctx, channelId);
  if (!project) return undefined;
  const hard = Math.round(contextWindow(ctx, channelId) * autoCompactShare(ctx.manager.harnessFor(project)));
  const soft = softCompactTokens(ctx);
  const near = soft === undefined ? Infinity : Math.round(soft * (1 - SOFT_MARGIN));
  return near < hard ? { tokens: near, soft } : { tokens: hard };
}

/** Why a chat whose turn just ended should be compacted now — its context
 *  past its share of the window, or near the soft limit — or undefined.
 *  Never while an agent or a script it started is still running in the
 *  session. */
export function autoCompactDue(ctx: ServerContext, channelId: string): string | undefined {
  const point = autoCompactPoint(ctx, channelId);
  if (!point) return undefined;
  const tokens = ctx.turns.contexts.get(channelId)?.tokens ?? ctx.archive.contextTokens(channelId) ?? 0;
  if (tokens === 0 || tokens < point.tokens) return undefined;
  const work = ctx.manager.backgroundWork(channelId);
  if (work.agents > 0 || work.scripts > 0) return undefined;
  const k = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : `${Math.round(n / 1000)}k`);
  const kept = "keeping every prompt word for word and every exchange on file";
  if (point.soft !== undefined)
    return `the context reached ${k(tokens)}, near ruri's ${k(point.soft)} soft limit — handing off: ruri compacted it, ${kept}`;
  const window = contextWindow(ctx, channelId);
  return `the context reached ${Math.round((tokens / window) * 100)}% of ${k(window)} — ruri compacted it, ${kept}`;
}

/**
 * ruri's custom /compact: retire the live session and its resume id, stash
 * the brief (turn summaries + full-record file paths) for the next prompt,
 * and drop the zigzag compaction mark into the transcript. No model call —
 * the summaries are precomputed, so this is instant. `why` is said in the
 * transcript first, when ruri compacted it on its own.
 */
export function compactChannel(ctx: ServerContext, channelId: string, why?: string): void {
  if (why) {
    const said: TranscriptEvent = { kind: "info", id: randomUUID(), text: why, ts: Date.now() };
    ctx.archive.append(channelId, said);
    ctx.clients.pushEvent(channelId, said);
  }
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
