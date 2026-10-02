/**
 * Sharing, asked for from a window: turn it on or off, make an invite,
 * unpair a device (server/sharing.ts). A window on another device may
 * invite and unpair — that is how a computer nobody sits at is looked
 * after — but not turn sharing off, which would shut the door it is
 * standing in.
 */
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.js";
import type { ClientConn } from "../context.js";
import { errorMessage } from "../log.js";
import type { Handlers } from "./types.js";

function reply(ws: ClientConn, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export const sharingHandlers = {
  sharing_set: (ctx, ws, msg) => {
    if (!msg.on && ctx.clients.seats.has(ws)) {
      reply(ws, {
        type: "error",
        message: `This window reaches ${ctx.sharing.info().name} through sharing — turn it off there.`,
      });
      return;
    }
    void ctx.sharing.set(msg.on);
  },
  sharing_invite: (ctx, ws) => {
    ctx.sharing.invite().then(
      ({ words, expires }) => reply(ws, { type: "sharing_invite", words, expires }),
      (err: unknown) => reply(ws, { type: "error", message: `No invite: ${errorMessage(err)}` }),
    );
  },
  sharing_forget: (ctx, _ws, msg) => {
    ctx.sharing.forget(msg.deviceId);
  },
} satisfies Partial<Handlers>;
