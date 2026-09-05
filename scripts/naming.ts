/**
 * In bypass, components name themselves.
 *
 * The naming card is a confirmation: the model has already chosen a name
 * and photographed the thing. Bypass is the mode where ruri stops asking
 * for confirmations, so there the entry is written the moment it is
 * proposed — and the name is still yours to change on the components page.
 * In every other mode the card still comes up.
 *
 * Drives the file-based proposal path (`.ruri/components.jsonl`, which is
 * how a harness without ruri's own tools names things), so it needs one
 * trivial real turn per mode to make the server drain it.
 *
 * Costs two small real turns — run manually: bun run naming-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, NamedComponent, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7883);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-naming-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-naming-project-"));

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
  console.error("NAMING FAIL: timed out");
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
        console.error("NAMING FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
/** The project the session belongs to — the permission mode is set on it. */
let boardId: string | undefined;
let status = "idle";
let named: NamedComponent[] = [];
let cards = 0;
const waiters = new Set<() => void>();

const ws = await connect(`ws://127.0.0.1:${PORT}`);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    const project = msg.projects[msg.projects.length - 1]!;
    boardId = project.id;
    projectId = project.sessions[0]!.id;
  }
  if (msg.type === "status" && msg.projectId === projectId) status = msg.status;
  if (msg.type === "components") named = msg.items;
  if (msg.type === "permission_request" && msg.request.kind === "component") cards += 1;
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
const idle = () => status !== "working" && status !== "permission";

/** What a harness writes when it wants something named. */
function propose(name: string): void {
  fs.mkdirSync(path.join(projectDir, ".ruri"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".ruri", "components.jsonl"),
    `${JSON.stringify({ name, files: ["src/thing.tsx"], note: "a thing" })}\n`,
  );
}

/** One trivial turn — the drain runs when a turn finishes. */
async function turn(word: string): Promise<void> {
  send({
    type: "send",
    projectId: projectId!,
    text: `Reply with exactly this one word and nothing else: ${word}`,
  });
  await until("the turn to start", () => status === "working", 90_000);
  await until("the turn to finish", idle, 180_000);
  await settle(2500);
}

send({ type: "add_project", name: "naming", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("NAMING FAIL: no project");
  cleanup(1);
}

// bypass is the default mode, and the one that should not ask
propose("the amber rail");
await turn("one");
check("bypass names it without a card", named.some((c) => c.name === "the amber rail"), named.map((c) => c.name));
check("and puts nothing up to confirm", cards === 0, { cards });

// every other mode still asks
send({ type: "set_permission_mode", projectId: boardId!, mode: "default" });
await settle(500);
propose("the copper dial");
await turn("two");
check("outside bypass the card still comes up", cards === 1, { cards });
check(
  "and nothing is written until it is answered",
  !named.some((c) => c.name === "the copper dial"),
  named.map((c) => c.name),
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
