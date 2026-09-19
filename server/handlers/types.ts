/**
 * The shape of a message handler: one function per client message type,
 * handed the context, the socket it came in on, and the message already
 * checked against its schema (shared/clientSchema.ts). Each domain's file
 * in server/handlers exports its share; handlers/index.ts puts them
 * together and the type there insists every message has one.
 */
import type { ClientMessage } from "../../shared/protocol.js";
import type { ClientConn, ServerContext } from "../context.js";

export type MessageType = ClientMessage["type"];

export type Handler<K extends MessageType> = (
  ctx: ServerContext,
  ws: ClientConn,
  msg: Extract<ClientMessage, { type: K }>,
) => void;

export type Handlers = { [K in MessageType]: Handler<K> };
