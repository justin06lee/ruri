/**
 * An agent of the user's own, end to end, on Haiku to keep it cheap: it
 * starts from a brief (agent_start), comes up as a card in the chat's crew,
 * runs in the project and ends done with a report; its log opens on the
 * brief and holds what it ran, and opens again from the server; a follow-up
 * (agent_send) picks the same conversation up; a stop (agent_stop) ends a
 * long one "stopped"; and the chat itself — its transcript, its status —
 * hears none of it.
 *
 * Costs a few small real turns — run manually: bun run crew-live-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, SubagentState, TranscriptEvent } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7884);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-crew-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-crew-project-"));
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

function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("CREW LIVE FAIL: timed out");
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
        console.error("CREW LIVE FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let chatId: string | undefined;
/** The chat's crew as it stands, by key. */
const crew = new Map<string, SubagentState>();
/** What the server sent for each agent's log, live. */
const logs = new Map<string, TranscriptEvent[]>();
/** Anything the chat itself was told happened in it. */
const chatEvents: TranscriptEvent[] = [];
const chatStatuses: string[] = [];
let fetched: TranscriptEvent[] | undefined;
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !chatId && msg.projects.length > 0) chatId = msg.projects.at(-1)!.sessions[0]!.id;
  if (msg.type === "crew" && msg.projectId === chatId) for (const agent of msg.agents) crew.set(agent.key, agent);
  if (msg.type === "agent_event") logs.set(msg.key, [...(logs.get(msg.key) ?? []), msg.event]);
  if (msg.type === "agent_log") fetched = msg.events;
  if (msg.type === "event" && msg.projectId === chatId) chatEvents.push(msg.event);
  if (msg.type === "status" && msg.projectId === chatId) chatStatuses.push(msg.status);
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

send({ type: "add_project", name: "crew", path: projectDir });
await until("the project", () => Boolean(chatId), 30_000);
if (!chatId) {
  console.error("CREW LIVE FAIL: no project");
  cleanup(1);
}
// this window has the chat open, as the agents page would
send({ type: "view", channels: [chatId], live: true });

const key = "crew-livetest01";
send({
  type: "agent_start",
  projectId: chatId,
  key,
  model: "haiku",
  text: "Run `ls` in the current directory with the Bash tool and report how many entries there are. Do nothing else.",
});
await until("the card", () => crew.has(key), 10_000);
check("the agent came up as a card in the chat's crew", crew.get(key)?.mine === true, crew.get(key));
await until("the agent to finish", () => crew.has(key) && crew.get(key)!.status !== "running", 180_000);
const card = crew.get(key);
console.log(`card: ${JSON.stringify(card)}`);
check("it ended done", card?.status === "done", card?.status);
check("with a report that counts three", /\b(3|three)\b/i.test(card?.result ?? ""), card?.result);
check("its card counted the tools it ran", (card?.tools ?? 0) >= 1, card?.tools);
const log = logs.get(key) ?? [];
console.log(`log kinds: ${log.map((e) => (e.kind === "tool" ? `tool:${e.name}` : e.kind)).join(", ")}`);
check("its log opened on the brief", log[0]?.kind === "user" && log[0].text.includes("ls"), log[0]);
check("and holds what it ran", log.some((e) => e.kind === "tool" && e.name === "Bash"), log);

send({ type: "agent_log", projectId: chatId, key });
await until("the log from the server", () => fetched !== undefined, 10_000);
check("the log opens again from the server, whole", (fetched?.length ?? 0) >= log.length && log.length >= 2, {
  fetched: fetched?.length,
  live: log.length,
});

// a follow-up picks the same conversation up
send({ type: "agent_send", projectId: chatId, key, text: "Now reply with only the number you reported, doubled, as digits." });
await until("the follow-up to start", () => crew.get(key)?.status === "running", 10_000);
await until("the follow-up to finish", () => crew.get(key)?.status !== "running", 120_000);
check(
  "a follow-up ran on the same conversation",
  crew.get(key)?.status === "done" && /\b6\b/.test(crew.get(key)?.result ?? ""),
  crew.get(key),
);

// a stop ends a long one "stopped"
const long = "crew-livetest02";
send({ type: "agent_start", projectId: chatId, key: long, model: "haiku", text: "Run `sleep 60` with the Bash tool, then say done." });
await until("the long one to start a tool", () => (logs.get(long) ?? []).some((e) => e.kind === "tool"), 60_000);
send({ type: "agent_stop", projectId: chatId, key: long });
await until("the stop", () => crew.get(long)?.status !== "running", 30_000);
check("a stopped agent reads stopped", crew.get(long)?.status === "stopped", crew.get(long));

check("the chat itself heard none of it", chatEvents.length === 0 && !chatStatuses.includes("working"), {
  events: chatEvents.map((e) => e.kind),
  statuses: chatStatuses,
});

console.log(failed === 0 ? "\nCREW LIVE PASS" : `\nCREW LIVE FAIL (${failed})`);
cleanup(failed === 0 ? 0 : 1);
