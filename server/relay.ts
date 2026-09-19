/**
 * A shell's output on its way to the windows, paced by what they can take.
 *
 * A pty is a firehose: `cargo build`, a test run, `cat` on something large,
 * and it prints faster than a window can parse a frame, lay out a screenful
 * and paint it. Every chunk used to go straight out to every socket with no
 * regard for whether anyone was keeping up, so the bytes piled into ws's own
 * send buffer — unbounded, invisible, and paid for in the server's memory —
 * while the window fell further behind on a queue it could not see.
 *
 * So output is held instead. A window with room takes its chunk the moment
 * it arrives; a window that is behind has the chunk added to what is already
 * waiting for it, and takes the lot as one message when its buffer drains.
 * Terminal output is a pure append stream, so joining what is waiting loses
 * nothing — a window catching up gets the same characters in the same order,
 * in fewer frames than it would have had.
 *
 * And when every window is behind, the shell itself is paused. That is the
 * only real backpressure there is: the pty stops being read, the program
 * writing to it blocks on its own write, and nothing accumulates anywhere —
 * which is exactly what happens in a terminal emulator you scroll away from.
 */
import { WebSocket } from "ws";
import type { ServerMessage } from "../shared/protocol.js";
import type { ClientConn } from "./context.js";

/** Bytes already queued on a socket before it is considered behind. One
 *  screenful of a noisy build, so ordinary output never takes this path. */
const HIGH_WATER = 256 * 1024;

/** Characters held for one window's tab before the oldest are dropped.
 *  Pausing the shell should keep a backlog far below this; it is here so a
 *  window that stops reading entirely cannot grow the server without end. */
const MAX_BACKLOG = 400_000;

/** How often a held window is looked at again. One frame at 60Hz: fast
 *  enough that catching up feels immediate, slow enough to coalesce. */
const DRAIN_MS = 16;

/** Bytes queued on a socket that is not draining at all. Past this it is
 *  not slow, it is gone: it is closed, and the window reconnects and is
 *  sent a fresh snapshot (web/src/store.ts retries). */
const ABANDON = 8 * 1024 * 1024;

interface Held {
  projectId: string;
  termId: string;
  text: string;
}

export class TerminalRelay {
  /** Per socket, the text waiting for each of its tabs. */
  private readonly backlogs = new Map<ClientConn, Map<string, Held>>();
  /** Tabs whose shell is paused because every window is behind on it. */
  private readonly paused = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  /**
   * @param sockets every window, live at the moment it is read
   * @param hold stop or restart reading a tab's shell (server/terminal.ts)
   */
  constructor(
    private readonly sockets: Iterable<ClientConn>,
    private readonly hold: (termId: string, held: boolean) => void,
  ) {}

  /** One chunk from a shell, out to the windows that can take it. */
  data(projectId: string, termId: string, data: string): void {
    if (data.length === 0) return;
    let payload: string | undefined;
    let behind = false;
    for (const ws of this.sockets) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (ws.bufferedAmount >= ABANDON) {
        ws.terminate();
        continue;
      }
      const waiting = this.backlogs.get(ws)?.get(termId);
      if (waiting === undefined && ws.bufferedAmount < HIGH_WATER) {
        payload ??= JSON.stringify(frame(projectId, termId, data));
        ws.send(payload);
        continue;
      }
      this.keep(ws, projectId, termId, data);
      behind = true;
    }
    if (behind) this.start();
  }

  /** Everything still waiting for this tab, out now: its shell has ended,
   *  and what it last said is the part worth having. */
  flush(termId: string): void {
    for (const [ws, held] of this.backlogs) {
      const waiting = held.get(termId);
      if (waiting === undefined) continue;
      held.delete(termId);
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame(waiting.projectId, termId, waiting.text)));
      if (held.size === 0) this.backlogs.delete(ws);
    }
    this.retune();
  }

  /** A window has gone: nothing is waiting for it any more. */
  forget(ws: ClientConn): void {
    if (this.backlogs.delete(ws)) this.retune();
  }

  /** Stop the drain loop — the server is shutting down. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private keep(ws: ClientConn, projectId: string, termId: string, data: string): void {
    let held = this.backlogs.get(ws);
    if (held === undefined) {
      held = new Map();
      this.backlogs.set(ws, held);
    }
    const waiting = held.get(termId);
    if (waiting === undefined) {
      held.set(termId, { projectId, termId, text: data });
      return;
    }
    waiting.text += data;
    // a window that has stopped reading altogether keeps only the newest
    if (waiting.text.length > MAX_BACKLOG) waiting.text = waiting.text.slice(-MAX_BACKLOG);
  }

  private start(): void {
    this.retune();
    if (this.timer !== undefined || this.backlogs.size === 0) return;
    this.timer = setInterval(this.drain, DRAIN_MS);
    // the drain loop must not be what keeps the process alive
    this.timer.unref?.();
  }

  private readonly drain = (): void => {
    for (const [ws, held] of this.backlogs) {
      if (ws.readyState !== WebSocket.OPEN) {
        this.backlogs.delete(ws);
        continue;
      }
      if (ws.bufferedAmount >= ABANDON) {
        ws.terminate();
        this.backlogs.delete(ws);
        continue;
      }
      for (const [termId, waiting] of held) {
        if (ws.bufferedAmount >= HIGH_WATER) break;
        held.delete(termId);
        ws.send(JSON.stringify(frame(waiting.projectId, termId, waiting.text)));
      }
      if (held.size === 0) this.backlogs.delete(ws);
    }
    this.retune();
    if (this.backlogs.size === 0) this.stop();
  };

  /** Pause the shells every window is behind on, restart the rest. */
  private retune(): void {
    const behind = new Set<string>();
    for (const held of this.backlogs.values()) for (const termId of held.keys()) behind.add(termId);
    for (const termId of this.paused) {
      if (behind.has(termId)) continue;
      this.paused.delete(termId);
      this.hold(termId, false);
    }
    for (const termId of behind) {
      if (this.paused.has(termId)) continue;
      this.paused.add(termId);
      this.hold(termId, true);
    }
  }
}

function frame(projectId: string, termId: string, data: string): ServerMessage {
  return { type: "terminal_data", projectId, termId, data };
}
