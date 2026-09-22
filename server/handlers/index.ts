/**
 * Every client message, routed to its domain's handler. The table's type
 * names every message type, so one without a handler does not compile.
 */
import type { ClientMessage } from "../../shared/protocol.js";
import type { ClientConn, ServerContext } from "../context.js";
import { boardHandlers } from "./boards.js";
import { componentHandlers } from "./components.js";
import { crewHandlers } from "./crew.js";
import { hostHandlers } from "./host.js";
import { integrationHandlers } from "./integrations.js";
import { projectHandlers } from "./projects.js";
import { promptHandlers } from "./prompts.js";
import { rewindHandlers } from "./rewind.js";
import { settingHandlers } from "./settings.js";
import { skillHandlers } from "./skills.js";
import { terminalHandlers } from "./terminal.js";
import { transcriptHandlers } from "./transcript.js";
import type { Handler, Handlers, MessageType } from "./types.js";

const HANDLERS: Handlers = {
  ...projectHandlers,
  ...promptHandlers,
  ...rewindHandlers,
  ...transcriptHandlers,
  ...crewHandlers,
  ...terminalHandlers,
  ...boardHandlers,
  ...componentHandlers,
  ...skillHandlers,
  ...settingHandlers,
  ...hostHandlers,
  ...integrationHandlers,
};

/** One message, already checked against its schema, to its handler. */
export function handleMessage(ctx: ServerContext, ws: ClientConn, msg: ClientMessage): void {
  const handler = HANDLERS[msg.type] as Handler<MessageType> | undefined;
  if (!handler) throw new Error(`unknown message type: ${JSON.stringify(msg)}`);
  handler(ctx, ws, msg as never);
}
