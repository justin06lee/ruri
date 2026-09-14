/**
 * A real Claude subagent, end to end: asks the model (on Haiku, to keep it
 * cheap) to start one agent that lists a directory, then checks that the
 * chat got the agent's card, that the card ended done with its report, and
 * that the agent's own log — its brief and what it ran — is there to open.
 *
 * What subagent messages look like (forwardSubagentText, task_* messages,
 * parent_tool_use_id) is the CLI's business, not ruri's; this is the check
 * that ruri still reads them right.
 *
 * Costs one small real turn — run manually: bun run subagents-live-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage, SubagentState, TranscriptEvent } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7883);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-agents-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-agents-project-"));
for (const name of ["one.txt", "two.txt", "three.txt"]) fs.writeFileSync(path.join(projectDir, name), `${name}\n`);

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
    if (detail !== undefined) console.log("    ", JSON.stringify(detail));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("SUBAGENTS LIVE FAIL: timed out");
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
        console.error("SUBAGENTS LIVE FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
let status = "idle";
let worked = false;
/** The chat's agent cards as they stand, by event id. */
const cards = new Map<string, SubagentState>();
/** What the server sent for each agent's log, live. */
const live = new Map<string, TranscriptEvent[]>();
let fetched: TranscriptEvent[] | undefined;
const waiters = new Set<() => void>();

const ws = await connect(`ws://127.0.0.1:${PORT}`);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "status" && msg.projectId === projectId) {
    status = msg.status;
    if (status === "working") worked = true;
  }
  if (msg.type === "event" && msg.event.kind === "tool" && msg.event.agent) cards.set(msg.event.id, msg.event.agent);
  if (msg.type === "agent_event") live.set(msg.key, [...(live.get(msg.key) ?? []), msg.event]);
  if (msg.type === "agent_log") fetched = msg.events;
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

send({ type: "add_project", name: "agents", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("SUBAGENTS LIVE FAIL: no project");
  cleanup(1);
}
send({ type: "set_model", projectId, model: "haiku" });
send({
  type: "send",
  projectId,
  text:
    'Use the Agent tool exactly once, right now, with subagent_type "general-purpose" and description ' +
    '"Count the files". Its prompt: run `ls` in the current directory and report how many entries there are. ' +
    "Then tell me the number it reported. Do nothing else.",
});

await until("the turn to finish", () => worked && status === "idle", 240_000);
await new Promise((r) => setTimeout(r, 2000));

const card = [...cards.values()][0];
console.log(`card: ${JSON.stringify(card)}`);
check("the model's agent came up as a card in the chat", Boolean(card), [...cards.values()]);
if (!card) cleanup(1);
check("its type and description are the call's", card.type === "general-purpose" && card.description === "Count the files", card);
check("it ended done", card.status === "done", card.status);
check("with a report", Boolean(card.result?.trim()), card.result);
const streamed = live.get(card.key) ?? [];
console.log(`log kinds, live: ${streamed.map((e) => (e.kind === "tool" ? `tool:${e.name}` : e.kind)).join(", ")}`);
check("its log opened on the brief", streamed[0]?.kind === "user" && streamed[0].text.includes("ls"), streamed[0]);
check("and holds what it ran", streamed.some((e) => e.kind === "tool" && e.name === "Bash"), streamed);

send({ type: "agent_log", projectId, key: card.key });
await until("the agent's log", () => fetched !== undefined, 10_000);
check("the log opens again from the server, whole", (fetched?.length ?? 0) >= streamed.length && streamed.length >= 2, {
  fetched: fetched?.length,
  streamed: streamed.length,
});

console.log(failed === 0 ? "\nSUBAGENTS LIVE PASS" : `\nSUBAGENTS LIVE FAIL (${failed})`);
cleanup(failed === 0 ? 0 : 1);
