/**
 * Stopping a turn keeps the queue.
 *
 * Everything queued behind a running turn used to be thrown away the moment
 * you pressed stop — the one thing nobody asks for. Now it stands by:
 * nothing goes out until the next prompt pulls it along (that prompt goes
 * first — it is usually the reason you stopped) or it is sent on by hand.
 *
 * Two passes, both against the real server and a real harness:
 *   1. queue two, stop, nothing moves — then "send now" and both run, in order.
 *   2. queue two, stop, send a third — the third runs first, then the two.
 *
 * Costs a handful of very small real turns — run manually: bun run queue-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7879);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-queue-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-queue-project-"));

const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: { ...process.env, RURI_PORT: String(PORT), RURI_CONFIG_DIR: configDir },
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
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("QUEUE FAIL: timed out");
  cleanup(1);
}, 420_000);
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
        console.error("QUEUE FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/* ── the server's state, as this client sees it ───────────────────── */

let projectId: string | undefined;
/** The visible queue, and whether it is standing by after a stop. */
let queued: string[] = [];
let held = false;
let status = "idle";
/** Prompts the harness actually saw, in the order they went out. */
const dispatched: string[] = [];
/** Turns finished — one result event each, a stopped turn included. Waiting
 *  on an empty queue is not enough: it empties when the last prompt is
 *  taken off it, which is before that prompt has run. */
let results = 0;
const waiters = new Set<() => void>();

const ws = await connect(`ws://127.0.0.1:${PORT}`);
ws.on("error", (err) => {
  console.error(`QUEUE FAIL: websocket error: ${err.message}`);
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
    held = msg.held === true;
  }
  if (msg.type === "status" && msg.projectId === projectId) status = msg.status;
  if (msg.type === "event" && msg.projectId === projectId) {
    if (msg.event.kind === "user") dispatched.push(msg.event.text);
    if (msg.event.kind === "result") results += 1;
  }
  for (const waiter of [...waiters]) waiter();
});

/** Wait until the state is what we are waiting for (or give up saying so). */
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
const say = (word: string) => `Reply with exactly this one word and nothing else: ${word}`;
const idle = () => status !== "working" && status !== "permission";

/* ── the run ──────────────────────────────────────────────────────── */

send({ type: "add_project", name: "queue", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("QUEUE FAIL: no project");
  cleanup(1);
}
const id = projectId;

// pass 1: stop, and the queue stands by until it is sent on
send({ type: "send", projectId: id, text: say("one") });
await until("the first turn", () => status === "working", 90_000);
send({ type: "send", projectId: id, text: say("two") });
send({ type: "send", projectId: id, text: say("three") });
await until("both prompts queued", () => queued.length === 2, 20_000);
check("prompts sent during a turn queue up", queued.length === 2, queued);

send({ type: "interrupt", projectId: id });
await until("the stop", idle, 90_000);
await settle(3000);
check("the stop keeps the queue", queued.length === 2, queued);
check("and stands it by", held, { held });
check("nothing goes out on its own", idle(), { status });

const before = dispatched.length;
send({ type: "queue_send", projectId: id });
await until("both queued turns to finish", () => results >= 3 && queued.length === 0 && idle(), 180_000);
await settle(2000);
const sentNow = dispatched.slice(before);
check(
  "send now runs both, in the order they were written",
  sentNow.length === 2 && sentNow[0]!.includes("two") && sentNow[1]!.includes("three"),
  sentNow,
);

// pass 2: stop, then a new prompt — it goes first and pulls the queue along
send({ type: "send", projectId: id, text: say("four") });
await until("the next turn", () => status === "working", 90_000);
send({ type: "send", projectId: id, text: say("five") });
send({ type: "send", projectId: id, text: say("six") });
await until("two more queued", () => queued.length === 2, 20_000);
send({ type: "interrupt", projectId: id });
await until("the stop", idle, 90_000);
await settle(3000);
check("the queue stands by again", queued.length === 2 && held, { queued, held });

const mark = dispatched.length;
send({ type: "send", projectId: id, text: say("seven") });
await until("every remaining turn", () => results >= 7 && queued.length === 0 && idle(), 240_000);
await settle(2000);
const order = dispatched.slice(mark);
check(
  "the new prompt goes first, then the queue behind it",
  order.length === 3 &&
    order[0]!.includes("seven") &&
    order[1]!.includes("five") &&
    order[2]!.includes("six"),
  order,
);
check("and nothing is left standing by", queued.length === 0 && !held, { queued, held });

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
