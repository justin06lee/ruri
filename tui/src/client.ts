/**
 * The terminal's line to ruri's server: the same WebSocket the desktop
 * window opens (server/socket.ts), kept open. It dials again when the line
 * drops — the app quit, updated itself, or the laptop slept — a little
 * later each time, and pings so a line that died without saying so is
 * noticed. What it carries is shared/protocol.ts and nothing of its own.
 */
import type { ClientMessage, ServerMessage } from "../../shared/protocol";

/** As much of a WebSocket as this needs: `ws`'s, the browser's, or a
 *  stand-in's in a test. */
export interface Wire {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
}

export type Dial = () => Wire;

export interface Line {
  /** False when the line is down: the caller keeps what it meant to say. */
  send(message: ClientMessage): boolean;
  close(): void;
}

const RETRY_MS = [500, 1000, 2000, 4000, 8000];
const PING_MS = 20_000;

export function connect(
  dial: Dial,
  on: { open: () => void; message: (message: ServerMessage) => void; close: () => void },
): Line {
  let wire: Wire | undefined;
  let up = false;
  let closed = false;
  let tries = 0;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let ping: ReturnType<typeof setInterval> | undefined;
  /** A ping not yet answered: one more unanswered and the line is dead. */
  let waiting = false;

  const down = (from: Wire) => {
    if (wire !== from) return;
    wire = undefined;
    clearInterval(ping);
    if (up) on.close();
    up = false;
    if (closed) return;
    const wait = RETRY_MS[Math.min(tries, RETRY_MS.length - 1)]!;
    tries += 1;
    retry = setTimeout(open, wait);
  };

  const open = () => {
    if (closed) return;
    let next: Wire;
    try {
      next = dial();
    } catch {
      retry = setTimeout(open, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]!);
      return;
    }
    wire = next;
    next.onopen = () => {
      if (wire !== next) return;
      up = true;
      tries = 0;
      waiting = false;
      on.open();
      ping = setInterval(() => {
        if (waiting) {
          next.close();
          down(next);
          return;
        }
        waiting = true;
        try {
          next.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
        } catch {
          // the close that follows says so
        }
      }, PING_MS);
    };
    next.onmessage = (event) => {
      if (wire !== next) return;
      waiting = false;
      try {
        on.message(JSON.parse(String(event.data)) as ServerMessage);
      } catch {
        // a frame that is not a message is nothing to act on
      }
    };
    next.onclose = () => down(next);
    // the close that follows an error is what is acted on
    next.onerror = () => {};
  };

  open();
  return {
    send(message) {
      if (!wire || !up) return false;
      try {
        wire.send(JSON.stringify(message));
        return true;
      } catch {
        return false;
      }
    },
    close() {
      closed = true;
      clearTimeout(retry);
      clearInterval(ping);
      const last = wire;
      wire = undefined;
      last?.close();
    },
  };
}
