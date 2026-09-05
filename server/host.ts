import type { WebSocket } from "ws";
import type { BridgeState } from "../shared/protocol.js";
import type { BridgeCall, BridgeContext, BridgeHost, BridgeResult } from "./bridge.js";
import type { ShotTarget } from "./shots.js";

/**
 * The desktop shell, reached over a socket.
 *
 * The server runs on its own, detached from the app that opened it, so that
 * quitting the app — or replacing it with a newer one — never takes a
 * session with it. What the server cannot do without the app is anything
 * that needs a window: the folder picker, the component screenshots, and
 * the bridge's hidden browser and launched apps. The shell connects here
 * (`/host` on the server's port) and answers those calls; when it is away,
 * they say so instead of hanging.
 *
 * One shell at a time. A second one connecting replaces the first — the
 * newer app is the one that should be answering.
 */

/** What the shell says on arrival. */
export interface HostHello {
  version: string;
  /** Where the installed app is — the path the next server is spawned from. */
  appPath?: string;
  states?: Record<string, BridgeState>;
}

type Reply = { type: "reply"; id: number; ok: boolean; result?: unknown; error?: string };
type Inbound =
  | ({ type: "hello" } & HostHello)
  | Reply
  | { type: "bridge_state"; channelId: string; state: BridgeState | null };

const AWAY = "ruri's window is not open — nothing can be shown until the app is running.";

export class HostLink implements BridgeHost {
  private socket: WebSocket | null = null;
  private hello: HostHello | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly stateListeners: Array<(channelId: string, state: BridgeState | null) => void> = [];
  private readonly helloListeners: Array<(hello: HostHello) => void> = [];
  private known: Record<string, BridgeState> = {};

  get connected(): boolean {
    return this.socket !== null;
  }

  /** The shell's version and install path, once it has said hello. */
  shell(): HostHello | null {
    return this.hello;
  }

  /** Told whenever a shell arrives (with what it said). */
  onHello(listener: (hello: HostHello) => void): void {
    this.helloListeners.push(listener);
  }

  /** A shell connected: it answers from now on. */
  attach(socket: WebSocket): void {
    if (this.socket && this.socket !== socket) {
      const old = this.socket;
      this.socket = null;
      old.close();
    }
    this.socket = socket;
    socket.on("message", (raw) => {
      let msg: Inbound;
      try {
        msg = JSON.parse(String(raw)) as Inbound;
      } catch {
        return;
      }
      if (msg.type === "hello") {
        const { type: _t, ...hello } = msg;
        this.hello = hello;
        // what the shell already holds: the snapshot a client gets next
        const was = this.known;
        this.known = hello.states ?? {};
        for (const id of Object.keys(was)) if (!(id in this.known)) this.emit(id, null);
        for (const [id, state] of Object.entries(this.known)) this.emit(id, state);
        for (const listener of this.helloListeners) listener(hello);
      } else if (msg.type === "reply") {
        const waiting = this.pending.get(msg.id);
        if (!waiting) return;
        this.pending.delete(msg.id);
        if (msg.ok) waiting.resolve(msg.result);
        else waiting.reject(new Error(msg.error ?? "the shell could not do that"));
      } else if (msg.type === "bridge_state") {
        if (msg.state) this.known[msg.channelId] = msg.state;
        else delete this.known[msg.channelId];
        this.emit(msg.channelId, msg.state);
      }
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.hello = null;
      for (const waiting of this.pending.values()) waiting.reject(new Error(AWAY));
      this.pending.clear();
      // the windows went with the shell: every channel's picture is gone
      const gone = Object.keys(this.known);
      this.known = {};
      for (const id of gone) this.emit(id, null);
    });
  }

  private emit(channelId: string, state: BridgeState | null): void {
    for (const listener of this.stateListeners) listener(channelId, state);
  }

  private call<T>(method: string, ...args: unknown[]): Promise<T> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(AWAY));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      socket.send(JSON.stringify({ type: "call", id, method, args }), (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
      });
    });
  }

  /* ── BridgeHost ───────────────────────────────────────────────────── */

  async run(ctx: BridgeContext, call: BridgeCall): Promise<BridgeResult> {
    const raw = await this.call<{ text: string; image?: { png: string; path: string } }>("bridge.run", ctx, call);
    return {
      text: raw.text,
      ...(raw.image ? { image: { png: Buffer.from(raw.image.png, "base64"), path: raw.image.path } } : {}),
    };
  }

  close(channelId: string): Promise<void> {
    return this.call<void>("bridge.close", channelId).catch(() => undefined);
  }

  takeover(channelId: string): Promise<void> {
    return this.call<void>("bridge.takeover", channelId).catch(() => undefined);
  }

  release(channelId: string): Promise<void> {
    return this.call<void>("bridge.release", channelId).catch(() => undefined);
  }

  states(): Record<string, BridgeState> {
    return { ...this.known };
  }

  onState(listener: (channelId: string, state: BridgeState | null) => void): void {
    this.stateListeners.push(listener);
  }

  closeAll(): Promise<void> {
    return this.call<void>("bridge.closeAll").catch(() => undefined);
  }

  /* ── the rest of what needs a window ──────────────────────────────── */

  pickFolder(): Promise<string | null> {
    return this.call<string | null>("pickFolder");
  }

  capture(url: string, targets: ShotTarget[]): Promise<Record<string, string>> {
    return this.call<Record<string, string>>("capture", url, targets);
  }
}
