/**
 * The server on its own.
 *
 * The desktop shell spawns this detached — its own process group, its
 * output to a log — and then connects to it like any other client, plus
 * the /host socket for the things only a window can do. Quitting the app
 * leaves this running with every session, terminal and warm process in
 * it; the next app to open finds it on the port and carries on. A newer
 * app asks it to step aside once everything is idle (see server.ts), and
 * spawns this file again from the new bundle.
 */
import { startServer } from "../server/server.js";

const port = Number(process.env["RURI_PORT"] ?? 7776);
const staticDir = process.env["RURI_STATIC"];
const version = process.env["RURI_VERSION"];

const running = await startServer({
  port,
  ...(staticDir ? { staticDir } : {}),
  ...(version ? { version } : {}),
});

// a graceful close, with a floor under it: a socket that will not drain
// must not keep a server that was told to go alive
const stop = () => {
  setTimeout(() => process.exit(0), 5_000).unref();
  void running.close().finally(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("uncaughtException", (err) => {
  console.error("uncaught", err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandled", err);
});
