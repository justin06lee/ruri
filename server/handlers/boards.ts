/**
 * The two boards beside a chat: the tracker (what the user asked for,
 * split out of their prompts, checked off in review) and the ideas board.
 */
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.js";
import { storedFilePath, storeUpload } from "../uploads.js";
import type { Handlers } from "./types.js";

export const boardHandlers = {
  tracker_add: (ctx, _ws, msg) => {
    if (!msg.text.trim()) return;
    ctx.tracker.add(msg.projectId, msg.text.trim(), "manual", undefined, msg.note ?? "");
    ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: ctx.tracker.items(msg.projectId) });
  },
  tracker_update: (ctx, _ws, msg) => {
    ctx.tracker.update(msg.projectId, msg.itemId, {
      ...(msg.status !== undefined ? { status: msg.status } : {}),
      ...(msg.note !== undefined ? { note: msg.note } : {}),
      ...(msg.text !== undefined ? { text: msg.text } : {}),
    });
    ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: ctx.tracker.items(msg.projectId) });
  },
  tracker_remove: (ctx, _ws, msg) => {
    ctx.tracker.remove(msg.projectId, msg.itemId);
    ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: ctx.tracker.items(msg.projectId) });
  },
  tracker_attach: (ctx, _ws, msg) => {
    const { url } = storeUpload(msg.upload);
    const { data: _d, regions: _r, ...meta } = msg.upload;
    if (ctx.tracker.attach(msg.projectId, msg.itemId, { ...meta, url })) {
      ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: ctx.tracker.items(msg.projectId) });
    }
  },
  tracker_detach: (ctx, _ws, msg) => {
    if (ctx.tracker.detach(msg.projectId, msg.itemId, msg.attachmentId)) {
      ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: ctx.tracker.items(msg.projectId) });
    }
  },
  tracker_review: (ctx, ws, msg) => {
    const channelId = msg.projectId;
    const items = ctx.tracker.items(channelId);
    if (!items.some((i) => i.status !== "open")) return;
    const rejectedItems = items.filter((i) => i.status === "rejected");
    // note attachments ride the prompt as stored paths
    const attachLines = rejectedItems
      .filter((i) => i.attachments?.length)
      .map(
        (i) =>
          `[attached for "${i.text}" — view with tools: ${i
            .attachments!.map((a) => storedFilePath(a.url ?? ""))
            .join(", ")}]`,
      )
      .join("\n");
    // outcomes apply immediately: liked verified → gone, rejected → repeats
    ctx.tracker.finishReview(channelId);
    ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: ctx.tracker.items(channelId) });
    if (rejectedItems.length === 0) return;
    // the fix-it prompt is assembled mechanically — each crossed item's
    // title with the user's note verbatim under it. No model call:
    // instant, and exactly what the user wrote.
    const lines = rejectedItems.map((i) => {
      const note = i.note.trim();
      return `- ${i.text}${note ? `\n${note.split("\n").map((l) => `  ${l}`).join("\n")}` : ""}`;
    });
    const text = `Fix these issues found while reviewing:\n${lines.join("\n")}`;
    if (ws.readyState === WebSocket.OPEN) {
      const full = attachLines ? `${text}\n\n${attachLines}` : text;
      ws.send(
        JSON.stringify({ type: "review_prompt", projectId: channelId, text: full } satisfies ServerMessage),
      );
    }
  },
  idea_add: (ctx, _ws, msg) => {
    const text = msg.text.trim();
    if (!text) return;
    ctx.ideas.add(msg.projectId, text);
    ctx.clients.broadcast({ type: "ideas", projectId: msg.projectId, items: ctx.ideas.items(msg.projectId) });
  },
  idea_update: (ctx, _ws, msg) => {
    ctx.ideas.update(msg.projectId, msg.ideaId, {
      ...(msg.text !== undefined ? { text: msg.text } : {}),
      ...(msg.done !== undefined ? { done: msg.done } : {}),
    });
    ctx.clients.broadcast({ type: "ideas", projectId: msg.projectId, items: ctx.ideas.items(msg.projectId) });
  },
  idea_remove: (ctx, _ws, msg) => {
    ctx.ideas.remove(msg.projectId, msg.ideaId);
    ctx.clients.broadcast({ type: "ideas", projectId: msg.projectId, items: ctx.ideas.items(msg.projectId) });
  },
} satisfies Partial<Handlers>;
