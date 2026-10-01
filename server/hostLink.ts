/**
 * The server and the desktop shell, in two processes.
 *
 * The server used to run inside Electron's main process. That process's
 * JavaScript thread is also the browser's UI thread — the one every
 * keystroke, click and scroll passes through on its way to the window — so
 * whenever the server read a history, wrote an archive or waited on `git`,
 * the window waited with it. Now the shell forks the server into a process
 * of its own (desktop/serverProcess.ts) and the main thread is left to the
 * window.
 *
 * What the server needs that only the shell has — the bridge's windows, the
 * folder picker, the component screenshots, macOS's grants, carrying the
 * window by the band — it asks for over the port between them. This file is
 * both ends' vocabulary, and the server's end: `ShellLink.hooks()` stands in
 * for those services in StartServerOptions, so nothing else in the server
 * knows the shell is somewhere else.
 */
import type {
  BridgeState,
  PermissionId,
  PermissionState,
  TccRow,
  WindowDragPhase,
} from "../shared/protocol.js";
import type { BridgeCall, BridgeContext, BridgeHost, BridgeResult } from "./bridge.js";
import type { StartServerOptions } from "./context.js";
import type { ShotTarget } from "./shots.js";

/** What the shell starts the server with. Sent as a message rather than on
 *  the command line: the token is a secret, and a command line is anyone's
 *  to read. */
export interface ShellStart {
  port: number;
  token: string;
  staticDir: string;
  reclaimPort: boolean;
  /** The shell's own pid: the app the meters count, and the ruri a newer
   *  launch asks to stop for the port (server/port.ts). */
  appPid: number;
  /** Whether the shell can ask macOS for its grants (macOS only). */
  permissions: boolean;
  /** The bridge's channels already live — for a server started again after
   *  one that died, whose windows the shell kept. */
  bridges: Record<string, BridgeState>;
}

/** Everything the server asks the shell to do and waits on. */
export interface ShellCalls {
  pickFolder(): Promise<string | null>;
  capture(url: string, targets: ShotTarget[]): Promise<Record<string, string>>;
  "permissions.check"(): Promise<PermissionState[]>;
  "permissions.request"(id?: PermissionId): Promise<PermissionState[]>;
  "permissions.rows"(): Promise<TccRow[]>;
  "bridge.run"(ctx: BridgeContext, call: BridgeCall): Promise<BridgeResult>;
  "bridge.close"(channelId: string): Promise<void>;
  "bridge.takeover"(channelId: string): Promise<void>;
  "bridge.release"(channelId: string): Promise<void>;
  "bridge.closeAll"(): Promise<void>;
}

export type ShellMethod = keyof ShellCalls;

/** Shell → server. */
export type ToServer =
  | { type: "start"; start: ShellStart }
  | { type: "reply"; id: number; ok: true; value: unknown }
  | { type: "reply"; id: number; ok: false; error: string }
  | { type: "bridgeState"; channelId: string; state: BridgeState | null }
  | { type: "close" };

/** Server → shell. */
export type ToShell =
  | { type: "ready"; port: number; portFallback?: { wanted: number; reason: string } }
  | { type: "call"; id: number; method: ShellMethod; args: unknown[] }
  | { type: "windowDrag"; phase: WindowDragPhase };

/** The shell's services, as the server sees them. */
export type ShellHooks = Pick<
  StartServerOptions,
  "pickFolder" | "capture" | "permissions" | "bridge" | "windowDrag"
>;

/** The server's end of the port. */
export class ShellLink {
  private nextId = 1;
  private readonly waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly bridges: Record<string, BridgeState>;
  private readonly bridgeListeners: Array<(channelId: string, state: BridgeState | null) => void> = [];

  constructor(
    private readonly post: (message: ToShell) => void,
    private readonly start: ShellStart,
  ) {
    this.bridges = { ...start.bridges };
  }

  /** One message from the shell. */
  receive(message: ToServer): void {
    if (message.type === "reply") {
      const waiter = this.waiting.get(message.id);
      if (!waiter) return;
      this.waiting.delete(message.id);
      if (message.ok) waiter.resolve(message.value);
      else waiter.reject(new Error(message.error));
      return;
    }
    if (message.type === "bridgeState") {
      if (message.state) this.bridges[message.channelId] = message.state;
      else delete this.bridges[message.channelId];
      for (const listener of this.bridgeListeners) listener(message.channelId, message.state);
    }
  }

  private call<M extends ShellMethod>(
    method: M,
    ...args: Parameters<ShellCalls[M]>
  ): ReturnType<ShellCalls[M]> {
    const id = this.nextId++;
    const answer = new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.post({ type: "call", id, method, args });
    });
    return answer as ReturnType<ShellCalls[M]>;
  }

  /** What StartServerOptions takes from the shell. */
  hooks(): ShellHooks {
    const bridge: BridgeHost = {
      run: async (ctx, call) => {
        const result = await this.call("bridge.run", ctx, call);
        // a Buffer crosses the port as a plain Uint8Array
        if (!result.image) return result;
        const png = result.image.png as Uint8Array;
        return {
          ...result,
          image: { ...result.image, png: Buffer.from(png.buffer, png.byteOffset, png.byteLength) },
        };
      },
      close: (channelId) => this.call("bridge.close", channelId),
      takeover: (channelId) => this.call("bridge.takeover", channelId),
      release: (channelId) => this.call("bridge.release", channelId),
      states: () => ({ ...this.bridges }),
      onState: (listener) => {
        this.bridgeListeners.push(listener);
      },
      closeAll: () => this.call("bridge.closeAll"),
    };
    return {
      pickFolder: () => this.call("pickFolder"),
      capture: (url, targets) => this.call("capture", url, targets),
      ...(this.start.permissions
        ? {
            permissions: {
              check: () => this.call("permissions.check"),
              request: (id?: PermissionId) => this.call("permissions.request", id),
              rows: () => this.call("permissions.rows"),
            },
          }
        : {}),
      bridge,
      windowDrag: (phase) => this.post({ type: "windowDrag", phase }),
    };
  }
}
