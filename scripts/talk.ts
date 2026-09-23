/**
 * Agents talk to agents in other projects.
 *
 * Two projects, a chat in each. The north chat is asked to find out a word
 * only the south project holds (a file in its folder) by messaging the
 * south chat — list_agents, then message_agent, waiting on the answer:
 *   1. in bypass the message goes straight to the south chat, arrives there
 *      marked as the north chat's, and the answer comes back into the tool
 *      call and so into north's reply;
 *   2. outside bypass a card comes up in the north chat instead, and a no
 *      means nothing reaches the south chat at all.
 *
 * First, for free, the same over HTTP — the way a harness without ruri's
 * tools talks (POST /talk/<chat>): who it may message, a handle that finds
 * the other chat, and a browser's page turned away.
 *
 * Costs a handful of small real turns (haiku) — run manually: bun run talk-test
 * (TALK_HTTP_ONLY=1 runs just the free part).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type {
  ClientMessage,
  PermissionRequest,
  Project,
  ServerMessage,
  TalkLetter,
  TranscriptEvent,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7891);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-talk-config-"));
const northDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-talk-north-"));
const southDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-talk-south-"));
const WORD = "periwinkle";
fs.writeFileSync(path.join(southDir, "SECRET.txt"), `${WORD}\n`);

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 1200));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  for (const dir of [configDir, northDir, southDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("TALK FAIL: timed out");
  cleanup(1);
}, 600_000);
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
        console.error("TALK FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projects: Project[] = [];
const statuses: Record<string, string> = {};
const events: Record<string, TranscriptEvent[]> = {};
let letters: TalkLetter[] = [];
const cards: PermissionRequest[] = [];
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects") projects = msg.projects;
  if (msg.type === "status") statuses[msg.projectId] = msg.status;
  if (msg.type === "event") (events[msg.projectId] ??= []).push(msg.event);
  if (msg.type === "talk") letters = msg.letters;
  if (msg.type === "permission_request" && msg.request.kind === "message") cards.push(msg.request);
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
const busy = (id: string) => statuses[id] === "working" || statuses[id] === "permission";
const chatOf = (dir: string) => projects.find((p) => p.path === fs.realpathSync(dir) || p.path === dir);

send({ type: "add_project", name: "north", path: northDir });
await until("north", () => Boolean(chatOf(northDir)?.sessions[0]), 30_000);
send({ type: "add_project", name: "south", path: southDir });
await until("south", () => Boolean(chatOf(southDir)?.sessions[0]), 30_000);
const northProject = chatOf(northDir);
const southProject = chatOf(southDir);
if (!northProject || !southProject) {
  console.error("TALK FAIL: no projects", projects);
  cleanup(1);
}
const north = northProject.sessions[0]!.id;
const south = southProject.sessions[0]!.id;
for (const p of [northProject, southProject]) send({ type: "set_model", projectId: p.id, model: "haiku" });
await settle(500);

/* ── 0. over HTTP, no turns ─────────────────────────────────────────── */

const talkCall = async (chat: string, body: unknown, origin?: string) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/talk/${chat}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: res.status === 200 ? ((await res.json()) as { ok: boolean; text: string }) : null,
  };
};
const listed = await talkCall(north, { do: "list" });
const handle = listed.body?.text.match(/^\s+([0-9a-f]{8})\s/m)?.[1];
check(
  "over HTTP, north is told who it may message",
  Boolean(listed.body?.ok && listed.body.text.includes("south")),
  listed,
);
check("with a handle for the south chat", Boolean(handle), listed.body?.text);
const refused = await talkCall(north, { do: "list" }, "https://example.com");
check("a browser's page is turned away", refused.status === 403, refused.status);
const nobody = await talkCall("not-a-chat", { do: "list" });
check("and a chat that is not one gets nothing", nobody.status === 404, nobody.status);
if (process.env["TALK_HTTP_ONLY"]) {
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  cleanup(failed === 0 ? 0 : 1);
}

const ASK =
  "Another agent open in ruri, in the project called south, knows a secret word: it is in SECRET.txt in its folder, which you cannot read. " +
  "Use mcp__ruri__list_agents to find the south chat, then use mcp__ruri__message_agent to ask it to read SECRET.txt and reply with just the word (reply: wait). " +
  "Then tell me the word.";

/* ── 1. bypass: straight there, and the answer comes back ──────────── */

send({ type: "send", projectId: north, text: ASK });
await until("north to start", () => busy(north), 90_000);
await until("south to be messaged", () => (events[south] ?? []).some((e) => e.kind === "user"), 240_000);
const arrived = (events[south] ?? []).find((e) => e.kind === "user");
check(
  "the message arrives in the south chat, marked as north's",
  arrived?.kind === "user" && arrived.from?.agent === north && arrived.from.project === "north",
  arrived,
);
await until(
  "north to finish",
  () => !busy(north) && (events[north] ?? []).some((e) => e.kind === "result"),
  300_000,
);
await settle(1500);
const northSaid = (events[north] ?? [])
  .filter((e) => e.kind === "assistant")
  .map((e) => (e.kind === "assistant" ? e.text : ""))
  .join("\n");
check("south's answer comes back to north, word and all", northSaid.toLowerCase().includes(WORD), northSaid);
check(
  "the talk page has it answered",
  letters.some((l) => l.from === north && l.to === south && l.status === "answered"),
  letters,
);
check("and bypass put no card up", cards.length === 0, cards);

/* ── 2. outside bypass: a card, and a no stops it ──────────────────── */

const southBefore = (events[south] ?? []).filter((e) => e.kind === "user").length;
send({ type: "set_permission_mode", projectId: northProject.id, mode: "default" });
await settle(800);
send({
  type: "send",
  projectId: north,
  text: "Use mcp__ruri__message_agent to send the south chat the message 'ping' (reply: none). Then say done.",
});
await until("the card", () => cards.length > 0, 240_000);
const card = cards[0];
check(
  "outside bypass a card comes up in the north chat",
  card?.projectId === north && card.toolName === "message_agent",
  card,
);
if (card) send({ type: "permission_response", requestId: card.requestId, allow: false });
await until("north to finish again", () => !busy(north), 240_000);
await settle(2500);
check(
  "a no means nothing reaches the south chat",
  (events[south] ?? []).filter((e) => e.kind === "user").length === southBefore,
  events[south],
);
check(
  "and the talk page says you said no",
  letters.some((l) => l.from === north && l.status === "denied"),
  letters,
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
