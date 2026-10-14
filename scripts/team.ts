/**
 * A project as a team: the lead the user talks to, which delegates every
 * task; teammates — one per layer of the stack, made the first time a job
 * for one comes up — that sleep between jobs; and the liaison, the second
 * lead other projects' agents reach (server/team.ts).
 *
 * Two temp projects: orchard, with a stack of two layers (notes, words) in
 * its .ruri/architecture.json, and grove, the outside. First, for free,
 * over HTTP the way a harness without ruri's tools runs its team
 * (POST /talk/<lead>):
 *   0. the roster says there is no one yet and which layers have no
 *      teammate, and no word of the machine; a teammate is added for a
 *      layer (its name and duty from it), never twice; one by name and
 *      duty, found by name, its duty changed; a teammate has no team to
 *      run; stop and restart on one asleep do nothing, refresh puts a fresh
 *      one in its place; retired, only the lead is left; grove sees orchard
 *      through its liaison, not made yet.
 * Then real turns (haiku):
 *   1. the lead, with an empty team, is asked an ordinary question — it
 *      adds the right layer's teammate and hands the job off without being
 *      told to, its own turn ending while the teammate works, never reading
 *      the file itself; the answer lands and the lead relays it;
 *   2. grove's lead hands orchard a question: it lands at orchard's
 *      liaison, made then — never at its lead — which delegates it, and the
 *      answer comes back to grove;
 *   3. the lead's hand on a teammate, mid-turn: a message queued behind
 *      its work waits; stop ends the turn and the queued one goes on; a
 *      message interrupts it and it goes back to its work; restart closes
 *      it; compact runs as its turn ends; refresh puts a fresh one in its
 *      place for the same layer — and on one asleep: a queued message goes
 *      at once, compact condenses it, retire takes it off the team.
 *
 * Costs a dozen or so small real turns — run manually: bun run team-test
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
  SessionInfo,
  TeamMember,
  TranscriptEvent,
} from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7893);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-team-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-team-project-"));
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-team-outside-"));
const WORD = "marigold";
const TREE = "quince";
fs.writeFileSync(path.join(projectDir, "SECRET.txt"), `${WORD}\n`);
fs.mkdirSync(path.join(projectDir, "notes"));
fs.writeFileSync(
  path.join(projectDir, "notes", "README.md"),
  `# Orchard notes\n\nThe orchard's first tree is a ${TREE}, planted in the spring.\n`,
);
// the stack the project's clone brought: two layers, each with its sheet
fs.mkdirSync(path.join(projectDir, ".ruri"));
const sheet = (summary: string) => ({ summary, map: [], flows: [], files: [], rules: [], edges: [] });
fs.writeFileSync(
  path.join(projectDir, ".ruri", "architecture.json"),
  JSON.stringify({
    description: "A tiny orchard: its notes, and a word list with the project's secret word.",
    features: ["notes on the orchard's trees", "a secret word"],
    layers: [
      {
        name: "Orchard notes",
        what: "The notes about the orchard's trees, in notes/",
        slug: "notes",
        paths: ["notes/"],
      },
      {
        name: "Word list",
        what: "The project's words, the secret word in SECRET.txt among them",
        slug: "words",
        paths: ["SECRET.txt"],
      },
    ],
    layerSheets: {
      notes: sheet("The orchard's notes: notes/README.md says what grows where."),
      words: sheet("The project's words: SECRET.txt holds the secret word."),
    },
  }),
);

const server = bootServer({
  port: PORT,
  configDir,
  stdio: ["ignore", "ignore", "inherit"],
  env: { RURI_NO_MEMORY: "1", RURI_NO_HARNESS_UPDATES: "1" },
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
  for (const dir of [configDir, projectDir, outsideDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("TEAM FAIL: timed out");
  cleanup(1);
}, 2_400_000);
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
/** Chats whose transcript came whole with a compaction mark in it. */
const compacted = new Set<string>();
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects") projects = msg.projects;
  if (msg.type === "status") statuses[msg.projectId] = msg.status;
  if (msg.type === "event") (events[msg.projectId] ??= []).push(msg.event);
  if (msg.type === "team") team = msg.members;
  // a compaction comes as the chat's transcript, whole
  if (msg.type === "transcript" && msg.events.some((e) => e.kind === "compaction"))
    compacted.add(msg.projectId);
  for (const waiter of [...waiters]) waiter();
});

function until(what: string, done: () => boolean, ms: number): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!done()) return;
      clearTimeout(timer);
      clearInterval(poll);
      waiters.delete(look);
      resolve();
    };
    // some of what is waited on changes with no message to say so
    const poll = setInterval(look, 1000);
    const timer = setTimeout(() => {
      clearInterval(poll);
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve();
    }, ms);
    waiters.add(look);
  });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (id: string) => statuses[id] === "working" || statuses[id] === "permission";
const byPath = (dir: string) => () => projects.find((p) => p.path === fs.realpathSync(dir) || p.path === dir);
const ours = byPath(projectDir);
const outside = byPath(outsideDir);
const said = (id: string) =>
  (events[id] ?? [])
    .flatMap((e) => (e.kind === "assistant" ? [e.text] : []))
    .join("\n")
    .toLowerCase();
const prompts = (id: string) => (events[id] ?? []).filter((e) => e.kind === "user");
const results = (id: string) => (events[id] ?? []).filter((e) => e.kind === "result");
const members = (): SessionInfo[] => {
  const project = ours();
  const lead = project?.sessions.find((s) => s.lead)?.id;
  return project?.sessions.filter((s) => s.id !== lead && !s.liaison) ?? [];
};
const holding = (layer: string) => members().find((s) => s.layers?.includes(layer));

send({ type: "add_project", name: "orchard", path: projectDir });
send({ type: "add_project", name: "grove", path: outsideDir });
await until("the projects", () => Boolean(ours()?.sessions[0] && outside()?.sessions[0]), 30_000);
const project = ours();
const grove = outside();
if (!project || !grove) {
  console.error("TEAM FAIL: no projects", projects);
  cleanup(1);
}
const lead = project.sessions[0]!;
const groveLead = grove.sessions[0]!;
check(
  "a new project is one chat: its lead, and no liaison yet",
  project.sessions.length === 1 && lead.lead === true,
  project,
);
send({ type: "set_model", projectId: lead.id, model: "haiku" });
send({ type: "set_model", projectId: groveLead.id, model: "haiku" });
await settle(500);

const talkCall = async (chat: string, body: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/talk/${chat}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.status === 200
    ? ((await res.json()) as { ok: boolean; text: string; letter?: string; answered?: boolean })
    : null;
};
/** Wait on a letter's answer the way a harness's shell would: a slice at a
 *  time, until it is in. */
const waitFor = async (chat: string, letter: string, ms: number) => {
  const start = Date.now();
  for (;;) {
    const got = await talkCall(chat, { do: "wait", letter });
    if (!got || got.answered !== false || Date.now() - start > ms) return got;
  }
};

/* ── 0. the team over HTTP, no turns ─────────────────────────────────── */

const empty = await talkCall(lead.id, { do: "team" });
check(
  "the roster says there is no one yet, and which layers have no teammate",
  Boolean(
    empty?.text.includes("No teammates") &&
    empty.text.includes("Layers with no teammate yet") &&
    empty.text.includes("  notes — Orchard notes") &&
    empty.text.includes("  words — Word list"),
  ),
  empty,
);
check(
  "and nothing of the machine, and no liaison yet",
  Boolean(
    empty &&
    !/memory free|of the machine|slot/i.test(empty.text) &&
    empty.text.includes("The liaison: none yet"),
  ),
  empty,
);
const forNotes = await talkCall(lead.id, { do: "add", layer: "notes" });
check(
  "a teammate added for a layer takes its name from it, asleep until messaged",
  Boolean(forNotes?.text.includes("Added Orchard notes") && forNotes.text.includes("asleep until")),
  forNotes,
);
await until("the projects to say so", () => members().length === 1, 10_000);
check(
  "its duty is the layer's, and it holds the layer",
  holding("notes")?.duty === "The notes about the orchard's trees, in notes/" &&
    holding("notes")?.title === "Orchard notes",
  members(),
);
const twice = await talkCall(lead.id, { do: "add", layer: "notes" });
check("never two for one layer", Boolean(twice?.text.includes("holds notes already")), twice);
const afterOne = await talkCall(lead.id, { do: "team" });
check(
  "the roster has the layer taken, the other still free",
  Boolean(
    afterOne?.text.includes("  words — Word list") && !afterOne.text.includes("  notes — Orchard notes"),
  ),
  afterOne,
);
const clerkAdded = await talkCall(lead.id, { do: "add", name: "Clerk", duty: "keeps the project's notes" });
check("one by a name and a duty, too", Boolean(clerkAdded?.text.includes("Added Clerk")), clerkAdded);
await until("the projects to say so", () => members().length === 2, 10_000);
const clerk = members().find((s) => s.title === "Clerk");
const updated = await talkCall(lead.id, {
  do: "update",
  who: "clerk",
  duty: "keeps notes and the changelog",
});
check("found by name, its duty changes", Boolean(updated?.text.includes("Updated Clerk")), updated);
const rogue = clerk ? await talkCall(clerk.id, { do: "add", name: "Rogue", duty: "x" }) : null;
check("a teammate has no team to run", Boolean(rogue?.text.includes("Only a project's lead")), rogue);
const stopAsleep = await talkCall(lead.id, { do: "manage", who: "Clerk", action: "stop" });
check("stop, asleep: nothing to stop", Boolean(stopAsleep?.text.includes("nothing to stop")), stopAsleep);
const restartAsleep = await talkCall(lead.id, { do: "manage", who: "Clerk", action: "restart" });
check(
  "restart, asleep: nothing was at work, the conversation kept",
  Boolean(restartAsleep?.text.includes("it wasn't at work")),
  restartAsleep,
);
const refreshAsleep = await talkCall(lead.id, { do: "manage", who: "Clerk", action: "refresh" });
await until(
  "the fresh Clerk",
  () => Boolean(members().find((s) => s.title === "Clerk" && s.id !== clerk?.id)),
  10_000,
);
check(
  "refresh, asleep: a fresh Clerk in its place, the same duty",
  Boolean(refreshAsleep?.text.includes("Refreshed Clerk")) &&
    members().find((s) => s.title === "Clerk")?.duty === "keeps notes and the changelog" &&
    !members().some((s) => s.id === clerk?.id),
  { refreshAsleep, members: members() },
);
for (const who of ["Clerk", "notes"]) {
  const retired = await talkCall(lead.id, { do: "retire", who });
  check(`${who} retired`, Boolean(retired?.text.includes("Retired")), retired);
}
await until("only the lead", () => ours()?.sessions.length === 1, 10_000);
check("and only the lead is left", ours()?.sessions.length === 1, ours());
const fromGrove = await talkCall(groveLead.id, { do: "list" });
check(
  "grove sees orchard through its liaison, made when it first writes",
  Boolean(fromGrove?.text.includes("its liaison") && fromGrove.text.includes("made when you first write")),
  fromGrove,
);
if (process.env["TEAM_HTTP_ONLY"]) {
  console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
  cleanup(failed === 0 ? 0 : 1);
}

/* ── 1. an ordinary request to a lead with an empty team ──────────── */

send({
  type: "send",
  projectId: lead.id,
  text: "What's the secret word in this project? Just tell me the word.",
});
await until("the lead to start", () => busy(lead.id), 90_000);
await until("a teammate for the words layer", () => Boolean(holding("words")), 300_000);
const words = holding("words");
check("the lead adds the words layer's teammate, untold", Boolean(words), ours());
if (!words) cleanup(1);
await until("its job", () => prompts(words.id).length > 0, 120_000);
const job = prompts(words.id)[0];
check(
  "and hands it the job, marked as the lead's, answered later",
  job?.kind === "user" && job.from?.agent === lead.id && job.from.reply === "later",
  job,
);
await until("the lead's first turn to end", () => results(lead.id).length > 0, 240_000);
const firstEnd = results(lead.id)[0]?.ts ?? 0;
await until("the teammate's answer", () => results(words.id).length > 0, 300_000);
check(
  "the lead's turn ended while the teammate worked: it stays free",
  firstEnd > 0 && firstEnd <= (results(words.id)[0]?.ts ?? 0),
  { lead: results(lead.id), words: results(words.id) },
);
await until("the lead to relay the word", () => said(lead.id).includes(WORD) && !busy(lead.id), 300_000);
check("the answer lands, and the lead relays it", said(lead.id).includes(WORD), said(lead.id));
check(
  "the lead never read the file itself",
  // a Read, a shell or a search of the file — not the job handed over
  !(events[lead.id] ?? []).some(
    (e) => e.kind === "tool" && /^(Read|Bash|Grep|Glob)$/.test(e.name) && /secret\.txt/i.test(e.summary),
  ),
  (events[lead.id] ?? []).filter((e) => e.kind === "tool"),
);
await settle(6000);
send({ type: "team_get", projectId: project.id });
await until("the team", () => team.some((m) => m.id === words.id), 10_000);
check(
  "and the teammate is asleep again — no process, its conversation kept",
  team.find((m) => m.id === words.id)?.state === "asleep",
  team,
);

/* ── 2. another project's agent writes in: the liaison ───────────── */

const leadPrompts = prompts(lead.id).length;
const asked = await talkCall(groveLead.id, {
  do: "project",
  project: "orchard",
  message: `I'm grove's lead. What does orchard's notes say the orchard's first tree is? Reply with just the tree's name.`,
  reply: "wait",
});
check(
  "grove's question is handed to orchard's liaison",
  Boolean(asked?.text.includes("orchard's liaison")),
  asked,
);
const liaison = ours()?.sessions.find((s) => s.liaison);
check(
  "orchard has a liaison now — not a member, not its lead",
  Boolean(liaison && !liaison.lead && liaison.title === "Liaison"),
  ours(),
);
const answer =
  asked?.answered === false && asked.letter ? await waitFor(groveLead.id, asked.letter, 480_000) : asked;
check("and the answer comes back to grove", Boolean(answer?.text.toLowerCase().includes(TREE)), answer);
check("the lead never heard of it", prompts(lead.id).length === leadPrompts, prompts(lead.id));
const handedBy = members().find((m) =>
  prompts(m.id).some((e) => e.kind === "user" && e.from?.agent === liaison?.id),
);
check("the liaison delegated it to a teammate", Boolean(handedBy), {
  members: members(),
  liaison: liaison && events[liaison.id],
});
check(
  "it read nothing itself",
  !(
    liaison && (events[liaison.id] ?? []).some((e) => e.kind === "tool" && /readme|notes\//i.test(e.summary))
  ),
  liaison && (events[liaison.id] ?? []).filter((e) => e.kind === "tool"),
);
const roster = await talkCall(lead.id, { do: "team" });
check(
  "the lead's roster shows the liaison",
  Boolean(roster?.text.includes("The liaison — other projects")),
  roster,
);

/* ── 3. the lead's hand on a teammate, mid-turn and asleep ────────── */

let worker = words.id;
const SLOW =
  "Run exactly this with your Bash tool, and nothing else: for i in $(seq 1 25); do sleep 1; done — then reply with just the word done.";
const slow = async () => {
  const since = (events[worker] ?? []).length;
  const sent = await talkCall(lead.id, { do: "send", to: "words", message: SLOW, reply: "none" });
  // the loop of this job running — not one from a turn before it
  await until(
    "the loop",
    () =>
      busy(worker) &&
      (events[worker] ?? []).slice(since).some((e) => e.kind === "tool" && /seq 1 25/.test(e.summary)),
    120_000,
  );
  const ran = (events[worker] ?? []).slice(since);
  if (!ran.some((e) => e.kind === "tool" && /seq 1 25/.test(e.summary)))
    console.log(
      "    (the loop never ran; it said:",
      JSON.stringify(ran.flatMap((e) => (e.kind === "assistant" ? [e.text] : []))).slice(0, 600),
      ")",
    );
  return sent;
};
const quiet = async (what: string) => {
  await until(what, () => !busy(worker), 240_000);
  await settle(2000);
};

// queue: behind the work, and stop lets it go on
await slow();
const queued = await talkCall(lead.id, {
  do: "send",
  to: "words",
  message: "Reply with just the word pear.",
  reply: "none",
  delivery: "queue",
});
check(
  "queue, mid-turn: it waits behind the work",
  Boolean(queued?.text.includes("queued behind what it is doing, as you asked")),
  queued,
);
await settle(3000);
check("and the work goes on", busy(worker) && !said(worker).includes("pear"));
const stopped = await talkCall(lead.id, { do: "manage", who: "words", action: "stop" });
check(
  "stop, mid-turn: the turn is stopped",
  Boolean(stopped?.text.includes("Stopped Word list's turn")),
  stopped,
);
await until("the queued one to go on", () => said(worker).includes("pear"), 180_000);
check("and the message queued behind it goes on", said(worker).includes("pear"), events[worker]);
await quiet("the pear turn to end");

// interrupt: read now, then back to the work
await slow();
const cut = await talkCall(lead.id, {
  do: "send",
  to: "words",
  message: "Reply with just the word plum.",
  reply: "none",
});
check(
  "interrupt, mid-turn: it stops to read it",
  Boolean(cut?.text.includes("stopped what it was doing to read it")),
  cut,
);
await until("plum", () => said(worker).includes("plum"), 180_000);
check(
  "it reads it at once, marked as a cut-in",
  prompts(worker).some((e) => e.kind === "user" && e.from?.cutIn === true && e.text.includes("plum")),
  prompts(worker),
);
await until(
  "the way back",
  () => prompts(worker).some((e) => e.kind === "user" && e.text.startsWith("↩ Back to what")),
  60_000,
);
check(
  "and is sent back to its work",
  prompts(worker).some((e) => e.kind === "user" && e.text.startsWith("↩ Back to what")),
);
await quiet("the work it went back to");

// restart: the process closes mid-turn
await slow();
const restarted = await talkCall(lead.id, { do: "manage", who: "words", action: "restart" });
check(
  "restart, mid-turn: the turn is stopped and the process closed",
  Boolean(restarted?.text.includes("the turn it was on is stopped")),
  restarted,
);
await until("it to stop", () => !busy(worker), 30_000);
send({ type: "team_get", projectId: project.id });
await settle(1500);
check("and it is asleep, its conversation kept", team.find((m) => m.id === worker)?.state === "asleep", team);

// compact: as its turn ends
await slow();
const compacting = await talkCall(lead.id, { do: "manage", who: "words", action: "compact" });
check(
  "compact, mid-turn: it waits for the turn to end",
  Boolean(compacting?.text.includes("compacts the moment its turn ends")),
  compacting,
);
await until("the compaction", () => compacted.has(worker), 180_000);
check("and compacts once it has", compacted.has(worker), events[worker]);
await quiet("the compaction to settle");

// refresh: a fresh one for the same layer
await slow();
const before = worker;
const refreshed = await talkCall(lead.id, { do: "manage", who: "words", action: "refresh" });
check(
  "refresh, mid-turn: a fresh session in its place",
  Boolean(
    refreshed?.text.includes("Refreshed Word list") && refreshed.text.includes("The turn it was on is lost"),
  ),
  refreshed,
);
await until("the fresh one", () => Boolean(holding("words") && holding("words")!.id !== before), 10_000);
worker = holding("words")?.id ?? "";
check(
  "for the same layer, name and duty; the old one gone",
  Boolean(worker && worker !== before && !members().some((s) => s.id === before)),
  members(),
);
await until("the old one to stop", () => !busy(before), 30_000);

// asleep: a queued message goes at once; compact; retire
const note = await talkCall(lead.id, {
  do: "send",
  to: "words",
  message: "Reply with just the word fig.",
  reply: "none",
  delivery: "queue",
});
check(
  "queue, asleep: it goes at once",
  Boolean(note?.text.startsWith("Sent to") && !note.text.includes("queued behind")),
  note,
);
await until("fig", () => said(worker).includes("fig"), 180_000);
await quiet("the fig turn");
check("and is answered", said(worker).includes("fig"), events[worker]);
const compactAsleep = await talkCall(lead.id, { do: "manage", who: "words", action: "compact" });
await until("the compaction", () => compacted.has(worker), 10_000);
check(
  "compact, asleep: at once",
  Boolean(compactAsleep?.text.includes("Compacted Word list")) && compacted.has(worker),
  compactAsleep,
);
const retired = await talkCall(lead.id, { do: "retire", who: "words" });
check("retire: off the team", Boolean(retired?.text.includes("Retired Word list")), retired);
await settle(1000);
check("and gone", !members().some((s) => s.id === worker), members());

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
