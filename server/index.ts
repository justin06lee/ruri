/** Standalone entry: `bun run dev:server` / smoke tests. The desktop app imports startServer directly. */
import { warn } from "./log.js";
import { startServer } from "./server.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7777);

// A rejection nobody caught is a bug worth a line, not a silent gap in the
// log; an exception nobody caught has left the process in a state nothing
// can vouch for, so it is said and the process goes.
process.on("unhandledRejection", (err) => warn("process", err, "unhandled rejection"));
process.on("uncaughtException", (err) => {
  warn("process", err, "uncaught exception");
  process.exit(1);
});

const running = await startServer({ port: PORT });

process.on("SIGINT", () => {
  void running.close().finally(() => process.exit(0));
});
