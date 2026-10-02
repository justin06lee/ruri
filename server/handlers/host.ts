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
  // macOS's dialogs are for whoever is in front of this Mac
  if (!host || ctx.clients.seats.has(ws)) return;
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
    // the dialog would open on this computer's screen, not in front of a
    // window on another device (server/sharing.ts)
    const pick = ctx.clients.seats.has(ws) ? undefined : ctx.options.pickFolder;
    void (pick?.() ?? Promise.resolve(null)).then((path) => {
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
  window_drag: (ctx, ws, msg) => {
    // a window on another device is carried by its own shell
    if (!ctx.clients.seats.has(ws)) ctx.options.windowDrag?.(msg.phase);
  },
} satisfies Partial<Handlers>;
