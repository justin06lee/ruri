/** Standalone entry: `bun run dev:server` / smoke tests. The desktop app imports startServer directly. */
import { startServer } from "./server.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7777);

const running = await startServer({ port: PORT });

process.on("SIGINT", () => {
  void running.close().finally(() => process.exit(0));
});
