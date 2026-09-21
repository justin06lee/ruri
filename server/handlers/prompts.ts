/**
 * The composer's messages: a prompt sent (whole or split), the queue
 * behind a running turn rearranged, a turn stopped, a draft kept, and the
 * cards a turn raises answered. The prompt path itself is
 * server/dispatch.ts.
 */
import { randomUUID } from "node:crypto";
import type { AskQuestions } from "../../shared/protocol.js";
import { busy, channelProject, ownerProject, running } from "../channel.js";
import { knownCommands, splitCommands } from "../commands.js";
import { dispatch, dispatchSplit, drainQueue, queueWithCommands } from "../dispatch.js";
import { combine, reslot, uncombine, type QueueEntry } from "../queue.js";
import { storeAttachments, storeUpload } from "../uploads.js";
import { followCrew } from "./crew.js";
import type { Handler, Handlers } from "./types.js";

/** A prompt sent: now, or into the queue behind whatever is running. */
const send: Handler<"send"> = (ctx, _ws, msg) => {
  if (msg.text.trim().length === 0 && !msg.attachments?.length) return;
  const channelId = msg.projectId;
  const uploads = msg.attachments ?? [];
  // the user is driving again: whatever ruri was about to try again
  // for them, this prompt says it better
  ctx.retries.cancelRetry(channelId);
  // A queue that has been standing by since a stopped turn: this
  // prompt is the reason it stopped — a clarification, a correction —
  // so it goes out now, ahead of the queue, and the queue falls in
  // behind it and moves again the moment this turn is done.
  const ahead = ctx.queues.releaseQueue(channelId) && !running(ctx, channelId);
  if (queueWithCommands(ctx, channelId, msg.text, uploads, false, ahead)) return;
  if (!ahead && busy(ctx, channelId)) {
    // hold it app-side — nothing reaches the harness until the
    // running turn (and everything queued before it) finishes
    const queue = ctx.queues.entries.get(channelId) ?? [];
    queue.push({
      id: randomUUID(),
      text: msg.text,
      uploads,
      silent: false,
      ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
    });
    ctx.queues.entries.set(channelId, queue);
    ctx.queues.broadcastQueue(channelId);
    return;
  }
  dispatch(ctx, channelId, msg.text, uploads);
};

export const promptHandlers = {
  send,
  send_split: (ctx, _ws, msg) => {
    if (msg.text.trim().length === 0) return;
    const channelId = msg.projectId;
    const uploads = msg.attachments ?? [];
    ctx.retries.cancelRetry(channelId);
    if (!channelProject(ctx, channelId)) throw new Error("unknown session");
    const ahead = ctx.queues.releaseQueue(channelId) && !running(ctx, channelId);
    if (queueWithCommands(ctx, channelId, msg.text, uploads, true, ahead)) return;
    dispatchSplit(ctx, channelId, msg.text, uploads, ahead);
  },
  queue_remove: (ctx, _ws, msg) => {
    const queue = ctx.queues.entries.get(msg.projectId);
    if (!queue) return;
    const kept = queue.filter((e) => e.id !== msg.itemId || e.silent);
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
      });
    }
    ctx.queues.placeBack(channelId, entry, entries);
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
    ctx.queues.epochs.set(msg.projectId, (ctx.queues.epochs.get(msg.projectId) ?? 0) + 1);
    ctx.retries.cancelRetry(msg.projectId);
    // The queue is not thrown away with the answer — it stands by. It
    // moves again on the next prompt (which goes ahead of it) or when
    // it is sent on from its own card.
    ctx.queues.holdQueue(msg.projectId);
    ctx.manager.interrupt(msg.projectId);
    // settle the optimistic "working" a pending split may have shown
    ctx.clients.broadcast({
      type: "status",
      projectId: msg.projectId,
      status: ctx.manager.statuses()[msg.projectId] ?? "idle",
    });
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
  },
  permission_response: (ctx, _ws, msg) => {
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
