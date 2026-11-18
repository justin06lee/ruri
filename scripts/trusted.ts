/**
 * A trusted agent answers in the user's place.
 *
 * Three projects, each one chat (Sessions mode, the default): keeper, the
 * agent the user trusts; north and south, at work.
 *
 * First, for free, with no turns:
 *   - with no trusted agent, a question asked with ask_trusted (over HTTP,
 *     POST /talk/<chat>) is the user's from the start, and their answer
 *     comes back to the asker;
 *   - a chat that is not trusted is refused the cards;
 *   - once keeper is registered — only the window can — nobody speaks for
 *     it over HTTP, where a chat's id is all that is asked for.
 *
 * Then, with real turns (haiku):
 *   1. keeper messages north, which is outside bypass mode, with a job
 *      that needs a tool: north's card is handed to keeper, into the call
 *      keeper is waiting in; keeper allows it, the job is done, the answer
 *      comes back — and the user was never asked;
 *   2. north asks with ask_trusted: the question reaches keeper as a
 *      message, and keeper's answer comes back to north's call.
 *
 * Costs a handful of small real turns — run manually: bun run trusted-test
 * (TRUSTED_FREE_ONLY=1 runs just the free part).
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
  TranscriptEvent,
  TrustedAgent,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7893);
const dirs = ["config", "keeper", "north", "south"].map((name) =>
  fs.mkdtempSync(path.join(os.tmpdir(), `ruri-trusted-${name}-`)),
);
const [configDir, keeperDir, northDir, southDir] = dirs as [string, string, string, string];

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail)?.slice(0, 1500));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("TRUSTED FAIL: timed out");
  cleanup(1);
}, 900_000);
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
        console.error("TRUSTED FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projects: Project[] = [];
let trusted: TrustedAgent[] = [];
const statuses: Record<string, string> = {};
const events: Record<string, TranscriptEvent[]> = {};
/** Every card as it went up, and each time it changed. */
const cards: PermissionRequest[] = [];
const resolved = new Set<string>();
const waiters = new Set<() => void>();

console.log(`trusted-test: a server on ${PORT}, three projects, then the free checks`);
const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects") projects = msg.projects;
  if (msg.type === "status") statuses[msg.projectId] = msg.status;
  if (msg.type === "event") (events[msg.projectId] ??= []).push(msg.event);
  if (msg.type === "trusted") trusted = msg.agents;
  if (msg.type === "permission_request") cards.push(msg.request);
  if (msg.type === "permission_resolved") resolved.add(msg.requestId);
  for (const waiter of [...waiters]) waiter();
});

function until(what: string, done: () => boolean, ms: number): Promise<void> {
  if (done()) return Promise.resolve();
  const began = Date.now();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!done()) return;
      clearTimeout(timer);
      clearInterval(beat);
      waiters.delete(look);
      resolve();
    };
    const beat = setInterval(
      () => console.log(`    still waiting for ${what}… ${Math.round((Date.now() - began) / 1000)}s`),
      15_000,
    );
    const timer = setTimeout(() => {
      waiters.delete(look);
      clearInterval(beat);
      console.log(`    (gave up waiting for ${what})`);
      resolve();
    }, ms);
    waiters.add(look);
  });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (id: string) => statuses[id] === "working" || statuses[id] === "permission";
const projectAt = (dir: string) => projects.find((p) => p.path === fs.realpathSync(dir) || p.path === dir);
const said = (chat: string) =>
  (events[chat] ?? []).flatMap((e) => (e.kind === "assistant" ? [e.text] : [])).join("\n");
const infos = (chat: string) => (events[chat] ?? []).flatMap((e) => (e.kind === "info" ? [e.text] : []));

for (const [name, dir] of [
  ["keeper", keeperDir],
  ["north", northDir],
  ["south", southDir],
] as const) {
  send({ type: "add_project", name, path: dir });
  await until(name, () => Boolean(projectAt(dir)?.sessions[0]), 30_000);
}
const keeperProject = projectAt(keeperDir);
const northProject = projectAt(northDir);
if (!keeperProject || !northProject || !projectAt(southDir)) {
  console.error("TRUSTED FAIL: no projects", projects);
  cleanup(1);
}
const keeper = keeperProject.sessions[0]!.id;
const north = northProject.sessions[0]!.id;
// a chat's model and permission mode are that chat's own: set by its id
for (const chat of [keeper, north]) send({ type: "set_model", projectId: chat, model: "haiku" });
await settle(500);

const talkCall = async (chat: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/talk/${chat}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as {
      ok: boolean;
      text?: string;
      ask?: string;
      answered?: boolean;
      by?: string;
      answer?: string;
    } | null,
  };
};

/* ── 0. for free: no trusted agent, the door, the list ─────────────── */

const QUESTION = "May the nightly job use the deploy password?";
const asking = talkCall(north, { do: "trusted", question: QUESTION });
await until("the user's card", () => cards.some((c) => c.toolName === "ask_trusted"), 20_000);
const own = cards.find((c) => c.toolName === "ask_trusted");
check(
  "with no trusted agent, a question asked with ask_trusted is a card for the user",
  own?.kind === "question" && own.projectId === north && own.asked === undefined,
  own,
);
if (own)
  send({ type: "question_response", requestId: own.requestId, answers: { answers: { [QUESTION]: "Deny" } } });
const asked = await asking;
check(
  "and their answer comes back to the asker",
  asked.body?.answered === true && asked.body.by === "user" && asked.body.answer === "Deny",
  asked,
);
const notMine = await talkCall(north, { do: "cards" });
check(
  "a chat that is not trusted is refused the cards",
  Boolean(notMine.body?.text?.includes("Only a chat the user has registered")),
  notMine,
);

send({ type: "trusted_set", projects: [keeperProject.id] });
await until("keeper registered", () => trusted.some((t) => t.project === keeperProject.id), 10_000);
check("the window registers keeper as trusted", trusted.length === 1, trusted);
const spoken = await talkCall(keeper, { do: "cards" });
check(
  "and nobody speaks for a trusted chat that holds its own tools, over HTTP",
  spoken.status === 403,
  spoken,
);

if (process.env["TRUSTED_FREE_ONLY"]) {
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  cleanup(failed === 0 ? 0 : 1);
}

/* ── 1. a card of a turn keeper prompted is keeper's to answer ─────── */

/** What a chat did, in short, for a check that failed. */
const trail = (chat: string) =>
  (events[chat] ?? []).map((e) =>
    e.kind === "tool"
      ? `tool ${e.name}: ${e.summary}`.slice(0, 300)
      : e.kind === "user" || e.kind === "assistant" || e.kind === "info"
        ? `${e.kind}: ${e.text}`.slice(0, 600)
        : e.kind === "result"
          ? `result ok=${e.ok}${e.error ? ` ${e.error}` : ""}`
          : e.kind,
  );

if (process.env["TRUSTED_ONLY"] !== "2") {
  console.log("trusted-test: [1/2] keeper hands north a job that needs a card (real turns, haiku)");
  send({ type: "set_permission_mode", projectId: north, mode: "default" });
  await settle(800);
  const seen = cards.length;
  send({
    type: "send",
    projectId: keeper,
    text:
      "Use mcp__ruri__message_agent to send the project called north this message, with reply wait: " +
      "'Run the shell command `echo periwinkle > made.txt` in your folder with your Bash tool, then reply with the single word done.' " +
      "If the call comes back with a <ruri:card> instead of an answer, allow that card with mcp__ruri__answer_card (allow true), " +
      "then call mcp__ruri__wait_for_answer with the letter id you were given, and repeat until north's answer arrives. " +
      "Finally tell me what north answered.",
  });
  await until("north's card", () => cards.length > seen, 240_000);
  const handed = cards.slice(seen).find((c) => c.projectId === north);
  check(
    "north's card is handed to keeper, not to the user",
    handed?.asked?.agent === keeper && handed.asked.name === "keeper",
    handed,
  );
  await until(
    "keeper to finish",
    () => !busy(keeper) && (events[keeper] ?? []).some((e) => e.kind === "result"),
    420_000,
  );
  await settle(1500);
  check("keeper answered it: the card came down", Boolean(handed && resolved.has(handed.requestId)), [
    ...resolved,
  ]);
  check(
    "the job it allowed was done",
    fs.existsSync(path.join(northDir, "made.txt")) &&
      fs.readFileSync(path.join(northDir, "made.txt"), "utf8").includes("periwinkle"),
    fs.readdirSync(northDir),
  );
  check(
    "north's transcript says who allowed it",
    infos(north).some((line) => line.startsWith("keeper, trusted to answer for you, allowed")),
    infos(north),
  );
  check("and north's answer came back to keeper", /done/i.test(said(keeper)), said(keeper));
  check(
    "the card never became the user's",
    !cards.slice(seen).some((c) => c.requestId === handed?.requestId && c.asked === undefined),
    cards.slice(seen),
  );
}

/* ── 2. a chat asks, and the trusted agent decides ─────────────────── */

console.log("trusted-test: [2/2] north asks the trusted agent (real turns, haiku)");
send({ type: "set_permission_mode", projectId: north, mode: "bypassPermissions" });
await settle(800);
const before = cards.length;
const turns = (events[north] ?? []).filter((e) => e.kind === "result").length;
send({
  type: "send",
  projectId: north,
  text:
    "Call mcp__ruri__ask_trusted with the question 'This is a drill: please answer Deny, with the reason drill.' " +
    "and then tell me, word for word, what came back.",
});
await until(
  "the question's card",
  () => cards.slice(before).some((c) => c.toolName === "ask_trusted"),
  240_000,
);
const question = cards.slice(before).find((c) => c.toolName === "ask_trusted");
check("the question is handed to keeper", question?.asked?.agent === keeper, question);
await until(
  "north to finish",
  () => !busy(north) && (events[north] ?? []).filter((e) => e.kind === "result").length > turns,
  150_000,
);
await settle(1500);
check(
  "keeper's answer comes back to north's call",
  /keeper/i.test(said(north)) && /deny/i.test(said(north)),
  { north: trail(north), keeper: trail(keeper) },
);
check(
  "and it is written into north's transcript",
  infos(north).some((line) => line.includes("answered what this chat asked")),
  infos(north),
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
