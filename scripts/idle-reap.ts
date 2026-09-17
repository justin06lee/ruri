/**
 * When a chat's agent process closes (server/sessions.ts), and who hears a
 * chat's work as it happens (server/server.ts, the `view` message).
 *
 * Boots the server, opens a chat in one window and plants a word on Haiku,
 * then checks: the open chat keeps its process past the grace; leaving it
 * closes the process straight away, saying nothing in the transcript; a
 * second window without the chat open heard the turn end and nothing of the
 * reply; and the next prompt resumes the same conversation. Costs two short
 * turns' tokens — run manually:
 *   bun run idle-reap-test
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7895;
const GRACE_MS = 2000;
const WORD = "marmalade";
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-reap-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-reap-project-"));

const root = path.join(import.meta.dirname, "..");
const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: root,
  env: {
    ...process.env,
    RURI_PORT: String(PORT),
    RURI_TOKEN: TOKEN,
    RURI_CONFIG_DIR: configDir,
    RURI_NO_MEMORY: "1",
    RURI_REAP_GRACE_MS: String(GRACE_MS),
    // the open-chat cap, well past anything this waits for
    RURI_IDLE_REAP_MS: "120000",
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
        const sock = new WebSocket(wsUrl(PORT));
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a second window, open on nothing: it should hear the chat's turns end
// and none of the work in between. Connected first — nothing may be
// awaited between the main window connecting and it listening, or its
// snapshot goes by unheard.
const bystander = await connect();
bystander.send(JSON.stringify({ type: "view", channels: [], live: true } satisfies ClientMessage));
const overheard: string[] = [];

const ws = await connect();
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
/** The chat on screen here, or none. */
const view = (channels: string[]) => send({ type: "view", channels, live: true });

let sessionId: string | undefined;
let phase: "plant" | "ask" = "plant";
let reply = "";
const events: TranscriptEvent[] = [];

bystander.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (!sessionId) return;
  if (msg.type === "event" && msg.projectId === sessionId) overheard.push(`event:${msg.event.kind}`);
  else if ((msg.type === "delta" || msg.type === "turn" || msg.type === "agent_event") && msg.projectId === sessionId) {
    overheard.push(msg.type);
  }
});

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "snapshot") {
    send({ type: "add_project", name: "reap", path: projectDir });
  } else if (msg.type === "projects" && !sessionId) {
    const project = msg.projects[msg.projects.length - 1];
    if (!project) return;
    sessionId = project.sessions[0]!.id;
    send({ type: "set_model", projectId: project.id, model: "haiku" });
    view([sessionId]);
    console.log(`[t] planting the word in ${sessionId}, with the chat open`);
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
  await sleep(GRACE_MS + 4000);
  check("an open chat keeps its process past the grace", claudes() >= 1);
  check("the window without the chat open heard the turn end", overheard.includes("event:result"));
  check(
    "and nothing of the work in between",
    overheard.every((kind) => kind === "event:result"),
  );
  if (!overheard.every((kind) => kind === "event:result")) console.log(`[t] overheard: ${overheard.join(", ")}`);
  console.log("[t] leaving the chat");
  view([]);
  check("leaving it closes the idle process at once", await until(() => claudes() === 0, GRACE_MS + 8000));
  check(
    "the close says nothing in the transcript",
    !events.some((e) => e.kind === "info" && /session error/i.test(e.text)),
  );
  phase = "ask";
  console.log("[t] opening the chat again and asking for the word back");
  view([sessionId!]);
  send({ type: "send", projectId: sessionId!, text: "What was the word I asked you to remember? Reply with just the word." });
}

async function afterAsk(): Promise<void> {
  check("the next prompt resumes the same conversation", reply.toLowerCase().includes(WORD));
  check("and runs on a process again", claudes() >= 1);
  done();
}
