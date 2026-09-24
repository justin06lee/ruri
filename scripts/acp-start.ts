/**
 * An ACP harness that dies as it starts is started again.
 *
 * OpenCode keeps everything in one SQLite database, and a second OpenCode
 * opening it in the same moment — ruri's small model titles every prompt
 * on the same harness — can find it locked and exit on the way up. ruri
 * read the closed pipe as "ACP connection closed" and failed the prompt;
 * the next one worked. The same went for a warm process that had died
 * while the chat sat idle. Against the real OpenCode, with its data in a
 * scratch folder:
 *
 * W. A chat's warm process is killed between turns; the next prompt is
 *    answered.
 * L. A chat's first prompt goes out while the database is write-locked;
 *    it is answered once the lock is gone.
 *
 * Needs `opencode`; three turns on OpenCode's free model — run manually:
 * bun run acp-start-test
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7886);
const MODEL = process.env["ACP_START_MODEL"] ?? "opencode:opencode/muse-spark-1.3-contributor-free";
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-acpstart-config-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-acpstart-data-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-acpstart-project-"));
const CHAT_W = "c-acp-warm";
const CHAT_L = "c-acp-locked";
const database = path.join(dataDir, "opencode", "opencode.db");

fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      {
        id: "p-acp",
        name: "acp-start",
        path: workDir,
        permissionMode: "bypassPermissions",
        sessions: [
          { id: CHAT_W, title: "W", model: MODEL },
          { id: CHAT_L, title: "L", model: MODEL },
        ],
      },
    ],
    smallModel: MODEL,
  }),
);

const server = bootServer({
  port: PORT,
  configDir,
  // OpenCode's data (its database) in the scratch folder, never the real one
  env: { RURI_NO_MEMORY: "1", XDG_DATA_HOME: dataDir, RURI_REAP_GRACE_MS: "120000" },
  stdio: ["ignore", "ignore", "pipe"],
});
let serverLog = "";
server.stderr?.on("data", (d: Buffer) => {
  serverLog += d.toString();
  for (const waiter of [...waiters]) waiter();
});
const restarts = () => (serverLog.match(/died starting; again/g) ?? []).length;

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
  for (const dir of [configDir, dataDir, workDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("ACP-START FAIL: timed out");
  void cleanup(1);
}, 300_000).unref();

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
        console.error("ACP-START FAIL: could not connect");
        await cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const seen = new Map<string, TranscriptEvent[]>();
const waiters = new Set<() => void>();
const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "event") seen.set(msg.projectId, [...(seen.get(msg.projectId) ?? []), msg.event]);
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
const results = (chat: string) =>
  (seen.get(chat) ?? []).filter(
    (e): e is Extract<TranscriptEvent, { kind: "result" }> => e.kind === "result",
  );
const said = (chat: string) =>
  (seen.get(chat) ?? [])
    .flatMap((e) =>
      e.kind === "assistant" || e.kind === "info"
        ? [e.text]
        : e.kind === "result" && e.error
          ? [e.error]
          : [],
    )
    .join("\n");
/** Ask, and wait for the turn's result. */
async function ask(
  chat: string,
  text: string,
): Promise<Extract<TranscriptEvent, { kind: "result" }> | undefined> {
  const before = results(chat).length;
  send({ type: "send", projectId: chat, text });
  await until(`${chat}'s answer`, () => results(chat).length > before, 120_000);
  return results(chat)[before];
}
/** The harness processes a chat has up (their environment names the chat). */
function processesOf(chat: string): number[] {
  return execFileSync("ps", ["-axwwE", "-o", "pid=,command="], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line.includes(`RURI_CHANNEL=${chat}`) && /\bopencode\b/.test(line))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

send({ type: "view", channels: [CHAT_W, CHAT_L], live: true });
await new Promise((r) => setTimeout(r, 1500));

/* ── W. the warm process died while the chat sat idle ──────────────── */

const first = await ask(CHAT_W, "Reply with the single word: ok. Use no tools.");
check("W: the first turn ends well", first?.ok === true, first);
const warm = processesOf(CHAT_W);
check("W: its process is still up, warm", warm.length > 0);
for (const pid of warm) process.kill(pid, "SIGKILL");
await new Promise((r) => setTimeout(r, 1000));
const beforeW = restarts();
const second = await ask(CHAT_W, "Reply with the single word: again. Use no tools.");
check("W: the next prompt is answered", second?.ok === true, second);
check(
  "W: the chat never shows the closed connection",
  !/connection closed/i.test(said(CHAT_W)),
  said(CHAT_W),
);
check("W: because the process was started again", restarts() > beforeW, serverLog.slice(-400));

/* ── L. the first start meets a locked database ────────────────────── */

check("L: the chat has no process yet", processesOf(CHAT_L).length === 0);
// another OpenCode mid-write, as far as this one can tell
const lock = spawn("sqlite3", [database], { stdio: ["pipe", "ignore", "inherit"] });
lock.stdin.write("BEGIN EXCLUSIVE;\nCREATE TABLE IF NOT EXISTS __lock_probe(x);\n");
await new Promise((r) => setTimeout(r, 300));
const beforeL = restarts();
// held until the start has died on it, then let go — as the other process
// would be through its own start by then
const released = until("the start to die on the lock", () => restarts() > beforeL, 20_000).then(() =>
  lock.stdin.end("ROLLBACK;\n.quit\n"),
);
const locked = await ask(CHAT_L, "Reply with the single word: ok. Use no tools.");
await released;
check("L: the prompt is answered once the lock is gone", locked?.ok === true, locked);
check(
  "L: the chat never shows the closed connection",
  !/connection closed/i.test(said(CHAT_L)),
  said(CHAT_L),
);
check("L: because the start died and went again", restarts() > beforeL, serverLog.slice(-400));

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
await cleanup(failed === 0 ? 0 : 1);
