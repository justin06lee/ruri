/**
 * Skipping a question is the end of it.
 *
 * AskUserQuestion is asked through its own card, raised by a PreToolUse
 * hook. The tool call itself then went on to the ordinary permission path
 * too — bypass included, since the hook hands the call back with a changed
 * input — so answering or skipping the card was followed by an allow/deny
 * card over the raw questions JSON, which is not a decision anyone can
 * make, and the turn sat there waiting on it. The call now goes straight
 * through.
 *
 * Asks the model to ask, skips the card, and asserts nothing else is ever
 * put up for the same tool.
 *
 * Costs one small real turn — run manually: bun run question-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, PermissionRequest, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7881);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-question-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-question-project-"));

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
  console.error("QUESTION FAIL: timed out");
  cleanup(1);
}, 240_000);
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
        console.error("QUESTION FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
let status = "idle";
/** Every card the server put up, in order. */
const cards: PermissionRequest[] = [];
const waiters = new Set<() => void>();

const ws = await connect(`ws://127.0.0.1:${PORT}`);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "status" && msg.projectId === projectId) status = msg.status;
  if (msg.type === "permission_request") cards.push(msg.request);
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

send({ type: "add_project", name: "question", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("QUESTION FAIL: no project");
  cleanup(1);
}

send({
  type: "send",
  projectId,
  text:
    "Use the AskUserQuestion tool, right now, to ask me exactly one question: " +
    '"Which colour?" with the two options "Red" and "Blue". ' +
    "Do not do anything else first.",
});

await until("the question card", () => cards.some((c) => c.kind === "question"), 180_000);
const card = cards.find((c) => c.kind === "question");
check("the model's question comes up as a question card", Boolean(card), cards.map((c) => c.toolName));
if (!card) {
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  cleanup(1);
}

// Skip: let the model carry on without an answer.
const seen = cards.length;
send({ type: "question_response", requestId: card.requestId });
await until("the turn to finish", () => status !== "working" && status !== "permission", 180_000);
await settle(3000);

const after = cards.slice(seen);
check(
  "skipping raises nothing else — no allow/deny over the raw question",
  after.every((c) => c.toolName !== "AskUserQuestion"),
  after.map((c) => ({ toolName: c.toolName, kind: c.kind })),
);
check("and the turn ends on its own", status !== "working" && status !== "permission", { status });

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
