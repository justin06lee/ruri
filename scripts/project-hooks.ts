/**
 * Project hooks end to end (server/projectHooks.ts, with the chat runs'
 * idle and blocked detection): a scratch server on a temp config, a temp
 * project with a two-layer stack, and two hooks — a command that appends
 * what it is handed to a file, and a webhook on a tiny local HTTP server
 * that wants a bearer token. midna is kept out (RURI_MIDNA="").
 *
 *   1. the hooks over the socket: none to start with, then the global
 *      ones set — the token never comes back — and a bad URL refused;
 *   2. "send test event": one project.test at the command and one at the
 *      webhook, the same event, in exactly the shape midna reads;
 *   3. real turns (haiku): the lead hands a question to a teammate, the
 *      teammate answers, the lead relays it — and once the team has been
 *      quiet past the debounce, exactly one project.idle arrives at each
 *      hook, naming the lead and the teammate, with the spend;
 *   4. a chat that ends its turn asking the user a question: one
 *      project.blocked, that chat first, what it asks in its summary;
 *   5. a failing hook (a webhook that answers 503 twice) and a slow one
 *      (a command that takes 20s): the project's next prompt is answered
 *      while they are still going, the webhook comes good on its third
 *      try, the command finishes, and the global hooks hear nothing of it.
 *
 * Costs a handful of small real turns — run manually: bun run project-hooks-test
 * (HOOKS_DELIVERY_ONLY=1 runs 1, 2 and 5 only: delivery, no detection).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type {
  ClientMessage,
  HooksView,
  Project,
  ProjectEventPayload,
  ServerMessage,
  TranscriptEvent,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7894);
/** How long the team has to be quiet before it is idle — the chat runs'
 *  debounce, shortened so the test doesn't sit a minute each time. */
const IDLE_MS = Number(process.env["HOOKS_IDLE_MS"] ?? 15_000);
const TOKEN = "e2e-bearer-token";
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hooks-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hooks-project-"));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-hooks-out-"));
const commandOut = path.join(outDir, "command.jsonl");
const slowOut = path.join(outDir, "slow.jsonl");
const TREE = "quince";

fs.mkdirSync(path.join(projectDir, "notes"));
fs.writeFileSync(
  path.join(projectDir, "notes", "README.md"),
  `# Orchard notes\n\nThe orchard's first tree is a ${TREE}, planted in the spring.\n`,
);
fs.writeFileSync(path.join(projectDir, "WORDS.txt"), "apple\npear\n");
fs.mkdirSync(path.join(projectDir, ".ruri"));
const sheet = (summary: string) => ({ summary, map: [], flows: [], files: [], rules: [], edges: [] });
fs.writeFileSync(
  path.join(projectDir, ".ruri", "architecture.json"),
  JSON.stringify({
    description: "A tiny orchard: its notes, and a word list.",
    features: ["notes on the orchard's trees", "a word list"],
    layers: [
      {
        name: "Orchard notes",
        what: "The notes about the orchard's trees, in notes/",
        slug: "notes",
        paths: ["notes/"],
      },
      { name: "Word list", what: "The project's words, in WORDS.txt", slug: "words", paths: ["WORDS.txt"] },
    ],
    layerSheets: {
      notes: sheet("The orchard's notes: notes/README.md says what grows where."),
      words: sheet("The project's words: WORDS.txt, one to a line."),
    },
  }),
);

/* ── the webhook ───────────────────────────────────────────────────── */

interface Hit {
  path: string;
  auth?: string;
  body: string;
  at: number;
}
const hits: Hit[] = [];
let flaky = 0;
const hookServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk: Buffer) => (body += chunk.toString()));
  req.on("end", () => {
    hits.push({
      path: req.url ?? "",
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
      body,
      at: Date.now(),
    });
    if (req.url === "/flaky" && ++flaky <= 2) {
      res.writeHead(503).end("not yet");
      return;
    }
    if (req.url === "/hook" && req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end("who are you");
      return;
    }
    res.writeHead(200).end("ok");
  });
});
await new Promise<void>((resolve) => hookServer.listen(0, "127.0.0.1", resolve));
const hookBase = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}`;

/* ── the server ────────────────────────────────────────────────────── */

const server = bootServer({
  port: PORT,
  configDir,
  stdio: ["ignore", "ignore", "inherit"],
  env: {
    RURI_NO_MEMORY: "1",
    RURI_NO_HARNESS_UPDATES: "1",
    RURI_MIDNA: "",
    RURI_HOOK_RETRY_MS: "1000,2000,2000,2000",
    RURI_IDLE_MS: String(IDLE_MS),
  },
});

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 2000));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  hookServer.closeAllConnections();
  hookServer.close();
  for (const dir of [configDir, projectDir, outDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("HOOKS FAIL: timed out");
  cleanup(1);
}, 1_800_000);
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
        console.error("HOOKS FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projects: Project[] = [];
let hooks: HooksView | undefined;
let hooksError: string | undefined;
const statuses: Record<string, string> = {};
const events: Record<string, TranscriptEvent[]> = {};
const cards: Array<{ requestId: string; projectId: string; kind?: string }> = [];
const waiters = new Set<() => void>();
/** Every raw message, to look for a token that should never be in one. */
let heard = "";

const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  heard += String(raw);
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" || msg.type === "snapshot") projects = msg.projects;
  if (msg.type === "status") statuses[msg.projectId] = msg.status;
  if (msg.type === "event") (events[msg.projectId] ??= []).push(msg.event);
  if (msg.type === "permission_request") cards.push(msg.request);
  if (msg.type === "hooks") {
    hooks = msg.hooks;
    if (msg.error) hooksError = msg.error;
  }
  for (const waiter of [...waiters]) waiter();
});

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
    const poll = setInterval(look, 500);
    const timer = setTimeout(() => {
      clearInterval(poll);
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve(false);
    }, ms);
    waiters.add(look);
  });
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What the command hook has been handed, one event a line. */
const commandEvents = (file = commandOut): ProjectEventPayload[] => {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ProjectEventPayload);
  } catch {
    return [];
  }
};
const webhookEvents = (at = "/hook"): ProjectEventPayload[] =>
  hits
    .filter((h) => h.path === at && h.auth === `Bearer ${TOKEN}`)
    .map((h) => JSON.parse(h.body) as ProjectEventPayload);
const ofKind = (list: ProjectEventPayload[], kind: string) => list.filter((e) => e.kind === kind);

const KEYS = ["at", "chats", "costUsd", "id", "kind", "project", "source"];
const CHAT_KEYS = ["id", "lastSummary", "name", "role"];
function exactShape(payload: ProjectEventPayload | undefined): boolean {
  if (!payload) return false;
  return (
    JSON.stringify(Object.keys(payload).sort()) === JSON.stringify(KEYS) &&
    payload.source === "ruri" &&
    /^[0-9a-f-]{36}$/.test(payload.id) &&
    JSON.stringify(Object.keys(payload.project).sort()) === JSON.stringify(["id", "name", "path"]) &&
    typeof payload.costUsd === "number" &&
    !Number.isNaN(Date.parse(payload.at)) &&
    payload.chats.every(
      (chat) =>
        JSON.stringify(Object.keys(chat).sort()) === JSON.stringify(CHAT_KEYS) &&
        ["lead", "teammate", "liaison"].includes(chat.role) &&
        chat.lastSummary.length <= 601,
    )
  );
}

const busy = (id: string) => statuses[id] === "working" || statuses[id] === "permission";
const ours = () => projects.find((p) => p.path === fs.realpathSync(projectDir) || p.path === projectDir);
const said = (id: string) =>
  (events[id] ?? [])
    .flatMap((e) => (e.kind === "assistant" ? [e.text] : []))
    .join("\n")
    .toLowerCase();
const results = (id: string) => (events[id] ?? []).filter((e) => e.kind === "result");
const teamQuiet = () => (ours()?.sessions ?? []).every((s) => !busy(s.id));

/* ── 1. the hooks over the socket ──────────────────────────────────── */

send({ type: "hooks_get" });
await until("the hooks", () => hooks !== undefined, 30_000);
check(
  "to start with: no midna, the default global hook, which is nothing",
  hooks?.midna === null &&
    hooks.global.custom === false &&
    hooks.global.command === "" &&
    hooks.global.url === "",
  hooks,
);
send({ type: "hooks_set", command: `cat >> '${commandOut}'`, url: `${hookBase}/hook`, token: TOKEN });
await until("the global hooks", () => hooks?.global.custom === true, 10_000);
check(
  "the global hooks set: the command, the URL, a token — never the token itself",
  hooks?.global.command === `cat >> '${commandOut}'` &&
    hooks.global.url === `${hookBase}/hook` &&
    hooks.global.hasToken &&
    !heard.includes(TOKEN),
  hooks?.global,
);
send({ type: "hooks_set", url: "ftp://nope.example/x" });
await until("the refusal", () => hooksError !== undefined, 10_000);
check(
  "a URL that isn't http(s) is refused, and the hooks are as they were",
  Boolean(hooksError?.includes("Not a webhook URL")) && hooks?.global.url === `${hookBase}/hook`,
  { hooksError, global: hooks?.global },
);

/* ── 2. send test event ────────────────────────────────────────────── */

send({ type: "add_project", name: "orchard", path: projectDir });
await until("the project", () => Boolean(ours()?.sessions[0]), 30_000);
const project = ours();
if (!project) {
  console.error("HOOKS FAIL: no project", projects);
  cleanup(1);
}
const lead = project.sessions[0]!;
send({ type: "set_model", projectId: lead.id, model: "haiku" });
await settle(500);

send({ type: "hooks_test", projectId: project.id });
await until(
  "the test event at both hooks",
  () => commandEvents().length >= 1 && webhookEvents().length >= 1,
  30_000,
);
const testCommand = commandEvents()[0];
const testHook = webhookEvents()[0];
check(
  "one project.test at the command",
  commandEvents().length === 1 && testCommand?.kind === "project.test",
  commandEvents(),
);
check(
  "and one at the webhook, with the bearer token",
  webhookEvents().length === 1 && testHook?.kind === "project.test",
  hits,
);
check("the same event at both", testCommand?.id === testHook?.id, { testCommand, testHook });
check(
  "in exactly midna's shape, about the project, its lead named",
  exactShape(testCommand) &&
    testCommand?.project.id === project.id &&
    testCommand.project.name === "orchard" &&
    testCommand.chats[0]?.role === "lead" &&
    testCommand.costUsd === 0,
  testCommand,
);
await until(
  "the deliveries to read ok",
  () => (hooks?.deliveries ?? []).filter((d) => d.kind === "project.test").every((d) => d.state === "ok"),
  10_000,
);
check(
  "the page's deliveries say both went, first try",
  (hooks?.deliveries ?? []).filter((d) => d.kind === "project.test" && d.state === "ok" && d.attempts === 1)
    .length === 2,
  hooks?.deliveries,
);

/* HOOKS_DELIVERY_ONLY=1 skips 3 and 4: no idle or blocked detection needed */
if (!process.env["HOOKS_DELIVERY_ONLY"]) {
  /* ── 3. the team goes to work, hands off, and goes idle ────────────── */

  const idleBefore = () => ofKind(commandEvents(), "project.idle").length;
  send({
    type: "send",
    projectId: lead.id,
    text: "What does the orchard's notes say its first tree is? Just tell me the tree's name.",
  });
  await until("the lead to start", () => busy(lead.id), 90_000);
  const notesMate = () =>
    ours()?.sessions.find((s) => s.id !== lead.id && !s.liaison && (s.layers?.includes("notes") ?? false));
  await until("a teammate for the notes", () => Boolean(notesMate()), 300_000);
  const mate = notesMate();
  check("the lead hands the job to the notes layer's teammate", Boolean(mate), ours());
  await until("the lead to relay the tree", () => said(lead.id).includes(TREE) && teamQuiet(), 480_000);
  const quietAt = Date.now();
  check("the answer lands, and the lead relays it", said(lead.id).includes(TREE), said(lead.id));
  check(
    "no project.idle while the lead had handed off and the teammate worked",
    idleBefore() === 0,
    ofKind(commandEvents(), "project.idle"),
  );
  await until(
    "the project.idle",
    () => idleBefore() >= 1 && ofKind(webhookEvents(), "project.idle").length >= 1,
    IDLE_MS + 60_000,
  );
  // and nothing more, a while after
  await settle(IDLE_MS + 5_000);
  const idles = ofKind(commandEvents(), "project.idle");
  const idleHooks = ofKind(webhookEvents(), "project.idle");
  check("exactly one project.idle at the command", idles.length === 1, idles);
  check(
    "and exactly one at the webhook, the same one",
    idleHooks.length === 1 && idleHooks[0]?.id === idles[0]?.id,
    idleHooks,
  );
  const idle = idles[0];
  check("in midna's shape", exactShape(idle), idle);
  check(
    "after the team had been quiet the debounce, not before",
    Boolean(idle) && Date.parse(idle!.at) >= quietAt + IDLE_MS - 5_000,
    { at: idle?.at, quietAt: new Date(quietAt).toISOString() },
  );
  const leadRow = idle?.chats.find((c) => c.id === lead.id);
  const mateRow = idle?.chats.find((c) => c.id === mate?.id);
  check(
    "naming the lead, with its last reply",
    leadRow?.role === "lead" && leadRow.name === "Lead" && leadRow.lastSummary.toLowerCase().includes(TREE),
    idle?.chats,
  );
  check(
    "and the teammate that worked, with its",
    mateRow?.role === "teammate" && mateRow.lastSummary.length > 0 && mateRow.name === mate?.title,
    idle?.chats,
  );
  const spent = [lead.id, mate?.id ?? ""]
    .flatMap((id) => results(id))
    .reduce((sum, r) => sum + (r.kind === "result" ? (r.costUsd ?? 0) : 0), 0);
  check(
    "costUsd is what the team spent since it went busy",
    Boolean(idle) && idle!.costUsd > 0 && Math.abs(idle!.costUsd - spent) < 0.01,
    { costUsd: idle?.costUsd, spent },
  );

  /* ── 4. a chat that ends its turn asking: project.blocked ─────────── */

  send({
    type: "send",
    projectId: lead.id,
    text:
      "Before you do anything else: ask me, with a question card (AskUserQuestion), whether I prefer apples or pears. " +
      "Don't delegate this one — it's for me. Then stop and wait for my answer.",
  });
  await until("the project.blocked", () => ofKind(commandEvents(), "project.blocked").length >= 1, 300_000);
  await settle(5_000);
  const blocks = ofKind(commandEvents(), "project.blocked");
  const blocked = blocks[0];
  check("one project.blocked", blocks.length === 1, blocks);
  check(
    "at the webhook too",
    ofKind(webhookEvents(), "project.blocked").length === 1,
    hits.map((h) => h.path),
  );
  check(
    "in midna's shape, the waiting chat first, saying what it asks",
    exactShape(blocked) &&
      blocked?.chats[0]?.id === lead.id &&
      /apple|pear/i.test(blocked.chats[0]?.lastSummary ?? ""),
    blocked,
  );
  // answer the card, so the project can go on
  const card = cards.find((c) => c.projectId === lead.id && c.kind === "question");
  if (card) {
    send({
      type: "question_response",
      requestId: card.requestId,
      answers: { answers: { "": "pears" }, response: "pears" },
    });
  }
  await until("the lead to finish", () => teamQuiet(), 240_000);
  // and the period to close, so its idle can't reach the hooks 5 sets up
  const idlesBefore = ofKind(commandEvents(), "project.idle").length;
  await until(
    "the period's idle",
    () => ofKind(commandEvents(), "project.idle").length > idlesBefore,
    IDLE_MS + 30_000,
  );
}

/* ── 5. a failing hook and a slow one never hold the project up ────── */

send({
  type: "hooks_set",
  projectId: project.id,
  useGlobal: false,
  url: `${hookBase}/flaky`,
  command: `sleep 20; cat >> '${slowOut}'`,
});
await until("the project's own hooks", () => hooks?.projects[project.id]?.useGlobal === false, 10_000);
const globalCount = commandEvents().length + webhookEvents().length;
send({ type: "hooks_test", projectId: project.id });
const sentAt = Date.now();
await settle(500);
const before = results(lead.id).length;
send({ type: "send", projectId: lead.id, text: "Reply with just the word ready." });
await until("the lead's answer", () => results(lead.id).length > before, 120_000);
const answeredAt = Date.now();
check(
  "the project's next prompt is answered while the slow hook still runs",
  results(lead.id).length > before && answeredAt - sentAt < 20_000 && commandEvents(slowOut).length === 0,
  { answeredIn: answeredAt - sentAt, slow: commandEvents(slowOut).length },
);
const flakyTest = () =>
  (hooks?.deliveries ?? []).find(
    (d) => d.kind === "project.test" && d.target === "webhook" && d.scope === "project",
  );
check(
  "the failing webhook is being retried, the failure kept for the page",
  (flaky >= 1 && (flakyTest()?.attempts ?? 0) >= 1 && /503/.test(flakyTest()?.result ?? "")) ||
    flakyTest()?.state === "ok",
  flakyTest(),
);
await until("the flaky webhook to come good", () => flakyTest()?.state === "ok", 60_000);
check(
  "and it comes good on its third try",
  flakyTest()?.state === "ok" && flakyTest()?.attempts === 3,
  flakyTest(),
);
await until("the slow command to finish", () => commandEvents(slowOut).length >= 1, 60_000);
check(
  "the slow command finishes and gets its event",
  commandEvents(slowOut)[0]?.kind === "project.test",
  commandEvents(slowOut),
);
check(
  "the global hooks heard nothing of the project's own test",
  commandEvents().length + webhookEvents().length === globalCount,
  { before: globalCount, now: commandEvents().length + webhookEvents().length },
);

console.log(failed ? `\nHOOKS FAIL: ${failed} check(s) failed` : "\nHOOKS OK");
cleanup(failed ? 1 : 0);
