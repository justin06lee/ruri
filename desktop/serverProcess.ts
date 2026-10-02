/**
 * The server, in a process of its own — the shell's end of it
 * (server/hostLink.ts says why it is not on this thread).
 *
 * Forked once the app is ready, told how to start, and answered whenever it
 * asks for something only the shell has. If it dies, another is started in
 * its place: the window's socket reconnects to it on the same port, the
 * bridge's windows stay where they were, and the next prompt picks each chat
 * up. A crash in the server used to be a crash in the app.
 */
import { utilityProcess, type UtilityProcess } from "electron";
import type { BridgeHost } from "../server/bridge.js";
import type { ShellCalls, ShellMethod, ShellStart, ToServer, ToShell } from "../server/hostLink.js";
import { errorMessage, warn } from "../server/log.js";
import type { CaptureHost } from "../server/shots.js";
import type { PermissionId, PermissionState, TccRow, WindowDragPhase } from "../shared/protocol.js";

/** What the shell does for the server. */
export interface ShellServices {
  pickFolder(): Promise<string | null>;
  capture: CaptureHost;
  bridge: BridgeHost;
  /** macOS's grants; absent where there are none to ask for. */
  permissions?: {
    check(): Promise<PermissionState[]>;
    request(id?: PermissionId): Promise<PermissionState[]>;
    rows(): Promise<TccRow[]>;
  };
  windowDrag(phase: WindowDragPhase): void;
}

/** A server that is listening. */
export interface ServerUp {
  port: number;
  /** Set when it could not have the port it was asked for (server/port.ts). */
  portFallback?: { wanted: number; reason: string };
}

/** How long to wait before starting another server after one died, by how
 *  many have died in a row. A server that dies as it starts is not hammered. */
const RESTART_MS = [500, 2_000, 10_000, 30_000];

/** A server that stays up this long has put its dying behind it. */
const STEADY_MS = 60_000;

export class ServerProcess {
  private child: UtilityProcess | undefined;
  private quitting = false;
  private closing: Promise<void> | undefined;
  /** Resolved when the current child exits. */
  private gone: (() => void) | undefined;
  private failures = 0;
  private startedAt = 0;
  private readonly answer: {
    [M in ShellMethod]: (...args: Parameters<ShellCalls[M]>) => ReturnType<ShellCalls[M]>;
  };

  /** Told each time a server comes up after the first. */
  onRestart: ((up: ServerUp) => void) | undefined;

  constructor(
    /** The server's bundled entry (server/desktopServer.ts, built). */
    private readonly entry: string,
    private readonly start: Pick<ShellStart, "port" | "token" | "staticDir" | "reclaimPort">,
    private readonly services: ShellServices,
  ) {
    const granted = () => {
      if (!services.permissions) throw new Error("there are no grants to ask for here");
      return services.permissions;
    };
    this.answer = {
      pickFolder: () => services.pickFolder(),
      capture: (url, targets) => services.capture(url, targets),
      "permissions.check": () => granted().check(),
      "permissions.request": (id) => granted().request(id),
      "permissions.rows": () => granted().rows(),
      "bridge.run": (ctx, call) => services.bridge.run(ctx, call),
      "bridge.close": (channelId) => services.bridge.close(channelId),
      "bridge.takeover": (channelId) => services.bridge.takeover(channelId),
      "bridge.release": (channelId) => services.bridge.release(channelId),
      "bridge.closeAll": () => services.bridge.closeAll(),
    };
    // the server keeps its own copy of what the bridge holds, for the
    // snapshot it sends a window that connects
    services.bridge.onState((channelId, state) => this.send({ type: "bridgeState", channelId, state }));
  }

  /** Start the server; resolves once it is listening. */
  launch(): Promise<ServerUp> {
    return new Promise((resolve, reject) => {
      const child = utilityProcess.fork(this.entry, [], {
        serviceName: "ruri server",
        stdio: "inherit",
        env: { ...process.env },
      });
      this.child = child;
      this.startedAt = Date.now();
      let up = false;
      child.once("spawn", () => {
        child.postMessage({
          type: "start",
          start: {
            ...this.start,
            appPid: process.pid,
            permissions: this.services.permissions !== undefined,
            bridges: this.services.bridge.states(),
          },
        } satisfies ToServer);
      });
      child.on("message", (message: ToShell) => {
        if (message.type === "ready") {
          up = true;
          resolve({
            port: message.port,
            ...(message.portFallback ? { portFallback: message.portFallback } : {}),
          });
          return;
        }
        if (message.type === "windowDrag") {
          this.services.windowDrag(message.phase);
          return;
        }
        this.serve(child, message.id, message.method, message.args);
      });
      child.once("exit", (code) => {
        if (this.child === child) this.child = undefined;
        this.gone?.();
        this.gone = undefined;
        if (!up) reject(new Error(`the server stopped (exit ${code}) before it was listening`));
        if (this.quitting || !up) return;
        warn("desktop", `exit ${code}`, "the server stopped; starting another");
        this.restart();
      });
    });
  }

  /** Close the server down — everything written, every harness stopped —
   *  and resolve once it has gone. Once, however many ask. */
  close(): Promise<void> {
    this.quitting = true;
    this.closing ??= new Promise<void>((resolve) => {
      const child = this.child;
      if (!child) {
        resolve();
        return;
      }
      this.gone = resolve;
      child.postMessage({ type: "close" } satisfies ToServer);
    });
    return this.closing;
  }

  private restart(): void {
    // a server that had been up a while starts its count of failures over
    if (Date.now() - this.startedAt > STEADY_MS) this.failures = 0;
    const delay = RESTART_MS[Math.min(this.failures, RESTART_MS.length - 1)]!;
    this.failures += 1;
    setTimeout(() => {
      if (this.quitting) return;
      this.launch().then(
        (up) => this.onRestart?.(up),
        (err: unknown) => {
          warn("desktop", err, "starting the server again");
          if (!this.quitting) this.restart();
        },
      );
    }, delay);
  }

  /** Do what the server asked, and tell it how that went — the child that
   *  asked, not one started since. */
  private serve(child: UtilityProcess, id: number, method: ShellMethod, args: unknown[]): void {
    const run = this.answer[method] as ((...args: unknown[]) => Promise<unknown>) | undefined;
    const reply = (message: ToServer) => {
      if (this.child === child) child.postMessage(message);
    };
    if (!run) {
      reply({ type: "reply", id, ok: false, error: `the shell does not do "${method}"` });
      return;
    }
    void Promise.resolve()
      .then(() => run(...args))
      .then(
        (value) => reply({ type: "reply", id, ok: true, value }),
        (err: unknown) => reply({ type: "reply", id, ok: false, error: errorMessage(err) }),
      );
  }

  private send(message: ToServer): void {
    this.child?.postMessage(message);
  }
}
