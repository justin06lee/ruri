/**
 * A chat's session can't be lost, whatever the user does to it.
 *
 * "Lost" is any of: the model no longer remembers what was said, the
 * transcript loses turns, a prompt fails with a missing session, the chat
 * quietly starts over without its history, or a switch back to an earlier
 * model can't pick its session back up. Against the real CLIs, on an
 * isolated server (a scratch config folder, scratch project folders, no
 * small model, the processes reaped within moments of going idle), this
 * plants codewords in one chat and then does everything a user does to a
 * chat — switches its model back and forth across harnesses (Claude, Codex,
 * OpenCode), switches while a turn runs and switches again, opens another
 * chat and comes back mid-turn, drops the socket mid-turn, leaves the chat
 * until its process is reaped, restarts the server between turns and in
 * the middle of one, kills it outright, compacts, rewinds — and after every
 * step asks the chat for its codewords and checks:
 *
 * - the reply names every codeword planted so far, on whichever harness;
 * - nothing failed: no failed turn, no error, no missing-session line;
 * - the transcript still holds every prompt it has ever held;
 * - the archive still knows every session the chat has run on, and the
 *   session each harness had is the one it goes back to.
 *
 * Harnesses that aren't installed are skipped. Costs a few dozen short
 * turns on the cheapest models (Haiku, Codex's Luna, OpenCode's free
 * model) — run manually: bun run session-stress-test
 *
 * STRESS_CLAUDE / STRESS_CODEX / STRESS_OPENCODE pick the models ("" skips
 * a harness); STRESS_STEPS=name,name runs only those steps (after the
 * plant); RURI_PORT picks the port.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7891);

function installed(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The model each harness runs on here — its cheapest — or none, skipped. */
const pickModel = (env: string, fallback: string, bin: string): string | undefined => {
  const chosen = process.env[env] ?? fallback;
  return chosen && installed(bin) ? chosen : undefined;
};
const MODELS = {
  claude: pickModel("STRESS_CLAUDE", "haiku", "claude"),
  codex: pickModel("STRESS_CODEX", "codex:gpt-6-luna", "codex"),
  opencode: pickModel("STRESS_OPENCODE", "opencode:opencode/muse-spark-1.3-contributor-free", "opencode"),
};
type Harness = keyof typeof MODELS;
const HARNESSES = (Object.keys(MODELS) as Harness[]).filter((h) => MODELS[h]);
if (!MODELS.claude) {
  console.error("session-stress needs `claude`");
  process.exit(1);
}
const only = process.env["STRESS_STEPS"]?.split(",").map((s) => s.trim());

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-stress-config-"));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-stress-data-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-stress-project-"));
const CHAT = "c-stress-main";
const OTHER = "c-stress-other";
const claudeProjects = path.join(
  process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude"),
  "projects",
);

fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      {
        id: "p-stress",
        name: "stress",
        path: projectDir,
        permissionMode: "bypassPermissions",
        effort: "low",
        sessions: [
          { id: CHAT, title: "main", model: MODELS.claude, effort: "low" },
          { id: OTHER, title: "other", model: MODELS.claude, effort: "low" },
        ],
      },
    ],
  }),
);

/* ── the server, which comes and goes ─────────────────────────────── */

let server: ReturnType<typeof bootServer> | undefined;
let serverLog = "";

function boot(): void {
  server = bootServer({
    port: PORT,
    configDir,
    env: {
      RURI_NO_MEMORY: "1",
      // a process closes within moments of its chat going quiet, so every
      // step after the first finds it gone and has to resume
      RURI_REAP_GRACE_MS: "300",
      RURI_ASLEEP_REAP_MS: "300",
      RURI_IDLE_REAP_MS: "4000",
      // OpenCode's database in the scratch folder, never the real one
      XDG_DATA_HOME: dataDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr?.on("data", (d: Buffer) => {
    serverLog += d.toString();
  });
}

/** The process listening on the port, if any. */
function listener(): number | undefined {
  try {
    const out = execFileSync("lsof", ["-nP", "-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The server this script started: the process on the port whose
 *  environment names this run's scratch config — under the wrappers
 *  bootServer starts it through, which a signal does not cross. Anything
 *  else on the port is somebody else's, and never signalled. */
function ourServer(): number | undefined {
  const pid = listener();
  if (pid === undefined) return undefined;
  try {
    const command = execFileSync("ps", ["-wwE", "-o", "command=", "-p", String(pid)], { encoding: "utf8" });
    return command.includes(`RURI_CONFIG_DIR=${configDir}`) ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Stop the server: SIGINT is a quit (everything flushed), SIGKILL a crash. */
async function halt(signal: "SIGINT" | "SIGKILL"): Promise<void> {
  const running = server;
  server = undefined;
  const pid = ourServer();
  if (pid) process.kill(pid, signal);
  running?.kill(signal);
  for (let i = 0; i < 60 && ourServer() !== undefined; i++) await sleep(250);
  // a crash leaves the harness processes it started behind: they go too
  if (signal === "SIGKILL") killChatProcesses();
  await sleep(1_000);
}

/** Every harness process started for the scratch chats. */
function chatProcesses(chat?: string): number[] {
  const lines = execFileSync("ps", ["-axwwE", "-o", "pid=,command="], { encoding: "utf8" }).split("\n");
  // this run's alone: the harnesses carry the server's environment, and
  // with it the scratch config folder
  return lines
    .filter(
      (line) =>
        line.includes(`RURI_CONFIG_DIR=${configDir}`) &&
        (chat ? line.includes(`RURI_CHANNEL=${chat}`) : line.includes("RURI_CHANNEL=c-stress-")),
    )
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid) && pid !== process.pid);
}

function killChatProcesses(): void {
  for (const pid of chatProcesses()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // gone already
    }
  }
}

function claudeDirs(): string[] {
  const tail = path.basename(projectDir);
  try {
    return fs
      .readdirSync(claudeProjects)
      .filter((name) => name.endsWith(tail))
      .map((name) => path.join(claudeProjects, name));
  } catch {
    return [];
  }
}

async function cleanup(code: number): Promise<never> {
  await halt("SIGINT");
  killChatProcesses();
  await sleep(1_000);
  if (process.env["STRESS_KEEP"] === "1") {
    console.log(`kept: config ${configDir}, project ${projectDir}, data ${dataDir}`);
    process.exit(code);
  }
  for (const dir of claudeDirs()) fs.rmSync(dir, { recursive: true, force: true });
  for (const dir of [projectDir, configDir, dataDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
setTimeout(
  () => {
    console.error("SESSION-STRESS FAIL: timed out");
    void cleanup(1);
  },
  Number(process.env["STRESS_TIMEOUT_MS"]) || 45 * 60_000,
).unref();

/* ── the window ────────────────────────────────────────────────────── */

let ws: WebSocket | undefined;
const results = new Map<string, Array<Extract<TranscriptEvent, { kind: "result" }>>>();
const statuses = new Map<string, string>();
const errors: string[] = [];
let transcript: Extract<ServerMessage, { type: "transcript" }> | undefined;
const waiters = new Set<() => void>();

async function connect(): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      ws = await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(wsUrl(PORT));
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
      break;
    } catch {
      if (Date.now() - start > 60_000) {
        throw new Error(`could not connect to the server; it said:\n${serverLog.slice(-2000)}`);
      }
      await sleep(400);
    }
  }
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    if (msg.type === "event" && msg.event.kind === "result") {
      const list = results.get(msg.projectId) ?? [];
      // one turn, one result: the same one read back from the transcript
      // while the socket was down is not counted twice
      if (!list.some((r) => r.id === msg.event.id)) list.push(msg.event);
      results.set(msg.projectId, list);
    } else if (msg.type === "status") statuses.set(msg.projectId, msg.status);
    else if (msg.type === "snapshot") {
      for (const [id, status] of Object.entries(msg.statuses)) statuses.set(id, status);
    } else if (msg.type === "error") errors.push(msg.message);
    else if (msg.type === "transcript" && msg.projectId === CHAT) transcript = msg;
    for (const waiter of [...waiters]) waiter();
  });
  // what a window on the main chat says, awake
  view([CHAT]);
}

function send(msg: ClientMessage): void {
  ws?.send(JSON.stringify(msg));
}

function view(channels: string[]): void {
  send({ type: "view", channels, live: true, awake: true });
}

function until(what: string, ok: () => boolean, ms: number, quiet = false): Promise<boolean> {
  if (ok()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const look = () => {
      if (!ok()) return;
      clearTimeout(timer);
      waiters.delete(look);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      if (!quiet) console.log(`    (gave up waiting for ${what})`);
      resolve(false);
    }, ms);
    waiters.add(look);
  });
}

async function fetchTranscript(): Promise<Extract<ServerMessage, { type: "transcript" }> | undefined> {
  transcript = undefined;
  send({ type: "transcript_get", projectId: CHAT });
  await until("the transcript", () => transcript !== undefined, 10_000);
  return transcript;
}

/* ── what is checked ───────────────────────────────────────────────── */

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}`);
  if (ok) passed += 1;
  else {
    failed += 1;
    if (detail !== undefined) console.log("      ", JSON.stringify(detail).slice(0, 900));
  }
}

const harnessOf = (model: string): Harness =>
  model.startsWith("codex:") ? "codex" : model.startsWith("opencode:") ? "opencode" : "claude";

interface Archived {
  lastSessionId?: string;
  sessionIds?: string[];
  harnesses?: Record<string, { session?: string; seen?: string; sent?: string }>;
}
function archived(): Archived {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, "sessions", `${CHAT}.json`), "utf8")) as Archived;
  } catch {
    return {};
  }
}
/** A session id as the archive keeps it, to the harness it runs on. */
const sessionHarness = (id: string): Harness =>
  id.startsWith("codex:") ? "codex" : id.startsWith("opencode:") ? "opencode" : "claude";

/** Every prompt the transcript has ever held, and every session the chat ran on. */
const everPrompts = new Set<string>();
const everSessions = new Set<string>();
/** Ids the script itself made up (a session deleted out from under the chat) — never ruri's to keep. */
const madeUp = new Set<string>();
/** The session each harness was last on — what a switch back must resume. */
const lastOn = new Map<Harness, string>();
const planted: string[] = [];
let model = MODELS.claude;
let errorsAt = 0;

function setModel(next: string): void {
  model = next;
  send({ type: "set_model", projectId: CHAT, model: next });
}

/** Send a prompt and wait for its turn's result. Answers the reply text. */
async function turn(text: string, opts: { waitMs?: number } = {}): Promise<{ ok: boolean; reply: string }> {
  const before = results.get(CHAT)?.length ?? 0;
  send({ type: "send", projectId: CHAT, text });
  const ended = await until(
    `the turn "${text.slice(0, 40)}"`,
    () => (results.get(CHAT)?.length ?? 0) > before,
    opts.waitMs ?? 180_000,
  );
  return { ok: ended, reply: ended ? await replyTo(text) : "" };
}

/** The reply the transcript holds to the newest prompt with this text. */
async function replyTo(text: string): Promise<string> {
  const got = await fetchTranscript();
  const events = got?.events ?? [];
  const at = events.findLastIndex((e) => e.kind === "user" && e.text === text);
  if (at === -1) return "";
  const out: string[] = [];
  for (const event of events.slice(at + 1)) {
    if (event.kind === "user") break;
    if (event.kind === "assistant") out.push(event.text);
  }
  return out.join("\n");
}

const ASK =
  "Which codewords have I asked you to remember in this conversation so far? Reply with just the codewords, comma-separated, and use no tools.";

/** The check after every step: the chat still remembers, and nothing was lost. */
async function verify(step: string): Promise<void> {
  const harness = harnessOf(model);
  const { ok, reply } = await turn(ASK);
  const last = results.get(CHAT)?.at(-1);
  check(`${step}: the ask was answered (${harness})`, ok && last?.ok === true, last);
  const missing = planted.filter((word) => !reply.toUpperCase().includes(word));
  check(`${step}: the reply names every codeword (${planted.join(", ")})`, missing.length === 0, reply);
  // nothing went wrong along the way
  const said = errors.slice(errorsAt).filter((m) => !/^rewound —/.test(m));
  errorsAt = errors.length;
  check(`${step}: no error reached the window`, said.length === 0, said);
  const got = await fetchTranscript();
  const events = got?.events ?? [];
  const bad = events.filter(
    (e) =>
      (e.kind === "result" && !e.ok && !e.stopped) ||
      (e.kind === "info" && /session error|No conversation found|No message found|not found/i.test(e.text)),
  );
  check(`${step}: no failed turn or missing-session line in the transcript`, bad.length === 0, bad);
  // the transcript keeps every prompt it ever held (a compaction folds
  // them into the outline above it, which still names them)
  const now = new Set([
    ...events.flatMap((e) => (e.kind === "user" ? [e.id] : [])),
    ...(got?.earlier ?? []).flatMap((item) => (item.kind === "turn" ? [item.turnId] : [])),
  ]);
  const gone = [...everPrompts].filter((id) => !now.has(id));
  check(
    `${step}: the transcript still holds all ${everPrompts.size} earlier prompts`,
    gone.length === 0,
    gone,
  );
  for (const id of now) everPrompts.add(id);
  // the archive still knows every session this chat has run on
  await sleep(200);
  const archive = archived();
  const known = new Set([
    ...(archive.sessionIds ?? []),
    ...(archive.lastSessionId ? [archive.lastSessionId] : []),
  ]);
  const forgotten = [...everSessions].filter((id) => !known.has(id) && !madeUp.has(id));
  check(`${step}: the archive still has all ${everSessions.size} session ids`, forgotten.length === 0, {
    forgotten,
    archive,
  });
  for (const id of known) everSessions.add(id);
  // the harness the chat is on answers from the session it had before —
  // unless that one was rightly let go of (a compaction, a rewind)
  const current = archive.lastSessionId;
  if (current && sessionHarness(current) === harness) {
    const before = lastOn.get(harness);
    if (before) check(`${step}: ${harness} resumed its own session`, before === current, { before, current });
    lastOn.set(harness, current);
  } else {
    check(`${step}: the archive is on a ${harness} session`, false, archive);
  }
}

async function plant(word: string): Promise<void> {
  planted.push(word);
  const text = `Remember this codeword for later: ${word}. Reply with just the word "noted" and use no tools.`;
  const { ok } = await turn(text);
  check(`planted ${word} on ${harnessOf(model)}`, ok && results.get(CHAT)?.at(-1)?.ok === true);
}

const LONG = "Count from 1 to 80, one number per line, and nothing else. Use no tools.";

/** Start a turn that runs a few seconds, and wait for it to be running. */
async function startLongTurn(): Promise<number> {
  const before = results.get(CHAT)?.length ?? 0;
  statuses.set(CHAT, "idle");
  send({ type: "send", projectId: CHAT, text: LONG });
  await until("the long turn to start", () => statuses.get(CHAT) === "working", 60_000);
  return before;
}

/** The running turn's end — heard, or (the socket was down when it came)
 *  read back from the transcript once the chat has gone quiet. */
async function waitResult(before: number, ms = 180_000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if ((results.get(CHAT)?.length ?? 0) > before) return true;
    if (statuses.get(CHAT) !== "working" && statuses.get(CHAT) !== "permission") {
      const events = (await fetchTranscript())?.events ?? [];
      const at = events.findLastIndex((e) => e.kind === "user" && e.text === LONG);
      const result = events.slice(at + 1).find((e) => e.kind === "result");
      if (at !== -1 && result && result.kind === "result") {
        results.set(CHAT, [...(results.get(CHAT) ?? []), result]);
        return true;
      }
    }
    await until("the running turn's result", () => (results.get(CHAT)?.length ?? 0) > before, 2_000, true);
  }
  console.log("    (gave up waiting for the running turn's result)");
  return false;
}

const word = (n: number) => `${["AMBER", "COBALT", "SAFFRON", "VIRIDIAN", "UMBER"][n % 5]}-${100 + n}`;

/* ── the steps ─────────────────────────────────────────────────────── */

const others = HARNESSES.filter((h) => h !== "claude");
const steps: Array<[string, () => Promise<void>]> = [];
const step = (name: string, run: () => Promise<void>) => steps.push([name, run]);

// across harnesses and back, each planting a word of its own
others.forEach((harness, i) => {
  step(`switch-to-${harness}`, async () => {
    setModel(MODELS[harness]!);
    await plant(word(i + 1));
  });
  step(`back-to-claude-from-${harness}`, async () => {
    setModel(MODELS.claude!);
  });
});
if (others.length >= 2) {
  step("codex-to-opencode-to-codex", async () => {
    setModel(MODELS[others[1]!]!);
    await verify(`on ${others[1]}`);
    setModel(MODELS[others[0]!]!);
  });
}
// a switch while a turn runs lands after it, and the next prompt is on it
step("switch-mid-turn", async () => {
  setModel(MODELS.claude!);
  await verify("on claude before the long turn");
  const before = await startLongTurn();
  setModel(MODELS[others[0] ?? "claude"]!);
  check("the running turn ended well", (await waitResult(before)) && results.get(CHAT)!.at(-1)!.ok);
});
// and several, back and forth, under one turn
step("switch-thrash-mid-turn", async () => {
  const before = await startLongTurn();
  for (const h of [...HARNESSES, ...HARNESSES].reverse()) {
    setModel(MODELS[h]!);
    await sleep(150);
  }
  setModel(MODELS.claude!);
  check("the running turn ended well", (await waitResult(before)) && results.get(CHAT)!.at(-1)!.ok);
});
// switches with no turn between them: only the last one counts
step("rapid-switches", async () => {
  for (const h of [...HARNESSES, ...HARNESSES]) setModel(MODELS[h]!);
  setModel(MODELS[others[0] ?? "claude"]!);
});
// another chat opened, and prompted, while this one's turn runs
step("other-chat-mid-turn", async () => {
  const before = await startLongTurn();
  view([OTHER]);
  const otherBefore = results.get(OTHER)?.length ?? 0;
  send({ type: "send", projectId: OTHER, text: "Reply with the single word: ok. Use no tools." });
  await until("the other chat's answer", () => (results.get(OTHER)?.length ?? 0) > otherBefore, 120_000);
  view([CHAT]);
  check("the running turn ended well", (await waitResult(before)) && results.get(CHAT)!.at(-1)!.ok);
});
// the window's socket drops mid-turn and comes back
step("disconnect-mid-turn", async () => {
  setModel(MODELS.claude!);
  const before = await startLongTurn();
  ws?.terminate();
  await sleep(1_500);
  await connect();
  check("the running turn ended well", (await waitResult(before)) && results.get(CHAT)!.at(-1)!.ok);
});
// left alone until the process is reaped, on each harness
for (const harness of HARNESSES) {
  step(`reaped-on-${harness}`, async () => {
    setModel(MODELS[harness]!);
    await verify(`on ${harness} before leaving`);
    view([]);
    const gone = await (async () => {
      for (let i = 0; i < 40; i++) {
        if (chatProcesses(CHAT).length === 0) return true;
        await sleep(500);
      }
      return false;
    })();
    check(`the ${harness} process was reaped`, gone, chatProcesses(CHAT));
    view([CHAT]);
  });
}
// the app quits and comes back between turns
step("restart-between-turns", async () => {
  await halt("SIGINT");
  boot();
  await connect();
});
// the app quits in the middle of a turn
step("restart-mid-turn", async () => {
  await startLongTurn();
  await halt("SIGINT");
  boot();
  await connect();
});
// the app crashes the moment a switch to another harness starts its turn
step("crash-mid-switch", async () => {
  const target = others[0] ?? "claude";
  setModel(MODELS[target]!);
  await startLongTurn();
  await halt("SIGKILL");
  boot();
  await connect();
});
// quit while a switch is waiting on a running turn
step("restart-with-pending-switch", async () => {
  setModel(MODELS.claude!);
  await verify("on claude");
  await startLongTurn();
  setModel(MODELS[others[0] ?? "claude"]!);
  await halt("SIGINT");
  boot();
  await connect();
});
// a compaction, then a switch away and back
step("compact-then-switch", async () => {
  setModel(MODELS.claude!);
  send({ type: "send", projectId: CHAT, text: "/compact" });
  await sleep(1_500);
  // a compaction starts every harness afresh, from its brief
  lastOn.clear();
  await verify("after /compact");
  if (others[0]) {
    setModel(MODELS[others[0]]!);
    await verify(`on ${others[0]} after /compact`);
    setModel(MODELS.claude!);
  }
});
// a rewind of the last exchange, on each harness
for (const harness of HARNESSES) {
  step(`rewind-on-${harness}`, async () => {
    setModel(MODELS[harness]!);
    await verify(`on ${harness} before the rewind`);
    const got = await fetchTranscript();
    const last = got?.events.findLast((e) => e.kind === "user");
    if (!last) return check("a prompt to rewind", false);
    send({ type: "rewind", projectId: CHAT, eventId: last.id });
    await sleep(2_500);
    // the rewound prompt is gone on purpose, and the sessions that held
    // it may be too
    everPrompts.delete(last.id);
    lastOn.clear();
  });
}
// the harness loses the session the chat is on (its files pruned, its
// database reset): the next prompt still answers, from a fresh session
// briefed on the conversation, on every harness
for (const harness of HARNESSES) {
  step(`lost-${harness}-session`, async () => {
    setModel(MODELS[harness]!);
    await verify(`on ${harness} before its session goes`);
    await halt("SIGINT");
    const file = path.join(configDir, "sessions", `${CHAT}.json`);
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Archived;
    const tail = Math.random().toString(16).slice(2, 14).padEnd(12, "0");
    const nowhere =
      harness === "claude"
        ? `28c0b0cb-8759-4a25-8af9-${tail}`
        : harness === "codex"
          ? `codex:019a0000-0000-7000-8000-${tail}`
          : `opencode:ses_${tail}nowhere0000000`;
    raw.lastSessionId = nowhere;
    const held = raw.harnesses?.[harness];
    if (held) held.session = nowhere;
    fs.writeFileSync(file, JSON.stringify(raw));
    // the one it had is gone for good: a fresh one is what comes back
    lastOn.delete(harness);
    madeUp.add(nowhere);
    boot();
    await connect();
  });
}
// the app quits before a fresh session's first turn has said anything:
// the brief that turn carried must not go with it
step("quit-before-first-reply", async () => {
  setModel(MODELS.claude!);
  send({ type: "send", projectId: CHAT, text: "/compact" });
  await sleep(1_500);
  lastOn.clear();
  await startLongTurn();
  await halt("SIGINT");
  boot();
  await connect();
});
// the same, crashing — for each harness
for (const harness of HARNESSES) {
  step(`crash-before-first-reply-on-${harness}`, async () => {
    setModel(MODELS[harness]!);
    send({ type: "send", projectId: CHAT, text: "/compact" });
    await sleep(1_500);
    lastOn.clear();
    await startLongTurn();
    await sleep(1_200);
    await halt("SIGKILL");
    boot();
    await connect();
  });
}

/* ── run ───────────────────────────────────────────────────────────── */

console.log(`session-stress on ${HARNESSES.map((h) => `${h} (${MODELS[h]})`).join(", ")}`);
if (listener() !== undefined) {
  // somebody else's server: never started over, never signalled
  console.error(`SESSION-STRESS FAIL: port ${PORT} is taken — pick another with RURI_PORT`);
  await cleanup(1);
}
try {
  boot();
  await connect();
  await sleep(1_000);
  console.log("\n[plant]");
  await plant(word(0));
  await verify("plant");
  for (const [name, run] of steps) {
    if (only && !only.includes(name)) continue;
    console.log(`\n[${name}]`);
    try {
      await run();
      await verify(name);
    } catch (err) {
      check(`${name} ran`, false, String(err));
    }
  }
  console.log("\n[every harness, once more]");
  for (const harness of HARNESSES) {
    setModel(MODELS[harness]!);
    await verify(`final on ${harness}`);
  }
} catch (err) {
  // whatever went wrong, the server and its harnesses do not outlive the run
  check("the run went to the end", false, String(err));
}

const problems = serverLog
  .split("\n")
  .filter((line) => /could not be resumed|is gone|isn't in session|died starting|session error/i.test(line));
if (problems.length) console.log(`\nserver said:\n  ${problems.slice(0, 20).join("\n  ")}`);
console.log(`\n${passed} passed, ${failed} failed`);
await cleanup(failed === 0 ? 0 : 1);
