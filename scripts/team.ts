/**
 * A project as a team: the lead the user talks to, and teammates it hands
 * work to that sleep between jobs (server/team.ts).
 *
 * One project, so one chat — its lead. First, for free, over HTTP the way
 * a harness without ruri's tools manages its team (POST /talk/<lead>):
 *   0. the roster says there is no one yet, and the machine; a teammate is
 *      added, found by name, its duty changed, and retired; a teammate has
 *      no team to manage; the sidebar's projects never show a member.
 * Then real turns (haiku):
 *   1. the lead is asked something only a teammate can find out — it adds
 *      one and asks it; the teammate's prompt is marked as the lead's, the
 *      answer comes back into the lead's reply, and the teammate is asleep
 *      (no process) a moment after its turn;
 *   2. with room for one teammate at work (RURI_TEAM_MAX=1), a message to a
 *      second while the first works waits for a slot — and goes, and is
 *      answered, once the first is done.
 *
 * Costs a handful of small real turns — run manually: bun run team-test
 * (TEAM_HTTP_ONLY=1 runs just the free part).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type {
  ClientMessage,
  Project,
  ServerMessage,
  TeamMember,
  TranscriptEvent,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7893);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-team-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-team-project-"));
const WORD = "marigold";
fs.writeFileSync(path.join(projectDir, "SECRET.txt"), `${WORD}\n`);

const server = bootServer({
  port: PORT,
  configDir,
  stdio: ["ignore", "ignore", "inherit"],
  env: { RURI_TEAM_MAX: "1", RURI_NO_MEMORY: "1", RURI_NO_HARNESS_UPDATES: "1" },
});

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 1500));
  }
}

function cleanup(code: number): never {
  server.kill("SIGINT");
  for (const dir of [configDir, projectDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("TEAM FAIL: timed out");
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
        console.error("TEAM FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projects: Project[] = [];
const statuses: Record<string, string> = {};
const events: Record<string, TranscriptEvent[]> = {};
let team: TeamMember[] = [];
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects") projects = msg.projects;
  if (msg.type === "status") statuses[msg.projectId] = msg.status;
  if (msg.type === "event") (events[msg.projectId] ??= []).push(msg.event);
  if (msg.type === "team") team = msg.members;
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
const ours = () => projects.find((p) => p.path === fs.realpathSync(projectDir) || p.path === projectDir);
const said = (id: string) =>
  (events[id] ?? [])
    .flatMap((e) => (e.kind === "assistant" ? [e.text] : []))
    .join("\n")
    .toLowerCase();

send({ type: "add_project", name: "orchard", path: projectDir });
await until("the project", () => Boolean(ours()?.sessions[0]), 30_000);
const project = ours();
if (!project) {
  console.error("TEAM FAIL: no project", projects);
  cleanup(1);
}
const lead = project.sessions[0]!;
check("a new project is one chat: its lead", project.sessions.length === 1 && lead.lead === true, project);
send({ type: "set_model", projectId: project.id, model: "haiku" });
await settle(500);

const talkCall = async (chat: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/talk/${chat}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status === 200 ? ((await res.json()) as { ok: boolean; text: string }) : null;
};

/* ── 0. the team over HTTP, no turns ─────────────────────────────────── */

const empty = await talkCall(lead.id, { do: "team" });
check(
  "the roster says there is no one yet, and what the machine has room for",
  Boolean(empty?.text.includes("No teammates") && empty.text.includes("Teammates at work across ruri: 0")),
  empty,
);
const added = await talkCall(lead.id, { do: "add", name: "Clerk", duty: "keeps the project's notes" });
check("a teammate is added, asleep until messaged", Boolean(added?.text.includes("asleep until")), added);
await until("the projects to say so", () => (ours()?.sessions.length ?? 0) === 2, 10_000);
const clerk = ours()?.sessions.find((s) => s.title === "Clerk");
check(
  "it is a member of the project, with its duty, not a lead",
  Boolean(clerk && !clerk.lead && clerk.duty === "keeps the project's notes"),
  ours(),
);
const roster = await talkCall(lead.id, { do: "team" });
check("the roster names it, asleep", Boolean(roster?.text.includes("Clerk — asleep")), roster);
const updated = await talkCall(lead.id, {
  do: "update",
  who: "clerk",
  duty: "keeps notes and the changelog",
});
check("found by name, its duty changes", Boolean(updated?.text.includes("Updated Clerk")), updated);
const rogue = clerk ? await talkCall(clerk.id, { do: "add", name: "Rogue", duty: "x" }) : null;
check("a teammate has no team to manage", Boolean(rogue?.text.includes("Only the lead")), rogue);
const retired = await talkCall(lead.id, { do: "retire", who: "Clerk" });
check("retired, it is gone", Boolean(retired?.text.includes("Retired Clerk")), retired);
await until("the projects to say so", () => (ours()?.sessions.length ?? 0) === 1, 10_000);
check("and only the lead is left", ours()?.sessions.length === 1, ours());
if (process.env["TEAM_HTTP_ONLY"]) {
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  cleanup(failed === 0 ? 0 : 1);
}

/* ── 1. the lead adds a teammate, asks it, and hears back ──────────── */

const ASK =
  "There is a word in SECRET.txt in this project. Don't read it yourself: add a teammate named Scout (mcp__ruri__add_teammate) " +
  "whose duty is reading this project's files, and give it, as its first message, the job of reading SECRET.txt and replying with just the word. " +
  "Then tell me the word.";
send({ type: "send", projectId: lead.id, text: ASK });
await until("the lead to start", () => busy(lead.id), 90_000);
await until("Scout to join", () => Boolean(ours()?.sessions.find((s) => s.title === "Scout")), 240_000);
const scout = ours()?.sessions.find((s) => s.title === "Scout");
check("the lead adds Scout", Boolean(scout && !scout.lead), ours());
if (!scout) cleanup(1);
await until("Scout's job", () => (events[scout.id] ?? []).some((e) => e.kind === "user"), 240_000);
const job = (events[scout.id] ?? []).find((e) => e.kind === "user");
check(
  "its job arrives marked as the lead's",
  job?.kind === "user" && job.from?.agent === lead.id && job.from.title === "Lead",
  job,
);
await until(
  "the lead to finish",
  () => !busy(lead.id) && (events[lead.id] ?? []).some((e) => e.kind === "result"),
  420_000,
);
await settle(1500);
check("Scout's answer comes back into the lead's reply", said(lead.id).includes(WORD), said(lead.id));
// a member nobody has open closes its process a moment after its turn
await settle(6000);
send({ type: "team_get", projectId: project.id });
await until("the team", () => team.some((m) => m.id === scout.id), 10_000);
check(
  "and Scout is asleep again — no process, its conversation kept",
  team.find((m) => m.id === scout.id)?.state === "asleep" &&
    (team.find((m) => m.id === scout.id)?.exchanges ?? 0) >= 1,
  team,
);

/* ── 2. room for one at work: the second waits for a slot ──────────── */

const second = await talkCall(lead.id, {
  do: "add",
  name: "Second",
  duty: "answers simple questions",
});
check("a second teammate is added", Boolean(second?.text.includes("Added Second")), second);
const slow = await talkCall(lead.id, {
  do: "send",
  to: "Scout",
  message: "Run the shell command `sleep 12` with your Bash tool, then reply with just the word done.",
  reply: "later",
});
check("Scout is given a slow job", Boolean(slow?.text.includes("Sent to")), slow);
await until("Scout to start", () => busy(scout.id), 120_000);
const queued = await talkCall(lead.id, {
  do: "send",
  to: "Second",
  message: "Reply with just the word ok.",
  reply: "later",
});
check(
  "a message to Second while Scout works waits for a slot",
  Boolean(queued?.text.includes("waiting for a free slot")),
  queued,
);
const secondId = ours()?.sessions.find((s) => s.title === "Second")?.id ?? "";
send({ type: "team_get", projectId: project.id });
await settle(1200);
check(
  "the team page has Second queued for a slot",
  team.find((m) => m.id === secondId)?.state === "queued",
  team,
);
check("and nothing of it has reached Second yet", !(events[secondId] ?? []).some((e) => e.kind === "user"));
await until("Scout to finish", () => !busy(scout.id) && said(scout.id).includes("done"), 240_000);
await until("Second to answer", () => said(secondId).includes("ok"), 240_000);
check(
  "once Scout is done, Second gets its turn and answers",
  said(secondId).includes("ok"),
  events[secondId],
);
check(
  "and the two never worked at once",
  (() => {
    const scoutEnd = (events[scout.id] ?? []).findLast((e) => e.kind === "result")?.ts ?? 0;
    const secondStart = (events[secondId] ?? []).find((e) => e.kind === "user")?.ts ?? 0;
    return secondStart >= scoutEnd;
  })(),
  { scout: events[scout.id], second: events[secondId] },
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
