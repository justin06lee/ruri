/**
 * The idle reaper (server/sessions.ts): a chat left idle has its agent
 * process closed, the close says nothing in the transcript, and the next
 * prompt resumes the same conversation. Boots the server with a 5-second
 * idle limit, plants a word on Haiku, waits for the process to go, then
 * asks for the word back. Costs two short turns' tokens — run manually:
 *   bun run idle-reap-test
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7895;
const REAP_MS = 5000;
const WORD = "marmalade";
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-reap-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-reap-project-"));

const root = path.join(import.meta.dirname, "..");
const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    RURI_PORT: String(PORT),
    RURI_CONFIG_DIR: configDir,
    RURI_NO_MEMORY: "1",
    RURI_IDLE_REAP_MS: String(REAP_MS),
  },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
function done(): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  if (failed) console.log(`${failed} failed`);
  else console.log("all good");
  process.exit(failed ? 1 : 0);
}
setTimeout(() => {
  check("finished in time", false);
  done();
}, 240_000).unref();

/** `claude` processes anywhere under the server. */
function claudes(): number {
  const listing = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  const rows = listing
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), comm: m[3]! }));
  const under = new Set([server.pid!]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!under.has(row.pid) && under.has(row.ppid)) {
        under.add(row.pid);
        grew = true;
      }
    }
  }
  return rows.filter((row) => under.has(row.pid) && /(^|\/)claude$/.test(row.comm)).length;
}

async function connect(): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - start > 60_000) {
        check("server came up", false);
        done();
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return test();
}

const ws = await connect();
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
let sessionId: string | undefined;
let phase: "plant" | "ask" = "plant";
let reply = "";
const events: TranscriptEvent[] = [];

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "snapshot") {
    send({ type: "add_project", name: "reap", path: projectDir });
  } else if (msg.type === "projects" && !sessionId) {
    const project = msg.projects[msg.projects.length - 1];
    if (!project) return;
    sessionId = project.sessions[0]!.id;
    send({ type: "set_model", projectId: project.id, model: "haiku" });
    console.log(`[t] planting the word in ${sessionId}`);
    send({ type: "send", projectId: sessionId, text: `Remember this word for later: ${WORD}. Reply with just "ok".` });
  } else if (msg.type === "event" && msg.projectId === sessionId) {
    events.push(msg.event);
    if (msg.event.kind === "assistant" && phase === "ask") reply += msg.event.text;
    if (msg.event.kind !== "result") return;
    if (phase === "plant") void afterPlant();
    else void afterAsk();
  }
});

async function afterPlant(): Promise<void> {
  check("the chat has a live claude process after its turn", claudes() >= 1);
  console.log(`[t] waiting up to ${(REAP_MS + 15_000) / 1000}s for the idle process to be closed`);
  check("the idle process is closed", await until(() => claudes() === 0, REAP_MS + 15_000));
  check(
    "the close says nothing in the transcript",
    !events.some((e) => e.kind === "info" && /session error/i.test(e.text)),
  );
  phase = "ask";
  console.log("[t] asking for the word back");
  send({ type: "send", projectId: sessionId!, text: "What was the word I asked you to remember? Reply with just the word." });
}

async function afterAsk(): Promise<void> {
  check("the next prompt resumes the same conversation", reply.toLowerCase().includes(WORD));
  check("and runs on a process again", claudes() >= 1);
  done();
}
