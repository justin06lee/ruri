/**
 * The queue can be rearranged while it waits.
 *
 * Prompts sent during a turn line up behind it; this checks that the line
 * can be reordered (queue_move), that two can be folded into one
 * (queue_merge — the carried one's text first), and that a prompt taken
 * out for a rewrite (queue_edit) lets the ones behind it go first, then
 * steps back in where it was when the rewrite comes back (queue_update).
 *
 * Against the real server and a real harness, so it costs a handful of very
 * small real turns — run manually: bun run queue-arrange-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, QueuedPrompt, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7881);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-arrange-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-arrange-project-"));

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
  console.error("ARRANGE FAIL: timed out");
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
        console.error("ARRANGE FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
let queued: QueuedPrompt[] = [];
let status = "idle";
const dispatched: string[] = [];
let results = 0;
const waiters = new Set<() => void>();

const ws = await connect(`ws://127.0.0.1:${PORT}`);
ws.on("error", (err) => {
  console.error(`ARRANGE FAIL: websocket error: ${err.message}`);
  cleanup(1);
});
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "queued" && msg.projectId === projectId) queued = msg.items;
  if (msg.type === "status" && msg.projectId === projectId) status = msg.status;
  if (msg.type === "event" && msg.projectId === projectId) {
    if (msg.event.kind === "user") dispatched.push(msg.event.text);
    if (msg.event.kind === "result") results += 1;
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
const say = (word: string) => `Reply with exactly this one word and nothing else: ${word}`;
const idle = () => status !== "working" && status !== "permission";
const texts = () => queued.map((item) => item.text);
const word = (text: string) => text.split(": ").pop();
const byWord = (w: string) => queued.find((item) => item.text.endsWith(`: ${w}`) || item.text.startsWith(say(w)));

/* ── the run ──────────────────────────────────────────────────────── */

send({ type: "add_project", name: "arrange", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("ARRANGE FAIL: no project");
  cleanup(1);
}
const id = projectId;

// pass 1: move and merge, with the line standing by after a stop so
// nothing goes out while it is rearranged
send({ type: "send", projectId: id, text: say("one") });
await until("the first turn", () => status === "working", 90_000);
send({ type: "send", projectId: id, text: say("two") });
send({ type: "send", projectId: id, text: say("three") });
send({ type: "send", projectId: id, text: say("four") });
await until("three queued", () => queued.length === 3, 20_000);
send({ type: "interrupt", projectId: id });
await until("the stop", idle, 90_000);
await settle(2000);
check("three prompts stand by", queued.length === 3, texts());

// four to the front
send({ type: "queue_move", projectId: id, itemId: byWord("four")!.id, beforeId: byWord("two")!.id });
await until("the move", () => word(queued[0]!.text) === "four", 5_000);
check("moved before the first: four, two, three", texts().map(word).join(",") === "four,two,three", texts());
// two to the end
send({ type: "queue_move", projectId: id, itemId: byWord("two")!.id });
await until("the move", () => word(queued[2]!.text) === "two", 5_000);
check("moved to the end: four, three, two", texts().map(word).join(",") === "four,three,two", texts());
// three folded into two: three's text first, standing where two stood
send({ type: "queue_merge", projectId: id, itemId: byWord("three")!.id, intoId: byWord("two")!.id });
await until("the merge", () => queued.length === 2, 5_000);
const merged = queued[1]?.text ?? "";
check("merged into one, carried text first", queued.length === 2 && merged === `${say("three")}\n\n${say("two")}`, texts());

send({ type: "queue_send", projectId: id });
await until("both turns", () => results >= 3 && queued.length === 0 && idle(), 180_000);
await settle(1500);
const first = dispatched.slice(1);
check("went out in the arranged order", first.length === 2 && word(first[0]!) === "four" && first[1] === merged, first);

// pass 2: edit the first of three — the two behind it go, then it comes back
const mark = dispatched.length;
send({ type: "send", projectId: id, text: say("five") });
await until("the next turn", () => status === "working", 90_000);
send({ type: "send", projectId: id, text: say("six") });
send({ type: "send", projectId: id, text: say("seven") });
send({ type: "send", projectId: id, text: say("eight") });
await until("three queued", () => queued.length === 3, 20_000);
send({ type: "queue_edit", projectId: id, itemId: byWord("six")!.id });
await until("the edit", () => queued[2]?.editing === true, 5_000);
check("editing takes it under the line", queued.length === 3 && word(queued[2]!.text) === "six" && queued[2]!.editing === true, queued);
// the running turn ends: seven goes, not six
await until("seven to go out", () => dispatched.length > mark + 1, 120_000);
check("the one behind it goes first", word(dispatched[mark + 1]!) === "seven", dispatched.slice(mark));
// the rewrite comes back while seven runs: it lands at the front, ahead of eight
send({ type: "queue_update", projectId: id, itemId: byWord("six")!.id, text: say("sixty") });
await until("the update", () => queued.some((item) => word(item.text) === "sixty"), 5_000);
check("the rewrite is back in line, at the front", texts().map(word).join(",") === "sixty,eight" && !queued.some((item) => item.editing), texts());
await until("everything", () => results >= 7 && queued.length === 0 && idle(), 240_000);
await settle(1500);
const order = dispatched.slice(mark).map(word);
check("and it all went out in that order", order.join(",") === "five,seven,sixty,eight", order);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
