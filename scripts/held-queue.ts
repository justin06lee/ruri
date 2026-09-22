/**
 * A turn the connection or the usage limit cuts short holds the queue.
 *
 * Prompts queued behind a turn used to go out the moment it ended, however
 * it ended — so a dropped connection or a spent limit sent every one of
 * them straight into the same wall, one after another. Now the queue stands
 * by and says why, and goes only when the user sends it on.
 *
 * One pass against the real server and the real CLI, pointed at a port on
 * this machine. Nothing listens there at first — the connection is refused,
 * as it is when the network is down. Then a mock gateway comes up that
 * answers 429 with the headers of a spent usage limit. No tokens are spent
 * and no request leaves the box.
 *
 *   1. a turn and two queued behind it; the turn's connection is refused:
 *      the queue holds for the network, and nothing else goes out
 *   2. the line comes back: the queue hears it (and still waits), and the
 *      dropped turn goes again by itself — into the limit, so the queue
 *      now holds for that, with the time it lifts
 *   3. "Send queued": the next prompt goes, meets the limit, and the one
 *      behind it holds again — still knowing when the limit lifts
 *
 * Run manually: bun run held-queue-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, QueueHold, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7883);
const GATEWAY_PORT = Number(process.env["RURI_GATEWAY_PORT"] ?? 8793);
/** When the mock's limit lifts: two hours out, in seconds, as the API says it. */
const RESETS = Math.floor(Date.now() / 1000) + 7200;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-held-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-held-project-"));

/** A spent usage limit, as the API says it. Not listening until phase 2. */
let gatewayHits = 0;
const gateway = http.createServer((_req, res) => {
  gatewayHits += 1;
  res.writeHead(429, {
    "content-type": "application/json",
    "retry-after": "3600",
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String(RESETS),
  });
  res.end(
    JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Usage limit reached" } }),
  );
});

const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: {
    ...process.env,
    RURI_PORT: String(PORT),
    RURI_TOKEN: TOKEN,
    RURI_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    CLAUDE_CODE_MAX_RETRIES: "0",
  },
  stdio: ["ignore", "ignore", "inherit"],
});

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  gateway.close();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("HELD FAIL: timed out");
  cleanup(1);
}, 300_000);
deadline.unref();

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
        console.error("HELD FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/* ── the server's state, as this client sees it ───────────────────── */

let projectId: string | undefined;
let queued: string[] = [];
let hold: QueueHold | undefined;
/** Every hold the queue has worn, in order. */
const holds: QueueHold[] = [];
/** The prompts that reached the harness, as the transcript shows them. */
const dispatched: string[] = [];
const results: Array<{ ok: boolean; blocked?: string; resetsAt?: number; error?: string }> = [];
const notes: string[] = [];
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
ws.on("error", (err) => {
  console.error(`HELD FAIL: websocket error: ${err.message}`);
  cleanup(1);
});
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "queued" && msg.projectId === projectId) {
    queued = msg.items.map((item) => item.text);
    hold = msg.held;
    if (msg.held) holds.push(msg.held);
  }
  if (msg.type === "event" && msg.projectId === projectId) {
    if (msg.event.kind === "user") dispatched.push(msg.event.text);
    if (msg.event.kind === "result") {
      results.push({
        ok: msg.event.ok,
        ...(msg.event.blocked ? { blocked: msg.event.blocked } : {}),
        ...(msg.event.resetsAt ? { resetsAt: msg.event.resetsAt } : {}),
        ...(msg.event.error ? { error: msg.event.error } : {}),
      });
    }
    if (msg.event.kind === "info") notes.push(msg.event.text);
  }
  for (const waiter of [...waiters]) waiter();
});

function until(what: string, done: () => boolean, ms: number): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!done()) return;
      clearTimeout(timer);
      waiters.delete(look);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve();
    }, ms);
    waiters.add(look);
  });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── the run ──────────────────────────────────────────────────────── */

send({ type: "add_project", name: "held", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("HELD FAIL: no project");
  cleanup(1);
}
const id = projectId;

// 1. the connection is refused
send({ type: "send", projectId: id, text: "first" });
send({ type: "send", projectId: id, text: "second" });
send({ type: "send", projectId: id, text: "third" });
await until("the refused turn", () => results.length >= 1, 90_000);
await settle(4_000);

check("the refused turn is marked as the network's doing", results[0]?.blocked === "network", results[0]);
check("the queue holds for the network", hold?.by === "network", { hold });
check("with both prompts still in it", queued.join() === "second,third", queued);
check("and nothing else went out", dispatched.join() === "first", dispatched);
check(
  "the dropped turn says it will go again once the line is back",
  notes.some((n) => n.includes("once it is back")),
  notes,
);

// 2. the line comes back — into a spent limit
await new Promise<void>((resolve) => gateway.listen(GATEWAY_PORT, "127.0.0.1", resolve));
await until("the line to be seen back", () => holds.some((h) => h.by === "network" && h.back), 40_000);
check(
  "the queue hears the line is back",
  holds.some((h) => h.by === "network" && h.back),
  holds,
);
await until("the retry to meet the limit", () => results.length >= 2, 60_000);
await settle(2_000);

check("the dropped turn went again by itself", gatewayHits > 0 && results.length === 2, {
  gatewayHits,
  results,
});
check("and met the limit", results[1]?.blocked === "limit", results[1]);
check("which said when it lifts", results[1]?.resetsAt === RESETS * 1000, results[1]);
check("the queue now holds for the limit", hold?.by === "limit", { hold });
check("with the time it lifts", hold?.by === "limit" && hold.resetsAt === RESETS * 1000, { hold });
check(
  "still both prompts, and still nothing else sent",
  queued.join() === "second,third" && dispatched.join() === "first",
  {
    queued,
    dispatched,
  },
);

// 3. sent on by hand
send({ type: "queue_send", projectId: id });
await until("the next prompt's turn", () => results.length >= 3, 60_000);
await settle(3_000);

check("the next one went out", dispatched.join() === "first,second", dispatched);
check("met the limit too", results[2]?.blocked === "limit", results[2]);
check("and the one behind it holds again", queued.join() === "third" && hold?.by === "limit", {
  queued,
  hold,
});
// the CLI says when a limit lifts only as it first hits it; the second
// turn into the same limit is told nothing new, and still knows
check("still knowing when it lifts", hold?.by === "limit" && hold.resetsAt === RESETS * 1000, { hold });

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
