import WebSocket from "ws";
import type { BridgeHost } from "../server/bridge.js";
import type { ShotTarget } from "../server/shots.js";

/**
 * The shell's end of the /host socket: it answers the server's calls for
 * the things only a window can do — the folder picker, the component
 * screenshots, the bridge — and keeps the bridge's state flowing back.
 * Reconnects on its own; `onDown` is how the launcher learns the server
 * has gone (and starts a new one).
 */
export interface HostServices {
  version: string;
  appPath: string;
  bridge: BridgeHost;
  pickFolder(): Promise<string | null>;
  capture(url: string, targets: ShotTarget[]): Promise<Record<string, string>>;
}

export class HostClient {
  private socket: WebSocket | null = null;
  private closed = false;
  private attempts = 0;

  constructor(
    private readonly port: number,
    private readonly services: HostServices,
    /** The socket dropped and could not be re-established quickly. */
    private readonly onDown: () => Promise<void>,
    /** Connected (again), and the server said which version it is. */
    private readonly onUp: () => void,
  ) {
    services.bridge.onState((channelId, state) => this.send({ type: "bridge_state", channelId, state }));
  }

  connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(`ws://127.0.0.1:${this.port}/host`);
    socket.on("open", () => {
      this.attempts = 0;
      this.socket = socket;
      this.send({
        type: "hello",
        version: this.services.version,
        appPath: this.services.appPath,
        states: this.services.bridge.states(),
      });
      this.onUp();
    });
    socket.on("message", (raw) => void this.handle(raw));
    const gone = () => {
      if (this.socket === socket) this.socket = null;
      if (this.closed) return;
      this.attempts += 1;
      // a few quick retries cover a server mid-restart; past that it is
      // gone and the launcher has to bring one back
      const wait = this.attempts < 6 ? 500 : 2_000;
      setTimeout(() => {
        if (this.closed) return;
        if (this.attempts >= 6) {
          this.attempts = 0;
          void this.onDown().finally(() => this.connect());
        } else this.connect();
      }, wait);
    };
    socket.on("close", gone);
    socket.on("error", () => socket.close());
  }

  close(): void {
    this.closed = true;
    this.socket?.close();
    this.socket = null;
  }

  private send(msg: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  private async handle(raw: WebSocket.RawData): Promise<void> {
    let msg: { type: string; id: number; method: string; args: unknown[] };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (msg.type !== "call") return;
    try {
      const result = await this.dispatch(msg.method, msg.args ?? []);
      this.send({ type: "reply", id: msg.id, ok: true, result });
    } catch (err) {
      this.send({ type: "reply", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async dispatch(method: string, args: unknown[]): Promise<unknown> {
    const { bridge } = this.services;
    switch (method) {
      case "pickFolder":
        return this.services.pickFolder();
      case "capture":
        return this.services.capture(args[0] as string, args[1] as ShotTarget[]);
      case "bridge.run": {
        const result = await bridge.run(args[0] as Parameters<BridgeHost["run"]>[0], args[1] as Parameters<BridgeHost["run"]>[1]);
        return {
          text: result.text,
          ...(result.image ? { image: { png: result.image.png.toString("base64"), path: result.image.path } } : {}),
        };
      }
      case "bridge.close":
        return bridge.close(args[0] as string);
      case "bridge.takeover":
        return bridge.takeover(args[0] as string);
      case "bridge.release":
        return bridge.release(args[0] as string);
      case "bridge.states":
        return bridge.states();
      case "bridge.closeAll":
        return bridge.closeAll();
      default:
        throw new Error(`the shell has no "${method}"`);
    }
  }
}
