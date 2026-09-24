/**
 * Opus 5.5 is Opus 5.5, with the window it really has.
 *
 * The Claude CLI stopped listing its "[1m]" models once the plain ones had
 * the million-token window too — `opus` reports 1,000,000, as `opus[1m]`
 * does. A default left on `opus[1m]` then had no row but one named from its
 * id ("Opus 1M"), and a chat on plain `opus` was measured against 200,000,
 * because the gauge guessed the window from a "[1m]" in the id. Against the
 * real server and CLI:
 *
 * - a catalog without the "[1m]" ids moves the stars and tags on them to
 *   the plain ones it lists;
 * - a chat on plain `opus` is measured against the window the CLI reports
 *   for its turn.
 *
 * One tiny turn on Opus — run manually: bun run model-window-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type { ClientMessage, ContextUsage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7887);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-window-config-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-window-project-"));
const CHAT = "c-window";
const claudeProjects = path.join(
  process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude"),
  "projects",
);

fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      {
        id: "p-window",
        name: "window",
        path: workDir,
        permissionMode: "bypassPermissions",
        // on plain opus outright, so the gauge is measured whatever the default does
        sessions: [{ id: CHAT, title: "Window", model: "opus" }],
      },
    ],
    defaultModel: "opus[1m]",
    starredModels: ["opus[1m]", "opus", "haiku"],
  }),
);

const server = bootServer({
  port: PORT,
  configDir,
  env: { RURI_NO_MEMORY: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 600));
  }
}
async function cleanup(code: number): Promise<never> {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGINT");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  await new Promise((r) => setTimeout(r, 1_000));
  const tail = path.basename(workDir);
  for (const dir of fs.existsSync(claudeProjects) ? fs.readdirSync(claudeProjects) : []) {
    if (dir.endsWith(tail)) fs.rmSync(path.join(claudeProjects, dir), { recursive: true, force: true });
  }
  for (const dir of [configDir, workDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("MODEL-WINDOW FAIL: timed out");
  void cleanup(1);
}, 240_000).unref();

async function connect(url: string): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(url);
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - start > 60_000) {
        console.error("MODEL-WINDOW FAIL: could not connect");
        await cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let defaultModel: string | undefined;
let starred: string[] = [];
const contexts: ContextUsage[] = [];
const events: TranscriptEvent[] = [];
const waiters = new Set<() => void>();
const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "default_model") defaultModel = msg.model;
  if (msg.type === "starred_models") starred = msg.models;
  if (msg.type === "context" && msg.projectId === CHAT) contexts.push(msg.context);
  if (msg.type === "event" && msg.projectId === CHAT) events.push(msg.event);
  for (const waiter of [...waiters]) waiter();
});
function until(what: string, ok: () => boolean, ms: number): Promise<boolean> {
  if (ok()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const look = () => {
      if (!ok()) return;
      clearTimeout(timer);
      waiters.delete(look);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve(false);
    }, ms);
    waiters.add(look);
  });
}

send({ type: "view", channels: [CHAT], live: true });

/* ── the catalog lands without the [1m] ids ────────────────────────── */

await until("the roles to move", () => defaultModel === "opus", 60_000);
check(
  "the default moved off opus[1m] to the plain opus the CLI lists",
  defaultModel === "opus",
  defaultModel,
);
check(
  "its star went with it, and opus is starred once",
  !starred.includes("opus[1m]") && starred.filter((id) => id === "opus").length === 1,
  starred,
);

/* ── a turn on it is measured against the window it has ────────────── */

send({ type: "send", projectId: CHAT, text: "Reply with the single word: ok. Use no tools." });
const answered = await until("the answer", () => events.some((e) => e.kind === "result"), 120_000);
const result = events.find((e): e is Extract<TranscriptEvent, { kind: "result" }> => e.kind === "result");
check("the turn ends well", answered && result?.ok === true, result);
const last = contexts.at(-1);
check(
  "the gauge measures it against the CLI's 1,000,000, not a 200,000 guess",
  last?.window === 1_000_000,
  contexts,
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
await cleanup(failed === 0 ? 0 : 1);
