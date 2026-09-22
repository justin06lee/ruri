/**
 * A turn the CLI starts on its own is a turn.
 *
 * A background task that ends between turns wakes Claude Code to answer
 * it: a turn nobody sent. ruri used to count only its own prompts, so the
 * woken turn ran with the chat "idle". A chat open nowhere was reaped a
 * moment after the task ended, mid-answer, and the model never heard its
 * task was done. A prompt sent as it woke was signed "done" by the woken
 * turn's result, half a second in, while its real answer went on after.
 *
 *   1. a background task ends with the chat open nowhere: the chat goes
 *      busy by itself, the model answers, and only then is it idle
 *   2. a prompt sent the moment a second task ends, before the CLI's own
 *      turn has begun: the result it gets is its own, after its answer
 *
 * The reap grace is cut to half a second, so a woken turn the chat does
 * not count as busy is reaped before it can answer.
 *
 * Costs a few very small real turns (haiku) — run manually: bun run wake-turn-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7885);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-wake-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-wake-project-"));

const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: {
    ...process.env,
    RURI_PORT: String(PORT),
    RURI_TOKEN: TOKEN,
    RURI_CONFIG_DIR: configDir,
    RURI_REAP_GRACE_MS: "500",
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
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("WAKE FAIL: timed out");
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
        console.error("WAKE FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/* ── the server's state, as this client sees it ───────────────────── */

let projectId: string | undefined;
let status = "idle";
/** The chat's story as it arrived: prompts, words, results, busy/idle. */
const story: string[] = [];
/** Background work, as the chat's badge counts it. */
let scripts = 0;
let onWorkDone: (() => void) | undefined;
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
ws.on("error", (err) => {
  console.error(`WAKE FAIL: websocket error: ${err.message}`);
  cleanup(1);
});
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "status" && msg.projectId === projectId && msg.status !== status) {
    status = msg.status;
    story.push(`status:${status}`);
  }
  if (msg.type === "work" && msg.projectId === projectId) {
    const now = msg.work?.scripts ?? 0;
    if (now === 0 && scripts > 0) onWorkDone?.();
    scripts = now;
  }
  if (msg.type === "event" && msg.projectId === projectId) {
    const e = msg.event;
    if (e.kind === "user") story.push(`user:${e.text.slice(0, 24)}`);
    if (e.kind === "assistant") story.push(`says:${e.text.trim().toLowerCase().slice(0, 30)}`);
    if (e.kind === "result") story.push(`result:${e.ok ? "ok" : "failed"}`);
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
const count = (prefix: string, from = 0) => story.slice(from).filter((s) => s.startsWith(prefix)).length;
const index = (entry: (s: string) => boolean, from = 0) => {
  const at = story.slice(from).findIndex(entry);
  return at === -1 ? -1 : at + from;
};

const task = (n: string) =>
  `Use the Bash tool with run_in_background set to true to run exactly: sleep 5 && echo DONE${n}. ` +
  `Then reply with just the word started${n} and end your turn. ` +
  `When you are told that background task has finished, reply with just the word finished${n}.`;

/* ── the run ──────────────────────────────────────────────────────── */

send({ type: "add_project", name: "wake", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("WAKE FAIL: no project");
  cleanup(1);
}
const id = projectId;
send({ type: "set_model", projectId: id, model: "haiku" });
await settle(500);

// 1. a task ends with nobody looking
send({ type: "send", projectId: id, text: task("1") });
await until("the first turn", () => count("result:") >= 1, 90_000);
const firstEnd = story.length;
await until("the woken turn's answer", () => count("result:", firstEnd) >= 1, 60_000);
await until("the chat to settle", () => status === "idle", 20_000);
const woke = story.slice(firstEnd);
check("the chat went busy by itself when the task ended", woke.includes("status:working"), woke);
check(
  "the model answered the task's end",
  woke.some((s) => s.startsWith("says:") && s.includes("finished1")),
  woke,
);
check(
  "and the woken turn ended with a result of its own, after its answer",
  index((s) => s.includes("finished1"), firstEnd) < index((s) => s.startsWith("result:"), firstEnd),
  woke,
);

// 2. a prompt sent the moment a second task ends, before the CLI wakes
let sentAt = -1;
onWorkDone = () => {
  onWorkDone = undefined;
  sentAt = story.length;
  send({ type: "send", projectId: id, text: "Reply with just the word third." });
};
send({ type: "send", projectId: id, text: task("2") });
await until("the prompt sent as the task ended", () => sentAt >= 0, 90_000);
await until(
  "its answer and its result",
  () => story.slice(sentAt).some((s) => s.includes("third")) && status === "idle",
  60_000,
);
await settle(6_000);
const after = story.slice(sentAt);
const userAt = index((s) => s.startsWith("user:Reply with just the"), sentAt);
const thirdAt = index((s) => s.startsWith("says:") && s.includes("third"), sentAt);
const firstResult = index((s) => s.startsWith("result:"), userAt);
console.log(
  `    (the CLI ${after.some((s) => s.includes("finished2")) && index((s) => s.includes("finished2"), sentAt) < thirdAt ? "woke first — the race" : "took the prompt first"})`,
);
check("the prompt was sent before the chat went busy again", userAt >= 0, after);
check("the prompt was answered", thirdAt > userAt, after);
check("the first result after it comes after its answer, not before", firstResult > thirdAt, after);
check("and the chat is idle at the end", status === "idle", { status });

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
