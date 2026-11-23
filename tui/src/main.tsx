/**
 * `ruri tui` — ruri in a terminal. A window onto the ruri already running
 * on this computer: it opens the same socket the desktop window does, with
 * the same token, and shows the same projects, chats and queue. Closing it
 * stops nothing; nothing here runs a turn.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { render } from "ink";
import WebSocket from "ws";
import { App } from "./App";
import type { Wire } from "./client";
import { Ruri } from "./store";

const USAGE = `ruri tui — ruri in a terminal

  ruri tui [--port <n>] [--host <name>] [--token <token>] [--plain-keys]

It connects to the ruri running on this computer (port 7776, or $RURI_PORT)
with the token ruri keeps in its config folder, and shows what the desktop
window shows: your projects in your order, each one's chat as it happens,
its queue and the cards it waits on you with.

  --port <n>      the port ruri listens on (7776; 7777 for \`bun run dev\`)
  --host <name>   where it runs (127.0.0.1)
  --token <t>     its token, when it is not in ~/.config/ruri/token
  --plain-keys    don't ask the terminal for the kitty keyboard protocol
                  (for a terminal whose keys act strangely with it)

Press ? inside for the keys.`;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

function token(): string {
  const given = option("token");
  if (given) return given;
  const dir = process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri");
  try {
    return fs.readFileSync(path.join(dir, "token"), "utf8").trim();
  } catch {
    console.error(`ruri tui: no token in ${dir} — has ruri run on this computer? (--token gives one)`);
    process.exit(2);
  }
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("ruri tui: this needs a terminal to draw in");
  process.exit(2);
}

const host = option("host") ?? "127.0.0.1";
const port = Number(option("port") ?? process.env["RURI_PORT"] ?? 7776);
const key = token();
const store = new Ruri({
  // no Origin, and the token in a header: the door the server keeps for
  // what is not a page (server/auth.ts)
  dial: () => new WebSocket(`ws://${host}:${port}/`, { headers: { "x-ruri-token": key } }) as unknown as Wire,
});
store.start();

const app = render(<App store={store} />, {
  alternateScreen: true,
  exitOnCtrlC: false,
  incrementalRendering: true,
  // where the terminal speaks it (kitty, Ghostty, WezTerm), shift+enter is
  // told apart from enter; a terminal that doesn't answer is left as it is
  kittyKeyboard: { mode: process.argv.includes("--plain-keys") ? "disabled" : "auto" },
});
await app.waitUntilExit();
store.stop();
process.exit(0);
