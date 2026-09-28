/**
 * What the server said while nobody was looking at the window, held unread.
 *
 * Asleep (lib/awake.ts) the window applies nothing: the server stops
 * sending its chats (the view's `live`), and the little that still comes —
 * a status, a gauge, a finished turn elsewhere — waits here instead of
 * being applied, so the page does no work at all: no store change, no
 * render, no layout. Waking takes the lot and applies it in one go
 * (store.ts), which is one render.
 *
 * A message that only says what something now is (a chat's status, the
 * gauges, the project list) replaces the one held before it, and a shell's
 * output is joined onto what is already waiting — so a window left behind
 * another app all day holds a handful of messages, not a day of them.
 * Pure: messages in, messages out.
 */
import type { ServerMessage } from "../../../shared/protocol";

/** Past this many held, they are given up: a window that far behind is
 *  cheaper to hand a fresh snapshot than to play back. */
const MAX = 4000;
/** How much of one shell's output is kept — the relay's own cap for a
 *  window that has stopped reading (server/relay.ts). */
const TERMINAL_MAX = 400_000;

/** What a message would replace, if it only says what something now is. */
function keyOf(msg: ServerMessage): string | undefined {
  switch (msg.type) {
    case "status":
    case "context":
    case "stats":
    case "work":
    case "queued":
    case "bridge":
    case "terminal_tabs":
      return `${msg.type}:${msg.projectId}`;
    case "usage":
    case "talk":
    case "projects":
    case "models":
    case "harnesses":
    case "resources":
      return msg.type;
    default:
      return undefined;
  }
}

export class Held {
  private messages: Array<ServerMessage | undefined> = [];
  /** Where the held message each key would replace sits. */
  private readonly at = new Map<string, number>();
  private overflow = false;

  constructor(
    private readonly max = MAX,
    private readonly terminalMax = TERMINAL_MAX,
  ) {}

  hold(msg: ServerMessage): void {
    // a fresh snapshot is everything: what was held before it is moot
    if (msg.type === "snapshot") this.clear();
    if (this.overflow) return;
    if (msg.type === "terminal_data") {
      // a shell's output is one stream: joined onto what already waits for
      // it, the newest kept when there is too much
      const key = `terminal:${msg.termId}`;
      const at = this.at.get(key);
      const waiting = at === undefined ? undefined : this.messages[at];
      if (at !== undefined && waiting?.type === "terminal_data" && waiting.replay === msg.replay) {
        const data = waiting.data + msg.data;
        this.messages[at] = {
          ...waiting,
          data: data.length > this.terminalMax ? data.slice(-this.terminalMax) : data,
        };
        return;
      }
      this.at.set(key, this.messages.length);
      this.messages.push(msg);
      return;
    }
    // a shell that ended takes nothing more onto its held output
    if (msg.type === "terminal_exit") this.at.delete(`terminal:${msg.termId}`);
    const key = keyOf(msg);
    if (key !== undefined) {
      const at = this.at.get(key);
      if (at !== undefined) this.messages[at] = undefined;
      this.at.set(key, this.messages.length);
    }
    this.messages.push(msg);
    if (this.messages.length > this.max) {
      this.clear();
      this.overflow = true;
    }
  }

  /** Everything held, in the order it came, and none of it held any more —
   *  or "overflow" when too much went by to be worth playing back. */
  take(): ServerMessage[] | "overflow" {
    const overflow = this.overflow;
    const messages = this.messages.filter((msg): msg is ServerMessage => msg !== undefined);
    this.clear();
    return overflow ? "overflow" : messages;
  }

  private clear(): void {
    this.messages = [];
    this.at.clear();
    this.overflow = false;
  }
}
