/**
 * An agent compacts itself, the way Codex does (server/selfCompaction.ts).
 *
 * Real turns (haiku), on a temp project, with the compaction point set
 * just above what a first small turn holds — so a job that reads four big
 * files crosses it in the middle:
 *   1. the lead, on the user's prompt: told mid-turn it is past its point,
 *      it writes its handoff note and calls mcp__ruri__compact; ruri
 *      compacts it when the turn ends, and the fresh session — sent the
 *      note, with no word from the user — finishes the job, every file's
 *      codeword in its answer and in the file it was keeping;
 *   2. a teammate, on a message from the lead that waits for its answer:
 *      the same, and the answer the lead gets is the last words of the
 *      turn that finished the job — not the turn that compacted.
 *
 *   3. with AGENT_COMPACT_CODEX=<model>, a Codex teammate: it hears its
 *      point only with a prompt (no mid-turn line there) and compacts over
 *      the talk endpoint ({"do": "compact"}) — the fresh session finishes
 *      the job. AGENT_COMPACT_SKIP_CLAUDE=1 runs just that.
 *
 * Costs a few real Haiku turns — run manually: bun run agent-compact-test
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ClientMessage, Project, ServerMessage, TranscriptEvent } from "../shared/protocol.js";
import { bootServer, connect } from "./lib/server.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7894);
const MODEL = process.env["AGENT_COMPACT_MODEL"] ?? "haiku";
/** How far above a first turn's context the compaction point is set. */
const HEADROOM = Number(process.env["AGENT_COMPACT_HEADROOM"] ?? 36_000);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-agentcompact-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-agentcompact-project-"));

const WORDS = [
  ["AMBER-FALCON", "COBALT-OTTER", "SAFFRON-HERON", "UMBER-LYNX"],
  ["JADE-MARMOT", "RUSSET-CRANE", "IVORY-BADGER", "TEAL-OSPREY"],
  ["COPPER-WREN", "SLATE-IBEX", "ONYX-TAPIR", "MAUVE-EGRET"],
];
/** A file of about ten thousand tokens of ledger lines, its codeword at the
 *  very end — read whole, it climbs the context; skimmed, it says nothing. */
function writePart(dir: string, n: number, word: string): void {
  const lines: string[] = [];
  for (let i = 1; i <= 620; i++) {
    lines.push(
      `Line ${String(i).padStart(4, "0")}: ledger entry ${n}-${i} for account ${1000 + ((i * 37) % 900)} balances at ${((i * 7919) % 10000) / 100} credits.`,
    );
  }
  lines.push(`CODEWORD ${n}: ${word}`);
  fs.writeFileSync(path.join(dir, `part${n}.txt`), `${lines.join("\n")}\n`);
}
fs.mkdirSync(path.join(projectDir, "lead"));
fs.mkdirSync(path.join(projectDir, "team"));
fs.mkdirSync(path.join(projectDir, "relay"));
WORDS[0]!.forEach((word, i) => writePart(path.join(projectDir, "lead"), i + 1, word));
WORDS[1]!.forEach((word, i) => writePart(path.join(projectDir, "team"), i + 1, word));
WORDS[2]!.forEach((word, i) => writePart(path.join(projectDir, "relay"), i + 1, word));
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: projectDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
git("init", "-q", "-b", "master");
git("add", "-A");
git("commit", "-q", "-m", "the parts");

const job = (dir: string, out: string, reader = "your Read tool (not grep, tail or Bash — the whole file)") =>
  `In ${dir}/ there are four files, part1.txt to part4.txt, each ending with a line "CODEWORD n: <word>". ` +
  `Work through them strictly one at a time, in order: read the whole file with ${reader}, ` +
  `then append its codeword as a line to ${out} with your shell (echo … >> ${out}), and only then go on to the next. ` +
  `Don't read two files in one step. When all four are done, reply with the four codewords in order, one per line.`;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 2000));
  }
}

const server = bootServer({
  port: PORT,
  configDir,
  stdio: ["ignore", "ignore", "inherit"],
  env: { RURI_NO_MEMORY: "1", RURI_NO_HARNESS_UPDATES: "1" },
});
function cleanup(code: number): never {
  server.kill("SIGINT");
  for (const dir of [configDir, projectDir]) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("AGENT-COMPACT FAIL: timed out");
  cleanup(1);
}, 1_500_000).unref();

let projects: Project[] = [];
const statuses: Record<string, string> = {};
const events: Record<string, TranscriptEvent[]> = {};
const contexts: Record<string, { tokens: number; window: number }> = {};
/** Each chat's compaction marks, as the transcripts pushed after them show
 *  them, and the context readings it went through. */
const marks: Record<string, Set<string>> = {};
const readings: Record<string, number[]> = {};
const waiters = new Set<() => void>();
const ws = await connect(PORT, 60_000);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects") projects = msg.projects;
  if (msg.type === "status") statuses[msg.projectId] = msg.status;
  if (msg.type === "event") (events[msg.projectId] ??= []).push(msg.event);
  if (msg.type === "context") {
    contexts[msg.projectId] = msg.context;
    (readings[msg.projectId] ??= []).push(msg.context.tokens);
  }
  if (msg.type === "transcript")
    for (const e of msg.events) if (e.kind === "compaction") (marks[msg.projectId] ??= new Set()).add(e.id);
  for (const waiter of [...waiters]) waiter();
});
function until(what: string, done: () => boolean, ms: number): Promise<boolean> {
  if (done()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const look = () => {
      if (!done()) return;
      clearTimeout(timer);
      waiters.delete(look);
      resolve(true);
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve(false);
    }, ms);
    waiters.add(look);
  });
}
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ours = () => projects.find((p) => p.path === fs.realpathSync(projectDir) || p.path === projectDir);
const results = (id: string) => (events[id] ?? []).filter((e) => e.kind === "result").length;
const lastSaid = (id: string) => (events[id] ?? []).findLast((e) => e.kind === "assistant")?.text ?? "";
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
/** What a chat's self-compactions left in its transcript. */
function compaction(id: string) {
  const all = events[id] ?? [];
  const called = all.filter((e) => e.kind === "tool" && e.name === "mcp__ruri__compact");
  const info = all.filter((e) => e.kind === "info" && e.text.includes("compacted itself"));
  const carry = all.filter((e) => e.kind === "user" && e.text.startsWith("↻ You compacted yourself"));
  // every prompt after the job's own is ruri's, carrying on
  const job = all.findIndex((e) => e.kind === "user" && e.text.startsWith("In "));
  const after = all.slice(job + 1).filter((e) => e.kind === "user");
  const unprompted = job >= 0 && after.every((e) => e.kind === "user" && e.text.startsWith("↻ "));
  // the context fell back with each compaction
  const fell = (readings[id] ?? []).filter((t, i, seen) => i > 0 && t < seen[i - 1]! - 5_000).length;
  return { called, info, marks: marks[id]?.size ?? 0, carry, unprompted, fell };
}
const finished = (id: string, words: string[]) =>
  statuses[id] === "idle" && words.every((w) => lastSaid(id).includes(w));

send({ type: "add_project", name: "ledgers", path: projectDir });
await until("the project", () => Boolean(ours()?.sessions[0]), 30_000);
const lead = ours()?.sessions[0];
if (!lead) cleanup(1);
send({ type: "set_model", projectId: lead.id, model: MODEL });
send({ type: "view", channels: [lead.id], live: true });
await settle(800);

/* ── 0. how much a first small turn holds, and the point above it ──── */

send({ type: "send", projectId: lead.id, text: "Reply with just the word ready. No tools." });
await until("the first turn", () => results(lead.id) >= 1, 240_000);
await settle(500);
const base = contexts[lead.id]?.tokens ?? 0;
check("a first turn measures the context", base > 0, contexts[lead.id]);
const point = base + HEADROOM;
send({ type: "set_pref", key: "ruri-self-compact-at", value: String(point) });
await settle(500);
const told = await talkCall(lead.id, { do: "context" });
check(
  "the context check tells the lead its tokens and its compaction point",
  Boolean(told?.text.includes("of 1M tokens used") && told.text.includes("You compact yourself at")),
  told,
);
console.log(`    context ${base} after a first turn; compaction point set at ${point}`);

if (!process.env["AGENT_COMPACT_SKIP_CLAUDE"]) {
  /* ── 1. the lead, on the user's prompt ───────────────────────────────── */

  const leadTurns = results(lead.id);
  send({ type: "send", projectId: lead.id, text: job("lead", "lead/answers.txt") });
  await until(
    "the lead to finish the job",
    () => results(lead.id) > leadTurns && finished(lead.id, WORDS[0]!),
    1_200_000,
  );
  await settle(1500);
  const one = compaction(lead.id);
  console.log(
    `    the lead compacted itself ${one.info.length} time(s); its context went ${(readings[lead.id] ?? []).map((t) => Math.round(t / 1000)).join(" → ")}k`,
  );
  check(
    "the lead called compact with its note",
    one.called.length > 0,
    (events[lead.id] ?? []).flatMap((e) => (e.kind === "tool" ? [e.name] : [])),
  );
  check(
    "ruri compacted it each time, says so in the transcript, and the context fell back",
    one.info.length === one.called.length && one.marks >= one.info.length && one.fell >= one.info.length,
    { info: one.info.length, marks: one.marks, fell: one.fell },
  );
  check(
    "each fresh session was sent the lead's note, with no word from the user",
    one.carry.length === one.info.length &&
      one.carry.every((e) => e.kind === "user" && e.text.includes("<handoff-note>")) &&
      one.unprompted,
    one.carry,
  );
  const leadFile = fs.existsSync(path.join(projectDir, "lead", "answers.txt"))
    ? fs.readFileSync(path.join(projectDir, "lead", "answers.txt"), "utf8")
    : "";
  check(
    "the job was finished: every codeword in the file, none twice",
    WORDS[0]!.every((w) => leadFile.split(w).length === 2),
    leadFile,
  );
  check(
    "and in the lead's last answer",
    WORDS[0]!.every((w) => lastSaid(lead.id).includes(w)),
    lastSaid(lead.id),
  );
  const firstNote = one.carry[0];
  if (firstNote?.kind === "user")
    console.log(
      `    the first note:\n${firstNote.text
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n")}`,
    );

  /* ── 2. a teammate, on a message from the lead that waits ────────────── */

  const added = await talkCall(lead.id, {
    do: "add",
    name: "Clerk",
    duty: "keeps the ledgers in team/",
    model: MODEL,
  });
  check("a teammate is added", Boolean(added?.text.includes("Added Clerk")), added);
  await until("the teammate", () => Boolean(ours()?.sessions.find((s) => s.title === "Clerk")), 10_000);
  const clerk = ours()?.sessions.find((s) => s.title === "Clerk");
  if (!clerk) cleanup(1);
  send({ type: "view", channels: [lead.id, clerk.id], live: true });
  await settle(500);
  // a first small job, to measure the teammate before its point is set
  const first = await talkCall(lead.id, {
    do: "send",
    to: "Clerk",
    message: "Reply with just the word ready. No tools.",
    reply: "wait",
  });
  let reply = first;
  while (reply && !reply.answered && reply.letter)
    reply = await talkCall(lead.id, { do: "wait", letter: reply.letter });
  check(
    "the teammate answers a first small message",
    Boolean(reply?.text.toLowerCase().includes("ready")),
    reply,
  );
  const clerkBase = contexts[clerk.id]?.tokens ?? base;
  const clerkPoint = Math.max(point, clerkBase + HEADROOM);
  send({ type: "set_pref", key: "ruri-self-compact-at", value: String(clerkPoint) });
  await settle(500);
  console.log(`    teammate's context ${clerkBase}; compaction point set at ${clerkPoint}`);
  reply = await talkCall(lead.id, {
    do: "send",
    to: "Clerk",
    message: job("team", "team/answers.txt"),
    reply: "wait",
  });
  const clerkStart = Date.now();
  while (reply && !reply.answered && reply.letter && Date.now() - clerkStart < 900_000)
    reply = await talkCall(lead.id, { do: "wait", letter: reply.letter });
  await settle(1000);
  const two = compaction(clerk.id);
  console.log(`    the teammate compacted itself ${two.info.length} time(s)`);
  check(
    "the teammate called compact with its note",
    two.called.length > 0,
    (events[clerk.id] ?? []).flatMap((e) => (e.kind === "tool" ? [e.name] : [])),
  );
  check(
    "and was compacted each time, its note carried into the fresh session",
    two.info.length === two.called.length &&
      two.carry.length === two.info.length &&
      two.marks >= two.info.length,
    { info: two.info.length, carry: two.carry.length, marks: two.marks },
  );
  check(
    "the letter's answer is the last words of the turn that finished the job — every codeword",
    Boolean(reply?.answered) && WORDS[1]!.every((w) => reply!.text.includes(w)),
    reply,
  );
  const teamFile = fs.existsSync(path.join(projectDir, "team", "answers.txt"))
    ? fs.readFileSync(path.join(projectDir, "team", "answers.txt"), "utf8")
    : "";
  check(
    "and every codeword is in the teammate's file",
    WORDS[1]!.every((w) => teamFile.includes(w)),
    teamFile,
  );
}

/* ── 3. a Codex teammate, over HTTP (AGENT_COMPACT_CODEX=<model>) ─────── */

const CODEX = process.env["AGENT_COMPACT_CODEX"];
if (CODEX) {
  send({ type: "set_pref", key: "ruri-self-compact-at", value: "off" });
  await settle(300);
  const hired = await talkCall(lead.id, {
    do: "add",
    name: "Courier",
    duty: "keeps the ledgers in relay/",
    model: CODEX,
  });
  check("a Codex teammate is added", Boolean(hired?.text.includes("Added Courier")), hired);
  await until("Courier", () => Boolean(ours()?.sessions.find((s) => s.title === "Courier")), 10_000);
  const courier = ours()?.sessions.find((s) => s.title === "Courier");
  if (!courier) cleanup(1);
  send({ type: "view", channels: [lead.id, courier.id], live: true });
  await settle(500);
  let r = await talkCall(lead.id, {
    do: "send",
    to: "Courier",
    message: "Reply with just the word ready. Run nothing.",
    reply: "wait",
  });
  while (r && !r.answered && r.letter) r = await talkCall(lead.id, { do: "wait", letter: r.letter });
  const courierBase = contexts[courier.id]?.tokens ?? 0;
  check(
    "Courier answers a first message, and its context is measured",
    Boolean(r?.answered) && courierBase > 0,
    {
      r,
      context: contexts[courier.id],
    },
  );
  // its point just under what it holds: the next prompt's line tells it to
  // compact, and Codex hears it only there — it has no mid-turn line
  send({
    type: "set_pref",
    key: "ruri-self-compact-at",
    value: String(Math.max(1000, courierBase - 2000)),
  });
  await settle(500);
  console.log(`    Courier's context ${courierBase}; compaction point set just under it`);
  r = await talkCall(lead.id, {
    do: "send",
    to: "Courier",
    reply: "wait",
    message: job("relay", "relay/answers.txt", "cat, the whole file"),
  });
  const t0 = Date.now();
  while (r && !r.answered && r.letter && Date.now() - t0 < 1_200_000)
    r = await talkCall(lead.id, { do: "wait", letter: r.letter });
  await settle(1000);
  const three = compaction(courier.id);
  console.log(`    Courier compacted itself ${three.info.length} time(s)`);
  check(
    "Courier compacted itself over HTTP, from a note of its own",
    three.info.length > 0 &&
      three.carry.length === three.info.length &&
      three.carry.every((e) => e.kind === "user" && e.text.includes("<handoff-note>")),
    {
      info: three.info.length,
      carry: three.carry,
      tools: (events[courier.id] ?? []).flatMap((e) =>
        e.kind === "tool" ? [`${e.name}: ${e.summary.slice(0, 160)}`] : [],
      ),
    },
  );
  const relayFile = path.join(projectDir, "relay", "answers.txt");
  const relayed = fs.existsSync(relayFile) ? fs.readFileSync(relayFile, "utf8") : "";
  check(
    "the job was finished: every codeword in the file, none twice",
    WORDS[2]!.every((w) => relayed.split(w).length === 2),
    relayed,
  );
  check(
    "and the lead's answer is the finished job",
    Boolean(r?.answered) && WORDS[2]!.every((w) => r!.text.includes(w)),
    r,
  );
}

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
