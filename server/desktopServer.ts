/**
 * The server's entry when the desktop shell runs it: forked by the shell
 * into a process of its own (desktop/serverProcess.ts), told how to start
 * over the port between them, and asking back over it for what only the
 * shell has (server/hostLink.ts). server/index.ts is the entry without a
 * shell — the dev server and the scripts.
 */
import { ShellLink, type ToServer, type ToShell } from "./hostLink.js";
import { warn } from "./log.js";
import type { RuriServer } from "./context.js";
import { startServer } from "./server.js";

/** Electron's end of the port, on a utility process. Typed here so the
 *  server's code never imports Electron. */
interface ParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  console.error("server/desktopServer.ts runs under the desktop shell; on its own, run server/index.ts");
  process.exit(1);
}
const post = (message: ToShell) => parentPort.postMessage(message);

let link: ShellLink | undefined;
let running: RuriServer | undefined;
let closing: Promise<void> | undefined;

// As server/index.ts: a stray rejection is a line in the log; an exception
// nobody caught leaves state nothing can vouch for, so what is on its
// debounce is written and the process goes — and the shell starts another.
process.on("unhandledRejection", (err) => warn("process", err, "unhandled rejection"));
process.on("uncaughtException", (err) => {
  warn("process", err, "uncaught exception");
  try {
    running?.flush();
  } catch (flushErr) {
    warn("process", flushErr, "flush on the way out");
  }
  process.exit(1);
});

/** Close everything down, once, however many ask. */
function close(): Promise<void> {
  closing ??= (running?.close() ?? Promise.resolve()).catch((err: unknown) => warn("server", err, "close"));
  return closing;
}

parentPort.on("message", ({ data }) => {
  const message = data as ToServer;
  if (message.type === "start") {
    if (link) return;
    const start = message.start;
    link = new ShellLink(post, start);
    void startServer({
      port: start.port,
      token: start.token,
      staticDir: start.staticDir,
      reclaimPort: start.reclaimPort,
      appPid: start.appPid,
      ...link.hooks(),
    }).then(
      (server) => {
        running = server;
        post({
          type: "ready",
          port: server.port,
          ...(server.portFallback ? { portFallback: server.portFallback } : {}),
        });
      },
      (err: unknown) => {
        warn("server", err, "start");
        process.exit(1);
      },
    );
    return;
  }
  // the shell waits for this process to go: that is the answer
  if (message.type === "close") {
    void close().finally(() => process.exit(0));
    return;
  }
  link?.receive(message);
});

// a signal straight to this process is a stop like any other
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void close().finally(() => process.exit(0));
  });
}
