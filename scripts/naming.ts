/**
 * In bypass, components name themselves.
 *
 * The naming card is a confirmation: the model has already chosen a name
 * and photographed the thing. Bypass is the mode where ruri stops asking
 * for confirmations, so there the entry is written the moment it is
 * proposed — and the name is still yours to change on the library page.
 * In every other mode the card still comes up, and the entry is written
 * when it is answered.
 *
 * Drives the path every harness has — the `ruri register` command, whose
 * shell script posts to POST /library/<chat> (server/library.ts) — so it
 * needs no model at all, and costs nothing: bun run naming-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, NamedComponent, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7883);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-naming-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-naming-project-"));

const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: { ...process.env, RURI_PORT: String(PORT), RURI_TOKEN: TOKEN, RURI_CONFIG_DIR: configDir },
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
let named: NamedComponent[] = [];
let cards = 0;
let cardId: string | undefined;
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    const project = msg.projects[msg.projects.length - 1]!;
    boardId = project.id;
    projectId = project.sessions[0]!.id;
  }
  if (msg.type === "components") named = msg.items;
  if (msg.type === "permission_request" && msg.request.kind === "component") {
    cards += 1;
    cardId = msg.request.requestId;
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

/** What an agent's `ruri register` sends, and what it hears back. */
async function register(slug: string, name: string): Promise<{ status: number; text: string }> {
  const form = new URLSearchParams({ cwd: projectDir });
  for (const arg of ["register", slug, "--files", "src/thing.tsx", "--note", "a thing", "--name", name]) {
    form.append("a", arg);
  }
  const res = await fetch(`http://127.0.0.1:${PORT}/library/${projectId}`, { method: "POST", body: form });
  return { status: res.status, text: await res.text() };
}

fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
fs.writeFileSync(path.join(projectDir, "src", "thing.tsx"), "export function Thing() {}\n");
send({ type: "add_project", name: "naming", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("NAMING FAIL: no project");
  cleanup(1);
}

// bypass is the default mode, and the one that should not ask
const first = await register("amber-rail", "the amber rail");
await until("the entry", () => named.some((c) => c.name === "the amber rail"), 5_000);
check(
  "bypass names it without a card",
  named.some((c) => c.name === "the amber rail"),
  first,
);
check(
  "under the handle it asked for",
  named.some((c) => c.slug === "amber-rail"),
  named.map((c) => c.slug),
);
check("and puts nothing up to confirm", cards === 0, { cards });
check("and says so", first.status === 200 && first.text.startsWith("registered amber-rail"), first);

// every other mode still asks
send({ type: "set_permission_mode", projectId: boardId!, mode: "default" });
await settle(500);
const second = await register("copper-dial", "the copper dial");
await until("the card", () => cards === 1, 5_000);
check("outside bypass the card still comes up", cards === 1, { cards });
check(
  "and the command does not wait on it",
  second.status === 200 && second.text.startsWith("asked the user"),
  second,
);
check(
  "and nothing is written until it is answered",
  !named.some((c) => c.name === "the copper dial"),
  named.map((c) => c.name),
);
send({ type: "component_named", requestId: cardId!, name: "the copper knob" });
await until("the answer", () => named.some((c) => c.name === "the copper knob"), 5_000);
check(
  "answered, it is written under the name the user gave it",
  named.some((c) => c.name === "the copper knob" && c.slug === "copper-dial"),
  named.map((c) => [c.name, c.slug]),
);

// and backend code is turned away
const backend = await (async () => {
  const form = new URLSearchParams({ cwd: projectDir });
  for (const arg of ["register", "db", "--files", "server/db.ts"]) form.append("a", arg);
  const res = await fetch(`http://127.0.0.1:${PORT}/library/${projectId}`, { method: "POST", body: form });
  return { status: res.status, text: await res.text() };
})();
check(
  "backend files are not interface",
  backend.status === 400 && backend.text.includes("interface"),
  backend,
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
