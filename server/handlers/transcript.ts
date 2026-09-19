/**
 * What a window reads of a chat: the rest of a transcript past its tail,
 * the history before a compaction, which chats it has on screen (and so
 * which it hears about as they happen) — and a turn taken out, or Home
 * wiped clean.
 */
import { TRANSCRIPT_TAIL, type ServerMessage } from "../../shared/protocol.js";
import { catchUp, transcriptOf } from "../clients.js";
import { removeTurnFiles } from "../compaction.js";
import { HOME_ID } from "../manager.js";
import { backfillNotes } from "../notes.js";
import type { Handlers } from "./types.js";

export const transcriptHandlers = {
  transcript_get: (ctx, ws, msg) => {
    // the rest of a chat the snapshot only carried the tail of — to
    // the asker alone, with its pictures made readable on the way
    const id = msg.projectId;
    if (id !== HOME_ID && !ctx.store.sessionIds().includes(id)) return;
    ws.send(JSON.stringify(transcriptOf(ctx, id)));
    // the chat on screen gets its missing notes before any other
    backfillNotes(ctx, [id], { first: true });
    // and its digest caught up, ahead of the compaction it may be near
    void ctx.digests.run(id);
  },
  history_get: (ctx, ws, msg) => {
    const id = msg.projectId;
    if (id !== HOME_ID && !ctx.store.sessionIds().includes(id)) return;
    const events = ctx.archive.history(id);
    ctx.readable.allowReadImages(id, events);
    ws.send(JSON.stringify({ type: "history", projectId: id, events } satisfies ServerMessage));
  },
  view: (ctx, ws, msg) => {
    const known = new Set([...ctx.store.sessionIds(), HOME_ID]);
    const view = ctx.clients.views.get(ws) ?? { channels: new Set<string>(), board: false, seen: new Map() };
    const before = view.channels;
    const hadBoard = view.board;
    view.channels = new Set(msg.channels.filter((id) => known.has(id)));
    view.board = msg.board === true;
    ctx.clients.views.set(ws, view);
    const now = view.channels;
    for (const id of before) if (!now.has(id)) view.seen.set(id, ctx.clients.revisions.get(id) ?? 0);
    for (const id of now) if (!before.has(id)) catchUp(ctx, ws, view, id);
    // the projects page coming up: every chat's tail as it now stands,
    // since the ones not on screen stopped hearing about their work
    if (view.board && !hadBoard) {
      const others = [...known].filter((id) => !now.has(id));
      ws.send(
        JSON.stringify({
          type: "tails",
          transcripts: ctx.readable.allowArchived(ctx.archive.tails(others, TRANSCRIPT_TAIL)),
        } satisfies ServerMessage),
      );
    }
    // a chat opened or left: its process looks again at whether it stays
    for (const id of new Set([...before, ...now])) {
      if (before.has(id) !== now.has(id)) ctx.manager.settle(id);
    }
  },
  remove_event: (ctx, _ws, msg) => {
    const removed = ctx.archive.removeTurn(msg.projectId, msg.eventId);
    if (removed.length > 0) {
      ctx.clients.broadcast({ type: "events_removed", projectId: msg.projectId, eventIds: removed });
      // a removed turn takes its extracted checklist items with it
      if (ctx.tracker.removeForTurns(msg.projectId, removed)) {
        ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: ctx.tracker.items(msg.projectId) });
      }
    }
  },
  reset_home: (ctx) => {
    // Skipped while a turn is in flight — it may still be opening
    // projects; the next navigation resets it once it's quiet.
    const status = ctx.manager.statuses()[HOME_ID];
    if (status === "working" || status === "permission") return;
    ctx.manager.dispose(HOME_ID);
    ctx.archive.remove(HOME_ID);
    removeTurnFiles(HOME_ID);
    ctx.agentLogs.remove(HOME_ID);
    ctx.homeLog.endSession();
    ctx.queues.entries.delete(HOME_ID);
    ctx.queues.held.delete(HOME_ID);
    ctx.turns.contexts.delete(HOME_ID);
    ctx.retries.cancelRetry(HOME_ID);
    ctx.clients.broadcast({ type: "home_reset" });
  },
} satisfies Partial<Handlers>;
