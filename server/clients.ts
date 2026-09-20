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
  /** The statistics page is up: it wants the resource meters running. */
  meters: boolean;
  /** Each chat that left the screen, and where it stood as it went. Back
   *  unchanged, it needs nothing; a few events on, it is sent those; and
   *  rewritten or long gone, it is sent whole again. */
  seen: Map<string, Mark>;
}

/** Where a chat stood: which shape of it (epoch), and how far along
 *  (revision). See `since` for what each of the two is for. */
export interface Mark {
  epoch: number;
  revision: number;
}

/**
 * How many events back a chat can be resumed from.
 *
 * Coming back to a chat you glanced away from used to re-send the whole
 * live transcript — everything since the last compaction, every time,
 * however little had happened while you were gone. Past this many events
 * it still does: a window that far behind is cheaper to re-seat than to
 * walk forward, and a long absence is the case the whole transcript is
 * actually the right answer for.
 */
const RESUME_MAX = 200;

/**
 * Bytes queued on a socket that has stopped taking them.
 *
 * Past this a window is not slow, it is gone — a laptop asleep mid-turn, a
 * renderer that has crashed without the socket noticing — and going on
 * writing to it only grows this process's memory. It is closed instead, and
 * the window reconnects and is sent a whole fresh snapshot
 * (web/src/store.ts retries every 1.5s). Terminal output, which is what
 * actually fills a socket, is paced long before this (server/relay.ts).
 */
const ABANDON = 8 * 1024 * 1024;

/** True when this socket can be written to at all. */
function writable(client: ClientConn): boolean {
  if (client.readyState !== WebSocket.OPEN) return false;
  if (client.bufferedAmount < ABANDON) return true;
  client.terminate();
  return false;
}

export class Clients {
  readonly sockets = new Set<ClientConn>();
  /** Told when a window goes, so what was queued for it can be let go
   *  (server/relay.ts). Set once, at startup. */
  onGone: ((ws: ClientConn) => void) | undefined;
  readonly views = new Map<ClientConn, ClientView>();
  /** Per channel, moved on by every change to its transcript. */
  readonly revisions = new Map<string, number>();
  /** Per channel, moved on only by a change that is not an addition — a
   *  compaction folding the past away, a rewind cutting it back. Windows
   *  holding an older shape of a chat cannot be walked forward into this
   *  one and are sent it whole. */
  readonly epochs = new Map<string, number>();
  /** Per channel, the events most recently pushed and the revision each
   *  left behind: what a window away for a moment is caught up from. The
   *  events are the archive's own, so this costs the array and nothing
   *  more. */
  private readonly recent = new Map<string, Array<{ revision: number; event: TranscriptEvent }>>();

  broadcast = (message: ServerMessage): void => {
    const payload = JSON.stringify(message);
    for (const client of this.sockets) {
      if (writable(client)) client.send(payload);
    }
  };

  touch = (channelId: string): void => {
    this.revisions.set(channelId, (this.revisions.get(channelId) ?? 0) + 1);
  };

  /** Where this chat stands, for a window putting it aside. */
  mark = (channelId: string): Mark => ({
    epoch: this.epochs.get(channelId) ?? 0,
    revision: this.revisions.get(channelId) ?? 0,
  });

  /** A chat re-made rather than added to: no window holding the old shape
   *  can be walked forward into this one. */
  rewrote = (channelId: string): void => {
    this.epochs.set(channelId, (this.epochs.get(channelId) ?? 0) + 1);
    this.recent.delete(channelId);
    this.touch(channelId);
  };

  /**
   * What a window last at `mark` has missed — or undefined when it cannot
   * be walked forward and wants the transcript whole.
   *
   * The events come back as they were pushed, which includes an event
   * pushed again because it changed (a tool call settling, an agent card
   * finishing). A window applies one the same way live or replayed: by id,
   * replacing what it holds or adding to it, which is what makes replaying
   * them enough.
   */
  since = (channelId: string, mark: Mark): TranscriptEvent[] | undefined => {
    if (mark.epoch !== (this.epochs.get(channelId) ?? 0)) return undefined;
    const now = this.revisions.get(channelId) ?? 0;
    if (mark.revision === now) return [];
    if (mark.revision > now) return undefined;
    const log = this.recent.get(channelId);
    if (log === undefined || log.length === 0) return undefined;
    // the oldest event the log still holds arrived at this revision; a
    // window from before it has lost the thread
    if (mark.revision < log[0]!.revision - 1) return undefined;
    return log.filter((entry) => entry.revision > mark.revision).map((entry) => entry.event);
  };

  /** To the windows showing this chat — and, `board`, to any on Home's
   *  projects page. A window that has not said what it shows (a script, the
   *  moment between the snapshot and its first view) is sent everything. */
  toViewers = (channelId: string, message: ServerMessage, board = false): void => {
    let payload: string | undefined;
    for (const client of this.sockets) {
      if (!writable(client)) continue;
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
    this.remember(channelId, event);
    if (event.kind === "result") this.broadcast({ type: "event", projectId: channelId, event });
    else this.toViewers(channelId, { type: "event", projectId: channelId, event }, true);
  };

  /** Keep this event against a window coming back for it. */
  private remember(channelId: string, event: TranscriptEvent): void {
    let log = this.recent.get(channelId);
    if (log === undefined) {
      log = [];
      this.recent.set(channelId, log);
    }
    log.push({ revision: this.revisions.get(channelId) ?? 0, event });
    if (log.length > RESUME_MAX) log.splice(0, log.length - RESUME_MAX);
  }

  /** Events taken out of a chat (a turn removed): they must not be
   *  replayed to a window catching up, which has already been told they
   *  are gone and would put them back. */
  forgetEvents(channelId: string, eventIds: string[]): void {
    const log = this.recent.get(channelId);
    if (log === undefined) return;
    const gone = new Set(eventIds);
    const kept = log.filter((entry) => !gone.has(entry.event.id));
    if (kept.length === log.length) return;
    this.recent.set(channelId, kept);
  }

  /** A chat gone: nothing left to be caught up on. */
  forgetChannel(channelId: string): void {
    this.revisions.delete(channelId);
    this.epochs.delete(channelId);
    this.recent.delete(channelId);
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
  if (seen !== undefined) {
    // what happened while it was away: the few events themselves where
    // there were few, and the whole live transcript where there were not
    const missed = ctx.clients.since(channelId, seen);
    if (missed === undefined) out.push(transcriptOf(ctx, channelId));
    else for (const event of missed) out.push({ type: "event", projectId: channelId, event });
  }
  const held = ctx.turns.gates.get(channelId);
  out.push({
    type: "reply",
    projectId: channelId,
    draft: held?.shown ? { messageId: held.messageId, text: held.shown } : null,
  });
  const turn = ctx.turns.progress.get(channelId);
  out.push({
    type: "turn",
    projectId: channelId,
    turn: turn ? { ...turn, tokens: Math.round(turn.tokens) } : null,
  });
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
  ctx.clients.rewrote(channelId);
  ctx.clients.toViewers(channelId, transcriptOf(ctx, channelId));
}
