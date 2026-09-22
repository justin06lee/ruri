/**
 * What the desktop shell lends the server, asked for from a window: its
 * folder picker, macOS's grants, the bridge's windows, and the app window
 * itself to carry (each absent when ruri runs headless, and then these do
 * nothing).
 */
import { WebSocket } from "ws";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";
import type { ClientConn, ServerContext } from "../context.js";
import type { Handlers } from "./types.js";

/** macOS's grants as they stand — or asked for, which is the dialog. */
function permissions(
  ctx: ServerContext,
  ws: ClientConn,
  msg: Extract<ClientMessage, { type: "permissions_check" | "permissions_request" }>,
): void {
  const host = ctx.options.permissions;
  if (!host) return;
  const asked = msg.type === "permissions_request" ? host.request(msg.id) : host.check();
  void asked
    .then(async (items) => ({ items, rows: await host.rows() }))
    .then(({ items, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "permissions", items, rows } satisfies ServerMessage));
      }
    })
    .catch(() => {});
}

export const hostHandlers = {
  pick_folder: (ctx, ws, msg) => {
    const target = msg.target ?? "workspace";
    void (ctx.options.pickFolder?.() ?? Promise.resolve(null)).then((path) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "folder_picked", path, target } satisfies ServerMessage));
      }
    });
  },
  permissions_check: permissions,
  permissions_request: permissions,
  bridge_takeover: (ctx, _ws, msg) => {
    void ctx.options.bridge?.takeover(msg.projectId);
  },
  bridge_release: (ctx, _ws, msg) => {
    void ctx.options.bridge?.release(msg.projectId);
  },
  bridge_close: (ctx, _ws, msg) => {
    void ctx.options.bridge?.close(msg.projectId);
  },
  window_drag: (ctx, _ws, msg) => {
    ctx.options.windowDrag?.(msg.phase);
  },
} satisfies Partial<Handlers>;
