/** Standalone entry: `bun run dev:server` / smoke tests. The desktop app imports startServer directly. */
import { randomBytes } from "node:crypto";
import { warn } from "./log.js";
import type { RuriServer } from "./context.js";
import { startServer } from "./server.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7777);
// the secret the window must present (server.ts): a script sets it so it
// can connect; an unattended run gets a fresh one, readable from
// <configDir>/token
const TOKEN = process.env["RURI_TOKEN"] || randomBytes(32).toString("hex");

/** The server, once it is up — what the handlers below write down and close. */
const up: { running?: RuriServer } = {};

// A rejection nobody caught is a bug worth a line, not a silent gap in the
// log; an exception nobody caught has left the process in a state nothing
// can vouch for, so it is said and the process goes — after the transcripts
// and session ids still on their debounce are written, which the exit
// would otherwise take with it.
process.on("unhandledRejection", (err) => warn("process", err, "unhandled rejection"));
process.on("uncaughtException", (err) => {
  warn("process", err, "uncaught exception");
  try {
    up.running?.flush();
  } catch (flushErr) {
    warn("process", flushErr, "flush on the way out");
  }
  process.exit(1);
});

const running = await startServer({
  port: PORT,
  token: TOKEN,
  // RURI_NO_HARNESS_UPDATES=1: a script's server looks at no one's CLIs
  updateHarnesses: process.env["RURI_NO_HARNESS_UPDATES"] !== "1",
});
up.running = running;

// a stop is a stop whichever signal says it: SIGTERM used to end the
// process without the close that writes everything down
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void running.close().finally(() => process.exit(0));
  });
}
