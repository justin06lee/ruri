/**
 * Prompts on screen before the server has them.
 *
 * Over a network a prompt's round trip is long enough to see: Enter, then
 * nothing, then the bubble. So the window shows a prompt the moment it is
 * sent — as the user's bubble with the chat working, or as a card in the
 * queue behind a running turn, wherever the server is going to put it —
 * under an id of its own, which the server then gives the real event or
 * queue entry (server/handlers/prompts.ts). The real one lands where the
 * guess stood and nothing moves.
 *
 * Until the server says it has a prompt (`sent`), the prompt is kept here
 * and laid back over anything the server sends that would otherwise wipe
 * it — a transcript sent whole, a queue sent whole, a status from a turn
 * that ended a moment before — and it is sent again on every new socket:
 * one that died with the prompt on the wire may or may not have delivered
 * it, and the server knows a prompt it has seen before by its id. Pure:
 * the store (store.ts) holds the prompts and does the sending.
 */
import type {
  ClientMessage,
  ProjectStatus,
  QueuedPrompt,
  QueueHold,
  TranscriptEvent,
} from "../../../shared/protocol";

export type PromptMessage = Extract<ClientMessage, { type: "send" | "send_split" }> & { clientId: string };

/** Where a prompt shows until the server says where it went. */
export type Shown = "event" | "queued" | "none";

export interface Outgoing {
  message: PromptMessage;
  /** As the user's bubble at the end of the transcript, as a card in the
   *  queue, or not at all — a command, whose bubble is the server's to make
   *  (it may become several prompts, or none). */
  shown: Shown;
  /** The bubble, when it shows as one: this object, so it is told apart
   *  from the server's event of the same id once that has replaced it. */
  event?: TranscriptEvent;
  /** The card, when it shows in the queue. */
  item?: QueuedPrompt;
  /** When it was written. */
  at: number;
  /** When it last went down a socket — unset while it waits for one (or
   *  for its files). Only a prompt on its way has the chat working: one the
   *  window is still holding has set nothing going. Past ASSUMED_MS without
   *  an answer the window stops insisting, and goes by what the server says. */
  onWire?: number;
}

/** How long a sent prompt keeps its chat "working" against what the
 *  server says, while the server has not yet said it has the prompt. */
export const ASSUMED_MS = 15_000;

/** What the window knows of a chat, as the server reads it when deciding
 *  where a prompt goes. */
export interface ChatNow {
  status: ProjectStatus | undefined;
  queued: QueuedPrompt[] | undefined;
  held: QueueHold | undefined;
}

/**
 * Where the server will put a prompt (server/handlers/prompts.ts, send):
 * cutting in or behind a running turn, into the queue; behind a queue
 * still moving, into the queue; otherwise out now, as the transcript's
 * next user event. A prompt that starts with a command is shown nowhere:
 * the server splits the commands out, and which of them become what is
 * not this window's guess to make.
 */
export function predict(chat: ChatNow, text: string, now: boolean): Shown {
  if (text.trimStart().startsWith("/")) return "none";
  const running = chat.status === "working" || chat.status === "permission";
  if (running) return "queued";
  // a queue standing by since a stop waits for this prompt, which goes now
  if (chat.held) return "event";
  const moving = (chat.queued ?? []).some((item) => !item.editing);
  // cutting in with nothing running is simply a send
  if (moving && !now) return "queued";
  return "event";
}

/** The window's own prompts for a chat, in the order they were sent. */
function mine(outgoing: Iterable<Outgoing>, channelId: string): Outgoing[] {
  return [...outgoing].filter((out) => out.message.projectId === channelId);
}

/** A transcript, with the prompts still on their way laid at its end —
 *  each that the server has not already put there itself. */
export function withOutgoing(
  channelId: string,
  events: TranscriptEvent[],
  outgoing: Iterable<Outgoing>,
): TranscriptEvent[] {
  const ours = mine(outgoing, channelId).flatMap((out) =>
    out.shown === "event" && out.event ? [out.event] : [],
  );
  if (ours.length === 0) return events;
  const have = new Set(events.map((event) => event.id));
  const missing = ours.filter((event) => !have.has(event.id));
  return missing.length === 0 ? events : [...events, ...missing];
}

/** A queue, with the window's own cards still on their way: a cut-in's at
 *  the head of the line, the rest at the back. */
export function withOutgoingItems(
  channelId: string,
  items: QueuedPrompt[],
  outgoing: Iterable<Outgoing>,
): QueuedPrompt[] {
  const ours = mine(outgoing, channelId).filter((out) => out.shown === "queued" && out.item);
  if (ours.length === 0) return items;
  const have = new Set(items.map((item) => item.id));
  const missing = ours.filter((out) => !have.has(out.item!.id));
  if (missing.length === 0) return items;
  const front = missing.filter((out) => out.message.now).map((out) => out.item!);
  const back = missing.filter((out) => !out.message.now).map((out) => out.item!);
  return [...front, ...items, ...back];
}

/** A chat's status, as the window should show it: working while a prompt
 *  it sent to go out now is on its way, whatever a turn that ended a
 *  moment before says. */
export function statusWithOutgoing(
  channelId: string,
  status: ProjectStatus,
  outgoing: Iterable<Outgoing>,
  now: number,
): ProjectStatus {
  if (status === "working" || status === "permission") return status;
  const sending = mine(outgoing, channelId).some(
    (out) => out.shown === "event" && out.onWire !== undefined && now - out.onWire < ASSUMED_MS,
  );
  return sending ? "working" : status;
}

/**
 * A new event's place in a chat held from before: at the end, unless the
 * chat already ends in a turn's result that came after it.
 *
 * A turn's end goes to every window, so a chat kept whole while it was off
 * screen gets its result and not the turn's events before it; those come
 * when it is opened again, and belong before the result, not after it.
 */
export function insertAt(events: TranscriptEvent[], event: TranscriptEvent): number {
  let at = events.length;
  while (at > 0) {
    const before = events[at - 1]!;
    if (before.kind !== "result" || event.kind === "result" || before.ts <= event.ts) break;
    at -= 1;
  }
  return at;
}
