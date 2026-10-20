/**
 * Settings → project hooks (server/projectHooks.ts): the hooks and their
 * latest deliveries for the window that asks, changes to them, and the
 * "send test event" button. Every window hears `hooks` when anything
 * changes; a refusal goes to the window that asked, with the hooks as
 * they still stand.
 */
import type { ServerMessage } from "../../shared/protocol.js";
import type { ClientConn, ServerContext } from "../context.js";
import { hooksOf, hooksView, sendTestEvent } from "../projectHooks.js";
import type { Handlers } from "./types.js";

function reply(ctx: ServerContext, ws: ClientConn, error?: string): void {
  const message: ServerMessage = { type: "hooks", hooks: hooksView(ctx), ...(error ? { error } : {}) };
  ws.send(JSON.stringify(message));
}

export const hookHandlers = {
  hooks_get: (ctx, ws) => reply(ctx, ws),
  hooks_set: (ctx, ws, msg) => {
    // a chat's id is taken for its project's
    const projectId =
      msg.projectId === undefined
        ? undefined
        : (ctx.store.get(msg.projectId) ?? ctx.store.findSession(msg.projectId)?.project)?.id;
    if (msg.projectId !== undefined && !projectId) return reply(ctx, ws, "That project isn't open.");
    const { type: _type, ...change } = msg;
    const refused = hooksOf(ctx).set({ ...change, ...(projectId ? { projectId } : {}) });
    if (refused) reply(ctx, ws, refused);
  },
  hooks_test: (ctx, ws, msg) => {
    const refused = sendTestEvent(ctx, msg.projectId);
    if (refused) reply(ctx, ws, refused);
  },
} satisfies Partial<Handlers>;
