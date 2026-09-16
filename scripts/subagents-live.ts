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
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, SubagentState, TranscriptEvent } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7883);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-agents-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-agents-project-"));
for (const name of ["one.txt", "two.txt", "three.txt"]) fs.writeFileSync(path.join(projectDir, name), `${name}\n`);

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
    if (detail !== undefined) console.log("    ", JSON.stringify(detail));
  }
}

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

const ws = await connect(wsUrl(PORT));
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

// The CLI may leave the agent working in the background after the turn —
// it usually does now. Then the chat's process has to stay for as long as
// the agent runs (it lives there), and go once the agent has reported.
const first = [...cards.values()][0];
if (first?.background && first.status === "running") {
  console.log("[t] the agent went to the background; waiting for it to report");
  check("a background agent keeps the chat's process alive", claudes() >= 1);
  await until("the background agent", () => [...cards.values()][0]?.status !== "running", 180_000);
  await until("the turn it reports into", () => status === "idle", 120_000);
  // nobody has this chat open (no `view`): with the agent done and the
  // turn over, the process closes after the grace
  const closed = await new Promise<boolean>((resolve) => {
    const end = Date.now() + 15_000;
    const look = () => (claudes() === 0 ? resolve(true) : Date.now() > end ? resolve(false) : setTimeout(look, 500));
    look();
  });
  check("and once it has reported, the process closes", closed);
}

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
