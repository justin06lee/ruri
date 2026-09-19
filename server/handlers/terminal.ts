/**
 * The composer's terminal mode: a row of shell tabs per channel, each in
 * that project's directory (server/terminal.ts runs them).
 */
import type { ServerMessage } from "../../shared/protocol.js";
import { terminalCwd } from "../channel.js";
import type { Handlers } from "./types.js";

export const terminalHandlers = {
  terminal_list: (ctx, ws, msg) => {
    ws.send(JSON.stringify({
      type: "terminal_tabs",
      projectId: msg.projectId,
      tabs: ctx.terminals.list(msg.projectId),
    } satisfies ServerMessage));
  },
  terminal_new: (ctx, _ws, msg) => {
    ctx.clients.broadcast({
      type: "terminal_tabs",
      projectId: msg.projectId,
      tabs: ctx.terminals.add(msg.projectId),
    });
  },
  terminal_open: (ctx, ws, msg) => {
    const attaching = ctx.terminals.has(msg.termId);
    if (
      !ctx.terminals.open(
        msg.projectId,
        msg.termId,
        terminalCwd(ctx, msg.projectId),
        msg.cols,
        msg.rows,
      )
    ) {
      ws.send(JSON.stringify({
        type: "terminal_exit",
        projectId: msg.projectId,
        termId: msg.termId,
        note: "no shell could be started here",
      } satisfies ServerMessage));
      return;
    }
    // a shell that was already running answers with what it has printed,
    // so the panel opens where you left it
    if (attaching) {
      ws.send(JSON.stringify({
        type: "terminal_data",
        projectId: msg.projectId,
        termId: msg.termId,
        data: ctx.terminals.scrollback(msg.termId),
        replay: true,
      } satisfies ServerMessage));
    }
  },
  terminal_input: (ctx, _ws, msg) => {
    ctx.terminals.write(msg.termId, msg.data);
  },
  terminal_resize: (ctx, _ws, msg) => {
    ctx.terminals.resize(msg.termId, msg.cols, msg.rows);
  },
  terminal_close: (ctx, _ws, msg) => {
    ctx.clients.broadcast({
      type: "terminal_tabs",
      projectId: msg.projectId,
      tabs: ctx.terminals.close(msg.projectId, msg.termId),
    });
  },
} satisfies Partial<Handlers>;
