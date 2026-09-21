/** Standalone entry: `bun run dev:server` / smoke tests. The desktop app imports startServer directly. */
import { randomBytes } from "node:crypto";
import { warn } from "./log.js";
import { startServer } from "./server.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7777);
// the secret the window must present (server.ts): a script sets it so it
// can connect; an unattended run gets a fresh one, readable from
// <configDir>/token
const TOKEN = process.env["RURI_TOKEN"] || randomBytes(32).toString("hex");

// A rejection nobody caught is a bug worth a line, not a silent gap in the
// log; an exception nobody caught has left the process in a state nothing
// can vouch for, so it is said and the process goes.
process.on("unhandledRejection", (err) => warn("process", err, "unhandled rejection"));
process.on("uncaughtException", (err) => {
  warn("process", err, "uncaught exception");
  process.exit(1);
});

const running = await startServer({
  port: PORT,
  token: TOKEN,
  // RURI_NO_HARNESS_UPDATES=1: a script's server looks at no one's CLIs
  updateHarnesses: process.env["RURI_NO_HARNESS_UPDATES"] !== "1",
});

process.on("SIGINT", () => {
  void running.close().finally(() => process.exit(0));
});
