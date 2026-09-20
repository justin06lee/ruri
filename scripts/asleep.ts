/**
 * A window that has gone to sleep stops costing the machine.
 *
 * Whether anyone is actually looking rides on the `view` message
 * (shared/protocol.ts `awake`), and two things downstream act on it: the
 * resource meters, which stop sampling — each sample is a `ps` over every
 * process on the machine — and the reaper, which drops a warm CLI's
 * 200-odd MB a minute after the last window on it went to sleep instead of
 * holding it for ten (server/sessions.ts).
 *
 * The meters are what this drives, because they are observable without
 * spending a token: same message, same schema, same handler, so a break
 * anywhere on that path shows up here. That the flag survives the schema at
 * all is server/keepwarm.test.ts, which is also where the two readings the
 * reaper takes are checked.
 *
 *   1. a window with the statistics page up, awake, gets readings
 *   2. the window goes to sleep: the readings stop
 *   3. it wakes: they start again
 *
 * Costs nothing — no model is asked anything. Run:
 *   bun run asleep-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bootServer, connect } from "./lib/server.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 400));
  }
}

const PORT = 7817;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-asleep-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-asleep-ws-"));
fs.writeFileSync(path.join(workspace, "README.md"), "# a project\n");

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

function bye(): never {
  server.kill();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

/** Three sampling periods (server/resources.ts samples every two seconds):
 *  long enough that a sampler still running would certainly have shown. */
const QUIET_MS = 6_000;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  const ws = await connect(PORT);
  const seen: ServerMessage[] = [];
  ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as ServerMessage));
  const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
  const readings = () => seen.filter((m) => m.type === "resources").length;
  const until = async (want: () => boolean, ms: number) => {
    const start = Date.now();
    while (!want()) {
      if (Date.now() - start > ms) return false;
      await wait(100);
    }
    return true;
  };

  send({ type: "add_project", name: "Asleep", path: workspace });
  await until(() => seen.some((m) => m.type === "projects" && m.projects.length > 0), 30_000);
  const project = seen.flatMap((m) => (m.type === "projects" ? m.projects : [])).at(-1);
  const channelId = project?.sessions[0]?.id;
  if (!channelId) {
    check("the project has a session", false, seen.slice(-2));
    bye();
  }
  const view = (extra: Partial<ClientMessage & { meters: boolean; awake: boolean }>) =>
    send({ type: "view", channels: [channelId], live: true, ...extra } as ClientMessage);

  /* ── 1. awake, with the page up ───────────────────────────────────── */

  view({ meters: true, awake: true });
  check("a window someone is looking at gets readings", await until(() => readings() > 0, 15_000));

  /* ── 2. the window goes to sleep ──────────────────────────────────── */

  view({ meters: true, awake: false });
  // a sample already in flight as the timer was cleared still lands
  await wait(1_000);
  const asleepAt = readings();
  await wait(QUIET_MS);
  check("asleep, nothing is sampled", readings() === asleepAt, {
    at: asleepAt,
    after: readings(),
  });

  /* ── 3. and wakes again ───────────────────────────────────────────── */

  view({ meters: true, awake: true });
  check("awake again, the readings come back", await until(() => readings() > asleepAt, 15_000));
} catch (err) {
  check("ran without throwing", false, String(err));
}
bye();
