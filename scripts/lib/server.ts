/**
 * What every test script needs to reach a ruri it started: the token the
 * server insists on (server/server.ts), the environment a spawned server
 * runs with, and the socket URL that carries the token.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as path from "node:path";
import WebSocket from "ws";

/** One token per script run; the spawned server is told the same one. */
export const TOKEN = process.env["RURI_TOKEN"] ?? randomBytes(16).toString("hex");

/** The environment a spawned server (or app) should run with. */
export function serverEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // a test server updates nobody's CLIs (server/updater.ts)
  return { ...process.env, RURI_TOKEN: TOKEN, RURI_NO_HARNESS_UPDATES: "1", ...extra };
}

/** The socket URL for a server started with serverEnv(). */
export function wsUrl(port: number, token = TOKEN): string {
  return `ws://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

export interface BootOptions {
  port: number;
  configDir: string;
  /** More environment for the server. */
  env?: Record<string, string>;
  /** Where the server's output goes (default: stdout piped, stderr inherited). */
  stdio?: ["ignore", "pipe" | "ignore" | "inherit", "inherit" | "ignore"];
}

/** Start the standalone server (server/index.ts) with the token set. */
export function bootServer(opts: BootOptions): ChildProcess {
  return spawn("bunx", ["tsx", "server/index.ts"], {
    cwd: path.join(import.meta.dirname, "..", ".."),
    env: serverEnv({ RURI_PORT: String(opts.port), RURI_CONFIG_DIR: opts.configDir, ...opts.env }),
    stdio: opts.stdio ?? ["ignore", "pipe", "inherit"],
  });
}

/** Connect to a server started with bootServer(), retrying until it is up. */
export async function connect(port: number, timeoutMs = 30_000): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(wsUrl(port));
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch (err) {
      if (Date.now() - start > timeoutMs)
        throw new Error(`could not connect to ruri on ${port}: ${String(err)}`, { cause: err });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}
