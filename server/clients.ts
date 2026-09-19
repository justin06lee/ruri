/**
 * The windows: every socket, what each has on screen, and the ways a
 * message reaches them — everyone, or only the windows showing a chat.
 */
import { WebSocket } from "ws";
import type { ServerMessage, TranscriptEvent } from "../shared/protocol.js";
import type { ClientConn, ServerContext } from "./context.js";

/**
 * What each window has on screen (the `view` message).
 *
 * A chat's conversation as it happens — a reply's paragraphs, each tool
 * call, its agents at work, the turn's counter — goes only to the windows
 * showing that chat. Every other window hears the chat's status and its
 * finished turns, and catches up the moment the chat is opened. Before,
 * every agent's every step re-rendered a window that was showing none of
 * them.
 */
export interface ClientView {
  /** The chats on screen, whether or not the window can be seen. */
  channels: Set<string>;
  /** Home's projects page is up: it shows every chat's last few lines. */
  board: boolean;
  /** Each chat that left the screen, and its revision as it went. Back
   *  unchanged, it needs nothing; changed, it is sent whole again. */
  seen: Map<string, number>;
}

export class Clients {
  readonly sockets = new Set<ClientConn>();
  readonly views = new Map<ClientConn, ClientView>();
  /** Per channel, moved on by every change to its transcript. */
  readonly revisions = new Map<string, number>();

  broadcast = (message: ServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const client of this.sockets) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  };

  touch = (channelId: string): void => {
    this.revisions.set(channelId, (this.revisions.get(channelId) ?? 0) + 1);
  };

  /** To the windows showing this chat — and, `board`, to any on Home's
   *  projects page. A window that has not said what it shows (a script, the
   *  moment between the snapshot and its first view) is sent everything. */
  toViewers = (channelId: string, message: ServerMessage, board = false): void => {
    let payload: string | undefined;
    for (const client of this.sockets) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const view = this.views.get(client);
      if (view && !(view.channels.has(channelId) || (board && view.board))) continue;
      payload ??= JSON.stringify(message);
      client.send(payload);
    }
  };

  /** Some window has this chat open, seen or not — what keeps its agent
   *  process warm between turns. */
  isOpen = (channelId: string): boolean => {
    for (const view of this.views.values()) if (view.channels.has(channelId)) return true;
    return false;
  };

  /** One transcript event out: to the windows showing its chat and the
   *  projects page — and a turn's end to every window, which is how a chat
   *  not on screen gets its "finished" pip. */
  pushEvent = (channelId: string, event: TranscriptEvent): void => {
    this.touch(channelId);
    if (event.kind === "result") this.broadcast({ type: "event", projectId: channelId, event });
    else this.toViewers(channelId, { type: "event", projectId: channelId, event }, true);
  };

  /** A chat gone: nothing left to be caught up on. */
  forgetChannel(channelId: string): void {
    this.revisions.delete(channelId);
    for (const view of this.views.values()) view.seen.delete(channelId);
  }
}

/** A channel's live transcript, whole, as a window takes it. */
export function transcriptOf(ctx: ServerContext, channelId: string): ServerMessage {
  const events = ctx.archive.events(channelId);
  ctx.readable.allowReadImages(channelId, events);
  return {
    type: "transcript",
    projectId: channelId,
    events,
    summaries: ctx.archive.allSummaries([channelId])[channelId] ?? {},
    earlier: ctx.archive.earlier(channelId),
  };
}

/** A chat just come on screen in `ws`: whatever it missed while it was
 *  not. Never shown here before, the window holds only its tail and asks
 *  for the rest itself (transcript_get). */
export function catchUp(ctx: ServerContext, ws: ClientConn, view: ClientView, channelId: string): void {
  const seen = view.seen.get(channelId);
  view.seen.delete(channelId);
  const out: ServerMessage[] = [];
  if (seen !== undefined && seen !== (ctx.clients.revisions.get(channelId) ?? 0)) out.push(transcriptOf(ctx, channelId));
  const held = ctx.turns.gates.get(channelId);
  out.push({
    type: "reply",
    projectId: channelId,
    draft: held?.shown ? { messageId: held.messageId, text: held.shown } : null,
  });
  const turn = ctx.turns.progress.get(channelId);
  out.push({ type: "turn", projectId: channelId, turn: turn ? { ...turn, tokens: Math.round(turn.tokens) } : null });
  // the agents the user started here moved on without this window
  const agents = ctx.crew.list(channelId);
  if (agents.length > 0) out.push({ type: "crew", projectId: channelId, agents });
  for (const message of out) ws.send(JSON.stringify(message));
}

/** A channel's live transcript to the windows showing it, replacing what
 *  they hold: after anything that rewrites it rather than adding to it — a
 *  compaction folding the past away, a rewind reaching back into it. The
 *  rest are sent it when they open the chat (catchUp). */
export function pushTranscript(ctx: ServerContext, channelId: string): void {
  ctx.clients.touch(channelId);
  ctx.clients.toViewers(channelId, transcriptOf(ctx, channelId));
}
