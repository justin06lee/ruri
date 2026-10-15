/**
 * The composer's messages: a prompt sent (whole or split), the queue
 * behind a running turn rearranged, a turn stopped, a draft kept, and the
 * cards a turn raises answered. The prompt path itself is
 * server/dispatch.ts.
 */
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";
import type {
  AskQuestions,
  AttachmentUpload,
  ServerMessage,
  TranscriptEvent,
} from "../../shared/protocol.js";
import { busy, channelProject, ownerProject, running } from "../channel.js";
import { knownCommands, splitCommands } from "../commands.js";
import type { ClientConn, ServerContext } from "../context.js";
import {
  cutIn,
  dispatch,
  dispatchSplit,
  drainQueue,
  holdsEvent,
  promptEntries,
  queueWithCommands,
  stopTurn,
} from "../dispatch.js";
import { combine, reslot, uncombine, type QueueEntry } from "../queue.js";
import { storeAttachments, storeUpload } from "../uploads.js";
import { followCrew } from "./crew.js";
import { answerTalk, onAJob, talkDropped } from "./talk.js";
import type { Handler, Handlers } from "./types.js";

type SentAs = Extract<ServerMessage, { type: "sent" }>["as"];

/**
 * Prompts taken by the window's own id, and where each went — newest
 * last, the oldest let go past TAKEN_MAX. A window that loses its socket
 * just after sending cannot know whether the prompt arrived, so it sends
 * it again on reconnecting (web/src/store.ts, the outbox); this is how the
 * second copy is answered rather than run. Kept for this run of the
 * server: after a restart the transcript and the queue are what say a
 * prompt has been taken (whereIs).
 */
const taken = new Map<string, SentAs>();
const TAKEN_MAX = 2_000;

/** Where a prompt the window named stands now: in the queue, or in the
 *  transcript — each under the window's id. */
function whereIs(ctx: ServerContext, channelId: string, clientId: string): SentAs | undefined {
  if (ctx.queues.entries.get(channelId)?.some((entry) => entry.id === clientId)) return "queued";
  if (holdsEvent(ctx, channelId, clientId)) return "event";
  return undefined;
}

function answer(ws: ClientConn, channelId: string, clientId: string, as: SentAs): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "sent", projectId: channelId, clientId, as } satisfies ServerMessage));
}

/** A prompt this server has already taken: answered again with where it
 *  is now, and true — the caller runs nothing. */
function seenBefore(ctx: ServerContext, ws: ClientConn, channelId: string, clientId: string): boolean {
  const was = taken.get(clientId);
  const now = whereIs(ctx, channelId, clientId);
  if (was === undefined && now === undefined) return false;
  answer(ws, channelId, clientId, now ?? (was === "failed" ? "failed" : "other"));
  return true;
}

/**
 * Run a prompt the window named, then tell it where the prompt went.
 *
 * The answer waits a microtask: a prompt that only queued commands ahead
 * of itself is sent on by drainQueue a microtask later, and the answer
 * should say where it ended up, not where it stood for an instant. A
 * prompt that threw on its way (a chat that has gone) is answered
 * `failed`, so the window can hand its words back rather than show a
 * prompt that was never sent.
 */
function taking(
  ctx: ServerContext,
  ws: ClientConn,
  channelId: string,
  clientId: string | undefined,
  run: () => void,
): void {
  if (clientId === undefined) {
    run();
    return;
  }
  if (seenBefore(ctx, ws, channelId, clientId)) return;
  const settle = (as: SentAs) => {
    taken.set(clientId, as);
    if (taken.size > TAKEN_MAX) taken.delete(taken.keys().next().value!);
    answer(ws, channelId, clientId, as);
  };
  try {
    run();
  } catch (err) {
    settle("failed");
    throw err;
  }
  queueMicrotask(() => settle(whereIs(ctx, channelId, clientId) ?? "other"));
}

/** Whether the chat's next prompt starts a fresh session, briefed. */
function freshNext(ctx: Parameters<Handler<"draft">>[0], channelId: string): boolean {
  const project = channelProject(ctx, channelId);
  if (!project) return false;
  const harness = ctx.manager.harnessFor(project);
  return ctx.archive.hasPendingBrief(channelId) || !ctx.archive.harnessSession(channelId, harness)?.session;
}

/**
 * "Send now" to a teammate or the liaison while its turn is another agent's
 * job: the job is not cut short — that would end it, and its sender would
 * get "stopped" for an answer — so the prompt goes next instead, ahead of
 * everything else waiting, as another agent's message would, and the chat
 * says why. Stop still ends the job. Answers whether it took the prompt.
 */
function nextAfterJob(
  ctx: ServerContext,
  channelId: string,
  text: string,
  uploads: AttachmentUpload[],
  split: boolean,
  clientId: string | undefined,
): boolean {
  const sender = onAJob(ctx, channelId);
  if (!sender) return false;
  const queue = ctx.queues.entries.get(channelId) ?? [];
  // where a cut-in would go: behind the sub-prompts riding with the turn
  // and what cut in already, ahead of the rest and of the way back to work
  const front = queue.findIndex((entry) => !entry.silent && (!entry.cut || entry.resume === true));
  const { entries } = promptEntries(ctx, channelId, text, uploads, split, clientId);
  queue.splice(front === -1 ? queue.length : front, 0, ...entries);
  ctx.queues.entries.set(channelId, queue);
  ctx.queues.broadcastQueue(channelId);
  const why: TranscriptEvent = {
    kind: "info",
    id: randomUUID(),
    text: `Your message goes next: this turn is ${sender}'s job, and sending now would end it. Stop it if you mean to.`,
    ts: Date.now(),
  };
  ctx.archive.append(channelId, why);
  ctx.clients.pushEvent(channelId, why);
  return true;
}

/** A prompt sent: now, or into the queue behind whatever is running. */
const send: Handler<"send"> = (ctx, ws, msg) => {
  if (msg.text.trim().length === 0 && !msg.attachments?.length) return;
  const channelId = msg.projectId;
  const uploads = msg.attachments ?? [];
  const clientId = msg.clientId;
  taking(ctx, ws, channelId, clientId, () => {
    // the user is driving again: whatever ruri was about to try again
    // for them, this prompt says it better
    ctx.retries.cancelRetry(channelId);
    // sent to cut in: the running turn stops and this goes in its place —
    // or, when that turn is another agent's job, straight after it
    if (msg.now && nextAfterJob(ctx, channelId, msg.text, uploads, false, clientId)) return;
    if (msg.now && cutIn(ctx, channelId, msg.text, uploads, false, clientId)) return;
    // A queue that has been standing by since a stopped turn: this
    // prompt is the reason it stopped — a clarification, a correction —
    // so it goes out now, ahead of the queue, and the queue falls in
    // behind it and moves again the moment this turn is done.
    const ahead = ctx.queues.releaseQueue(channelId) && !running(ctx, channelId);
    if (queueWithCommands(ctx, channelId, msg.text, uploads, false, ahead, clientId)) return;
    if (!ahead && busy(ctx, channelId)) {
      // hold it app-side — nothing reaches the harness until the
      // running turn (and everything queued before it) finishes
      const queue = ctx.queues.entries.get(channelId) ?? [];
      queue.push({
        id: clientId ?? randomUUID(),
        text: msg.text,
        uploads,
        silent: false,
        ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
      });
      ctx.queues.entries.set(channelId, queue);
      ctx.queues.broadcastQueue(channelId);
      return;
    }
    dispatch(ctx, channelId, msg.text, uploads, false, undefined, clientId);
  });
};

export const promptHandlers = {
  send,
  send_split: (ctx, ws, msg) => {
    if (msg.text.trim().length === 0) return;
    const channelId = msg.projectId;
    const uploads = msg.attachments ?? [];
    const clientId = msg.clientId;
    taking(ctx, ws, channelId, clientId, () => {
      ctx.retries.cancelRetry(channelId);
      if (!channelProject(ctx, channelId)) throw new Error("unknown session");
      if (msg.now && nextAfterJob(ctx, channelId, msg.text, uploads, true, clientId)) return;
      if (msg.now && cutIn(ctx, channelId, msg.text, uploads, true, clientId)) return;
      const ahead = ctx.queues.releaseQueue(channelId) && !running(ctx, channelId);
      if (queueWithCommands(ctx, channelId, msg.text, uploads, true, ahead, clientId)) return;
      dispatchSplit(ctx, channelId, msg.text, uploads, ahead, clientId);
    });
  },
  ping: (_ctx, ws) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "pong" } satisfies ServerMessage));
  },
  queue_remove: (ctx, _ws, msg) => {
    const queue = ctx.queues.entries.get(msg.projectId);
    if (!queue) return;
    const kept = queue.filter((e) => e.id !== msg.itemId || e.silent);
    // a message from another agent taken out: its sender hears so
    talkDropped(ctx, queue.find((e) => e.id === msg.itemId && !e.silent)?.from);
    if (kept.length !== queue.length) {
      if (kept.length === 0) {
        ctx.queues.entries.delete(msg.projectId);
        ctx.queues.held.delete(msg.projectId);
      } else ctx.queues.entries.set(msg.projectId, kept);
      ctx.queues.broadcastQueue(msg.projectId);
    }
  },
  queue_send: (ctx, _ws, msg) => {
    // Sent on by hand from the queue's own card: what was standing by
    // since the stop goes out now, in the order it was written.
    if (!ctx.queues.releaseQueue(msg.projectId)) return;
    if (!running(ctx, msg.projectId)) drainQueue(ctx, msg.projectId);
  },
  queue_move: (ctx, _ws, msg) => {
    const queue = ctx.queues.entries.get(msg.projectId);
    const moving = queue?.find((e) => e.id === msg.itemId && !e.silent && !e.editing);
    if (!queue || !moving || moving.id === msg.beforeId) return;
    const visible = queue.filter((e) => !e.silent && e !== moving);
    // the one being rewritten stays at the end, out of the line
    const line = visible.filter((e) => !e.editing);
    const at = msg.beforeId ? line.findIndex((e) => e.id === msg.beforeId) : -1;
    if (at === -1) line.push(moving);
    else line.splice(at, 0, moving);
    ctx.queues.entries.set(msg.projectId, reslot(queue, [...line, ...visible.filter((e) => e.editing)]));
    ctx.queues.broadcastQueue(msg.projectId);
  },
  queue_merge: (ctx, _ws, msg) => {
    const queue = ctx.queues.entries.get(msg.projectId);
    const next = queue && combine(queue, msg.itemId, msg.intoId);
    if (!next) return;
    ctx.queues.entries.set(msg.projectId, next);
    ctx.queues.broadcastQueue(msg.projectId);
  },
  queue_unmerge: (ctx, _ws, msg) => {
    const queue = ctx.queues.entries.get(msg.projectId);
    const next = queue && uncombine(queue, msg.itemId);
    if (!next) return;
    ctx.queues.entries.set(msg.projectId, next);
    ctx.queues.broadcastQueue(msg.projectId);
  },
  queue_edit: (ctx, _ws, msg) => {
    const queue = ctx.queues.entries.get(msg.projectId);
    const entry = queue?.find((e) => e.id === msg.itemId && !e.silent);
    if (!queue || !entry || entry.editing) return;
    entry.editing = true;
    // a rewrite is the prompt now: taking the fold back would undo it too
    delete entry.combined;
    entry.editAfter = queue
      .slice(0, queue.indexOf(entry))
      .filter((e) => !e.silent && !e.editing)
      .map((e) => e.id);
    // out of the line: the rest move up, and it shows under them
    ctx.queues.entries.set(msg.projectId, [...queue.filter((e) => e !== entry), entry]);
    ctx.queues.broadcastQueue(msg.projectId);
    // a turn was waiting on it and nothing else — nothing is now
    if (!ctx.queues.held.has(msg.projectId) && !running(ctx, msg.projectId)) drainQueue(ctx, msg.projectId);
  },
  queue_update: (ctx, ws, msg) => {
    const channelId = msg.projectId;
    const entry = ctx.queues.entries.get(channelId)?.find((e) => e.id === msg.itemId && e.editing);
    if (!entry) {
      // the queue lost it meanwhile (a restart, a stop that cleared it):
      // then this is simply a prompt, sent the ordinary way
      send(ctx, ws, {
        type: "send",
        projectId: channelId,
        text: msg.text,
        ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
      });
      return;
    }
    const uploads = msg.attachments ?? [];
    ctx.retries.cancelRetry(channelId);
    if (msg.text.trim().length === 0 && uploads.length === 0) {
      ctx.queues.placeBack(channelId, entry, []);
      ctx.queues.broadcastQueue(channelId);
      // rewritten to nothing: another agent's message taken out, as by its X
      talkDropped(ctx, entry.from);
      return;
    }
    // commands written into the rewrite run ahead of it, as always
    const { commands, rest } = splitCommands(msg.text, knownCommands(ownerProject(ctx, channelId)?.path));
    const entries: QueueEntry[] = commands.map((command) => ({
      id: randomUUID(),
      text: command,
      uploads: [],
      silent: false,
    }));
    if (rest || uploads.length > 0) {
      entries.push({
        id: entry.id,
        text: rest,
        uploads,
        silent: false,
        ...(msg.split ? { split: true } : {}),
        ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
        // rewritten by the user, still the other agent's message
        ...(entry.from ? { from: entry.from } : {}),
      });
    }
    ctx.queues.placeBack(channelId, entry, entries);
    // rewritten to commands alone: the message they replaced is taken out
    if (entry.from && !entries.some((e) => e.from)) talkDropped(ctx, entry.from);
    // sending the rewrite is a "go": a queue standing by since a stop
    // moves again, the way it does for any prompt sent
    ctx.queues.releaseQueue(channelId);
    ctx.queues.broadcastQueue(channelId);
    if (!running(ctx, channelId)) drainQueue(ctx, channelId);
  },
  queue_edit_cancel: (ctx, _ws, msg) => {
    const channelId = msg.projectId;
    const entry = ctx.queues.entries.get(channelId)?.find((e) => e.id === msg.itemId && e.editing);
    if (!entry) return;
    delete entry.editing;
    ctx.queues.placeBack(channelId, entry, [entry]);
    delete entry.editAfter;
    ctx.queues.broadcastQueue(channelId);
    if (!ctx.queues.held.has(channelId) && !running(ctx, channelId)) drainQueue(ctx, channelId);
  },
  interrupt: (ctx, _ws, msg) => {
    // The queue is not thrown away with the answer — it stands by. It
    // moves again on the next prompt (which goes ahead of it) or when
    // it is sent on from its own card.
    ctx.queues.cutIn.delete(msg.projectId);
    stopTurn(ctx, msg.projectId);
  },
  draft: (ctx, _ws, msg) => {
    // Every keystroke's worth of unsent prompt, held for the next
    // launch. Bytes arrive once, the first time an attachment is seen;
    // after that the client sends metadata alone and the file it already
    // stored stands. Nothing is deleted here — the ids are the ones the
    // prompt will send under, so a cleared draft must not take the file
    // a just-sent transcript event points at.
    const held = ctx.drafts.get(msg.projectId)?.attachments ?? [];
    const attachments = msg.attachments?.flatMap((att) => {
      const { data, regions, ...meta } = att;
      const drawn = regions?.length ? { regions } : {};
      if (data) return [{ ...meta, ...drawn, url: storeUpload({ ...meta, data }).url }];
      const stored = held.find((h) => h.id === att.id);
      return stored ? [{ ...meta, ...drawn, url: stored.url }] : [];
    });
    ctx.drafts.set(msg.projectId, msg.text, attachments);
    // a prompt that will start a fresh session is ranked against the
    // project as it goes: its meaning, ready before it is sent
    if (msg.text.trim().length >= 8 && freshNext(ctx, msg.projectId)) ctx.embedder.warm([msg.text], "query");
  },
  permission_response: (ctx, _ws, msg) => {
    // an agent asking to message another: ruri's own card, not the harness's
    if (answerTalk(ctx, msg.requestId, msg.allow)) return;
    ctx.manager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
    ctx.crewManager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
  },
  question_response: (ctx, _ws, msg) => {
    // The card is answered. If the tool call behind it is still waiting,
    // the answers go into it; if it has moved on (the turn ended, or the
    // CLI gave up on the hook), they go out as a prompt of their own —
    // never into a hole.
    const request = ctx.permissions.get(msg.requestId);
    let outcome = ctx.manager.respondQuestion(msg.requestId, msg.answers);
    if (outcome === "none") outcome = ctx.crewManager.respondQuestion(msg.requestId, msg.answers);
    if (outcome === "answered") return;
    if (outcome === "none") {
      ctx.permissions.delete(msg.requestId);
      ctx.clients.broadcast({ type: "permission_resolved", requestId: msg.requestId });
    }
    if (!msg.answers || !request || request.kind !== "question") return;
    const asked = (request.input as AskQuestions).questions;
    const lines = asked.flatMap((q) => {
      const answer = msg.answers?.answers[q.question]?.trim();
      if (!answer) return [];
      return [`- ${q.header ? `${q.header}: ` : ""}${q.question}\n  ${answer}`];
    });
    if (lines.length === 0) return;
    const text = `My answers to your questions:\n${lines.join("\n")}`;
    // an agent of the user's own asked: the answers are its, not the chat's
    if (request.agent) {
      followCrew(ctx, request.agent, text);
      return;
    }
    const channelId = request.projectId;
    if (busy(ctx, channelId)) {
      const queue = ctx.queues.entries.get(channelId) ?? [];
      queue.push({ id: randomUUID(), text, uploads: [], silent: false });
      ctx.queues.entries.set(channelId, queue);
      ctx.queues.broadcastQueue(channelId);
    } else {
      dispatch(ctx, channelId, text, []);
    }
  },
} satisfies Partial<Handlers>;
