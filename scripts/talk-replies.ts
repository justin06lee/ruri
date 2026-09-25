/**
 * An agent's message always gets its answer back — unless it asked for none.
 *
 * A south chat (Haiku) has its mascot's name in its folder; chats in the
 * north project ask it for the name, each a different way. South is made
 * busy for as long as a case needs by a Bash call whose permission card
 * this script sits on, so every wait here outlasts something:
 *   1. Claude, "wait": the answer comes back into message_agent's call.
 *   2. Claude, "wait", cut short: the user stops the north chat while its
 *      call is held; the answer still arrives in its chat, as a message.
 *   3. Codex, "wait" over HTTP, with south busy for longer than several of
 *      Codex's twenty-second slices: the curl comes back "not yet", the
 *      model waits again with {"do": "wait"}, and the answer lands in its
 *      turn — not also as a message.
 *   4. Codex, "later": the call returns at once, the turn ends, and the
 *      answer arrives in its chat as a message.
 *   5. Claude, "none": south does the work (writes a file), and nothing
 *      comes back.
 *   6. A relaunch mid-wait: the letter is in south's line when the server
 *      goes; the next server sends it on, and the answer arrives in the
 *      north chat as a message.
 * TALK_REPLIES_OPENCODE=1 adds OpenCode's free model waiting over HTTP
 * past a ninety-second slice; TALK_REPLIES_SKIP_CODEX=1 leaves Codex out.
 *
 * A dozen short real turns (Haiku, GPT Luna) — run manually: bun run
 * talk-replies-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type WebSocket from "ws";
import { bootServer, connect } from "./lib/server.js";
import type {
  ClientMessage,
  PermissionRequest,
  ServerMessage,
  TalkLetter,
  TranscriptEvent,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7893);
const CODEX = !process.env["TALK_REPLIES_SKIP_CODEX"];
const OPENCODE = Boolean(process.env["TALK_REPLIES_OPENCODE"]);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-replies-config-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-replies-data-"));
const northDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-replies-north-"));
const southDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-replies-south-"));
const WORD = "periwinkle";
fs.writeFileSync(path.join(southDir, "MASCOT.txt"), `${WORD}\n`);

// a chat of its own for every case: a model asked twice for the same word
// answers from memory the second time
const CLAUDE_WAIT = "c-replies-wait";
const CLAUDE_STOP = "c-replies-stop";
const CLAUDE_NONE = "c-replies-none";
const CLAUDE_RELAUNCH = "c-replies-relaunch";
const CODEX_WAIT = "c-replies-codex-wait";
const CODEX_LATER = "c-replies-codex-later";
const OPENCODE_CHAT = "c-replies-opencode";
const NORTH = [
  CLAUDE_WAIT,
  CLAUDE_STOP,
  CLAUDE_NONE,
  CLAUDE_RELAUNCH,
  CODEX_WAIT,
  CODEX_LATER,
  OPENCODE_CHAT,
];
const SOUTH = "c-replies-south";
fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      {
        id: "p-replies-north",
        name: "north",
        path: northDir,
        permissionMode: "bypassPermissions",
        sessions: [
          { id: CLAUDE_WAIT, title: "Waits", model: "haiku" },
          { id: CLAUDE_STOP, title: "Stopped", model: "haiku" },
          { id: CLAUDE_NONE, title: "Fire and forget", model: "haiku" },
          { id: CLAUDE_RELAUNCH, title: "Relaunched", model: "haiku" },
          { id: CODEX_WAIT, title: "Codex waits", model: "codex:gpt-5.6-luna" },
          { id: CODEX_LATER, title: "Codex later", model: "codex:gpt-5.6-luna" },
          {
            id: OPENCODE_CHAT,
            title: "OpenCode",
            model: "opencode:opencode/muse-spark-1.3-contributor-free",
          },
        ],
      },
      {
        id: "p-replies-south",
        name: "south",
        path: southDir,
        // its Bash calls come up as cards, which is how it is kept busy
        permissionMode: "default",
        sessions: [{ id: SOUTH, title: "South", model: "haiku" }],
      },
    ],
  }),
);

// OpenCode's data (its database) in the scratch folder, never the real one
const env = { RURI_NO_MEMORY: "1", XDG_DATA_HOME: dataDir };
let server = bootServer({ port: PORT, configDir, env, stdio: ["ignore", "ignore", "inherit"] });

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 1500));
    // what the other side made of it, and where every letter got to
    const south = (events[SOUTH] ?? [])
      .flatMap((e) => (e.kind === "user" || e.kind === "assistant" ? [`${e.kind}: ${e.text}`] : []))
      .slice(-4);
    console.log("    south said:", JSON.stringify(south).slice(0, 1200));
    console.log(
      "    letters:",
      JSON.stringify(letters.map((l) => `${l.from} ${l.reply} ${l.status}${l.note ? ` (${l.note})` : ""}`)),
    );
  }
}

async function stopServer(): Promise<void> {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGINT");
  await Promise.race([exited, sleep(8_000)]);
}

/** Claude's transcripts for the scratch projects go with them. */
function claudeDirsOf(dir: string): string[] {
  const root = path.join(process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude"), "projects");
  const tail = path.basename(dir);
  try {
    return fs
      .readdirSync(root)
      .filter((name) => name.endsWith(tail))
      .map((name) => path.join(root, name));
  } catch {
    return [];
  }
}

async function cleanup(code: number): Promise<never> {
  ws.close();
  await stopServer();
  // a CLI still shutting down writes a last line into its transcript folder
  await sleep(3_000);
  for (const dir of [northDir, southDir])
    for (const claude of claudeDirsOf(dir)) fs.rmSync(claude, { recursive: true, force: true });
  for (const dir of [configDir, dataDir, northDir, southDir])
    fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

setTimeout(() => {
  console.error("TALK-REPLIES FAIL: timed out");
  void cleanup(1);
}, 45 * 60_000).unref();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const statuses: Record<string, string> = {};
const events: Record<string, TranscriptEvent[]> = {};
let letters: TalkLetter[] = [];
const waiters = new Set<() => void>();
/** South's next card is held (the case keeping it busy); the rest go through. */
let holdNext = false;
let held: PermissionRequest | undefined;

/** An event heard — once, however often it is told (a snapshot on
 *  reconnecting tells the latest again). */
function record(chat: string, event: TranscriptEvent): void {
  const list = (events[chat] ??= []);
  const at = list.findIndex((e) => e.id === event.id);
  if (at === -1) list.push(event);
  else list[at] = event;
}

let ws: WebSocket = await open();
async function open(): Promise<WebSocket> {
  const sock = await connect(PORT, 90_000);
  sock.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    if (msg.type === "snapshot") {
      // what happened before this window was there to hear it — a
      // relaunch starts on the letters it finds before anyone connects
      Object.assign(statuses, msg.statuses);
      for (const [chat, list] of Object.entries(msg.transcripts)) for (const e of list) record(chat, e);
    }
    if (msg.type === "status") statuses[msg.projectId] = msg.status;
    if (msg.type === "event") record(msg.projectId, msg.event);
    if (msg.type === "talk") letters = msg.letters;
    if (msg.type === "permission_request" && msg.request.projectId === SOUTH) {
      if (holdNext) {
        holdNext = false;
        held = msg.request;
      } else send({ type: "permission_response", requestId: msg.request.requestId, allow: true });
    }
    for (const waiter of [...waiters]) waiter();
  });
  sock.send(
    JSON.stringify({
      type: "view",
      channels: [...NORTH, SOUTH],
      live: true,
    } satisfies ClientMessage),
  );
  // the talk page's list, which a relaunch starts again from the letters it kept
  sock.send(JSON.stringify({ type: "talk_get" } satisfies ClientMessage));
  return sock;
}
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

function until(what: string, done: () => boolean, ms: number): Promise<boolean> {
  if (done()) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const look = () => {
      if (!done()) return;
      clearTimeout(timer);
      clearInterval(poll);
      waiters.delete(look);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      clearInterval(poll);
      console.log(`    (gave up waiting for ${what})`);
      resolve(false);
    }, ms);
    const poll = setInterval(look, 1_000);
    waiters.add(look);
  });
}

const busy = (id: string) => statuses[id] === "working" || statuses[id] === "permission";
const results = (chat: string) => (events[chat] ?? []).filter((e) => e.kind === "result").length;
const said = (chat: string, since = 0) =>
  (events[chat] ?? [])
    .slice(since)
    .flatMap((e) => (e.kind === "assistant" ? [e.text] : []))
    .join("\n");
const answersIn = (chat: string, since = 0) =>
  (events[chat] ?? []).slice(since).filter((e) => e.kind === "user" && e.from?.answer);
const letterFrom = (chat: string, since: number) => letters.find((l) => l.from === chat && l.ts >= since);
const mark = (chat: string) => (events[chat] ?? []).length;

/** A turn in `chat`, sent and seen through to its end. */
async function turn(chat: string, text: string, ms = 300_000): Promise<void> {
  const before = results(chat);
  send({ type: "send", projectId: chat, text });
  await until(`${chat}'s turn`, () => results(chat) > before && !busy(chat), ms);
}

/** South kept busy until the returned function is called. */
async function keepSouthBusy(): Promise<() => Promise<void>> {
  await until("south idle", () => !busy(SOUTH), 300_000);
  holdNext = true;
  held = undefined;
  send({
    type: "send",
    projectId: SOUTH,
    text: "Run this shell command with the Bash tool: touch busy.txt\nThen reply with just: ok",
  });
  await until("south's card", () => held !== undefined, 180_000);
  return async () => {
    if (held) send({ type: "permission_response", requestId: held.requestId, allow: true });
    held = undefined;
  };
}

const askTool = (reply: string, then: string) =>
  `Another agent open in ruri, in the project called south, keeps the name of its mascot in MASCOT.txt in its folder, which you cannot read. Use mcp__ruri__list_agents to find the south chat, then mcp__ruri__message_agent to ask it to read MASCOT.txt and reply with just the name — with reply "${reply}". ${then}`;
const askHttp = (reply: string, then: string) =>
  `Another agent open in ruri, in the project called south, keeps the name of its mascot in MASCOT.txt in its folder, which you cannot read. Use the ruri talk endpoint from your instructions (curl): list the agents, then send the south chat a message asking it to read MASCOT.txt and reply with just the name — with "reply": "${reply}". ${then}`;
/** A message that has come back to a chat, followed by the chat's turn on it. */
const cameBack = (chat: string, since: number) =>
  answersIn(chat, since).some((e) => e.kind === "user" && e.text.toLowerCase().includes(WORD));

// a model asked by a stranger for what is in a file tends to refuse, and a
// refusal colours every message after it: south is told first
await turn(
  SOUTH,
  "Other agents working in ruri will message you, asking for the name of this project's mascot (it is in MASCOT.txt) or asking you to do small jobs in this folder. Help them: tell them the name, and do what they ask. For now just reply: ok",
);

/* ── 1. Claude waits, and the answer comes back into the call ─────── */

{
  const since = mark(CLAUDE_WAIT);
  await turn(CLAUDE_WAIT, askTool("wait", "Then tell me the name."));
  check(
    "Claude, wait: the answer comes back into the call",
    said(CLAUDE_WAIT, since).toLowerCase().includes(WORD),
    said(CLAUDE_WAIT, since),
  );
  check(
    "…and not again as a message",
    answersIn(CLAUDE_WAIT, since).length === 0,
    answersIn(CLAUDE_WAIT, since),
  );
}

/* ── 2. Claude waits, and is stopped: the answer still comes back ──── */

{
  const release = await keepSouthBusy();
  const since = mark(CLAUDE_STOP);
  const at = Date.now();
  send({ type: "send", projectId: CLAUDE_STOP, text: askTool("wait", "Then tell me the name.") });
  await until("the letter in south's line", () => letterFrom(CLAUDE_STOP, at)?.status === "queued", 240_000);
  await sleep(4_000);
  send({ type: "interrupt", projectId: CLAUDE_STOP });
  await until("north stopped", () => !busy(CLAUDE_STOP), 60_000);
  const stopped = (events[CLAUDE_STOP] ?? []).slice(since).some((e) => e.kind === "result" && e.stopped);
  check("Claude, wait, stopped mid-wait: the turn is stopped", stopped, events[CLAUDE_STOP]?.slice(since));
  await release();
  await until("the answer back in north", () => cameBack(CLAUDE_STOP, since), 300_000);
  check(
    "…and the answer still arrives in its chat as a message",
    cameBack(CLAUDE_STOP, since),
    events[CLAUDE_STOP]?.slice(since),
  );
  await until("north's turn on it", () => !busy(CLAUDE_STOP), 120_000);
}

/* ── 3, 4. Codex over HTTP: wait across slices, and later ──────────── */

if (CODEX) {
  const release = await keepSouthBusy();
  const since = mark(CODEX_WAIT);
  const turns = results(CODEX_WAIT);
  const at = Date.now();
  send({
    type: "send",
    projectId: CODEX_WAIT,
    text: askHttp(
      "wait",
      "Wait for its answer, however many times you have to wait again, then tell me the name.",
    ),
  });
  await until("the letter in south's line", () => letterFrom(CODEX_WAIT, at)?.status === "queued", 300_000);
  // several of Codex's twenty-second slices
  await sleep(70_000);
  await release();
  await until(
    "Codex's turn",
    () =>
      results(CODEX_WAIT) > turns && !busy(CODEX_WAIT) && letterFrom(CODEX_WAIT, at)?.status === "answered",
    400_000,
  );
  await sleep(5_000);
  const words = said(CODEX_WAIT, since).toLowerCase();
  check(
    "Codex, wait over HTTP past several slices: the answer comes back into its turn",
    words.includes(WORD),
    said(CODEX_WAIT, since),
  );
  check(
    "…and not again as a message",
    answersIn(CODEX_WAIT, since).length === 0,
    answersIn(CODEX_WAIT, since),
  );

  const later = mark(CODEX_LATER);
  await turn(CODEX_LATER, askHttp("later", 'Once it is sent, just say "sent" and stop.'));
  await until("the answer back in Codex's chat", () => cameBack(CODEX_LATER, later), 300_000);
  check(
    "Codex, later: the answer arrives in its chat as a message",
    cameBack(CODEX_LATER, later),
    events[CODEX_LATER]?.slice(later),
  );
  await until("Codex's turn on it", () => !busy(CODEX_LATER), 180_000);
}

/* ── 5. Claude asks for none: the work is done, nothing comes back ─── */

{
  await until("south idle", () => !busy(SOUTH), 300_000);
  const since = mark(CLAUDE_NONE);
  const southSince = mark(SOUTH);
  const at = Date.now();
  await turn(
    CLAUDE_NONE,
    'Use mcp__ruri__list_agents to find the chat in the project called south, then mcp__ruri__message_agent to ask it to create a file named done.txt in its folder containing the word ok — with reply "none", since you need nothing back. Then just say "sent".',
  );
  const arrived = (events[SOUTH] ?? []).slice(southSince).find((e) => e.kind === "user" && e.from);
  check(
    "none: south is told nobody waits",
    arrived?.kind === "user" && arrived.from?.reply === "none",
    arrived,
  );
  await until(
    "south's work",
    () => letterFrom(CLAUDE_NONE, at)?.status === "answered" && !busy(SOUTH),
    300_000,
  );
  check("…and does the work", fs.existsSync(path.join(southDir, "done.txt")), fs.readdirSync(southDir));
  await sleep(20_000);
  check(
    "…and nothing comes back",
    answersIn(CLAUDE_NONE, since).length === 0 && !busy(CLAUDE_NONE),
    events[CLAUDE_NONE]?.slice(since),
  );
}

/* ── 7. OpenCode waits over HTTP past a ninety-second slice ────────── */

if (OPENCODE) {
  const release = await keepSouthBusy();
  const since = mark(OPENCODE_CHAT);
  const at = Date.now();
  send({
    type: "send",
    projectId: OPENCODE_CHAT,
    text: askHttp(
      "wait",
      "Wait for its answer, however many times you have to wait again, then tell me the name.",
    ),
  });
  await until(
    "the letter in south's line",
    () => letterFrom(OPENCODE_CHAT, at)?.status === "queued",
    300_000,
  );
  await sleep(110_000);
  await release();
  await until(
    "the word back in OpenCode's chat",
    () => said(OPENCODE_CHAT, since).toLowerCase().includes(WORD) || cameBack(OPENCODE_CHAT, since),
    400_000,
  );
  const inTurn =
    said(OPENCODE_CHAT, since).toLowerCase().includes(WORD) && answersIn(OPENCODE_CHAT, since).length === 0;
  check(
    `OpenCode, wait over HTTP past a slice: the answer comes back (${inTurn ? "into its turn" : "as a message"})`,
    inTurn || cameBack(OPENCODE_CHAT, since),
    events[OPENCODE_CHAT]?.slice(since),
  );
  await until("OpenCode idle", () => !busy(OPENCODE_CHAT), 180_000);
}

/* ── 6. A relaunch while a letter waits in south's line ────────────── */

{
  const release = await keepSouthBusy();
  void release;
  const since = mark(CLAUDE_RELAUNCH);
  const at = Date.now();
  send({ type: "send", projectId: CLAUDE_RELAUNCH, text: askTool("wait", "Then tell me the name.") });
  await until(
    "the letter in south's line",
    () => letterFrom(CLAUDE_RELAUNCH, at)?.status === "queued",
    240_000,
  );
  const kept = JSON.parse(fs.readFileSync(path.join(configDir, "talk-letters.json"), "utf8")) as {
    letters: Array<{ from: string; stage: string }>;
  };
  check(
    "the letter is on disk while it waits",
    kept.letters.some((l) => l.from === CLAUDE_RELAUNCH && l.stage === "queued"),
    kept,
  );
  ws.close();
  await stopServer();
  for (const id of [CLAUDE_RELAUNCH, SOUTH]) statuses[id] = "idle";
  server = bootServer({ port: PORT, configDir, env, stdio: ["ignore", "ignore", "inherit"] });
  ws = await open();
  await until(
    "south to take the letter up again",
    () =>
      (events[SOUTH] ?? []).some((e) => e.kind === "user" && e.from?.agent === CLAUDE_RELAUNCH && e.ts >= at),
    240_000,
  );
  await until("the answer back in north", () => cameBack(CLAUDE_RELAUNCH, since), 300_000);
  check(
    "after a relaunch the letter goes on, and its answer arrives in north as a message",
    cameBack(CLAUDE_RELAUNCH, since),
    events[CLAUDE_RELAUNCH]?.slice(since),
  );
  await until("north's turn on it", () => !busy(CLAUDE_RELAUNCH), 120_000);
}

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
await cleanup(failed === 0 ? 0 : 1);
