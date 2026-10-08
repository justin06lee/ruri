/**
 * Claude Code compacts a conversation on its own, and ruri notices.
 *
 * Its auto-compact used to pass unseen: the chat went on believing the
 * session held what it had read (so it could edit sheets it no longer had
 * word for word) and whatever ruri had put in its prompts went into the
 * summary or nowhere. Now the session's SessionStart hook (source
 * "compact") hands it ruri's context back, the compact_boundary says so in
 * the transcript, and the reads are forgotten.
 *
 * Against the real CLI on Haiku: two turns to measure the context, then a
 * restart with CLAUDE_AUTOCOMPACT_PCT_OVERRIDE set just under it so the next
 * turn compacts, then a question only ruri's re-injection can answer (the
 * branch the scratch repo is on, which nothing in the conversation says).
 *   bun run self-compact-test
 */
import { execFileSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";
import { bootServer, connect } from "./lib/server.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7891);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-selfcompact-config-"));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-selfcompact-"));
const CHAT = "c-self-compact";
const BRANCH = "feat/periwinkle-ledger";

const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
git("init", "-q", "-b", BRANCH);
fs.writeFileSync(path.join(dir, "README.md"), "# scratch\n");
git("add", "-A");
git("commit", "-q", "-m", "first");
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      { id: "p-self", name: "selfcompact", path: dir, sessions: [{ id: CHAT, title: "S", model: "haiku" }] },
    ],
  }),
);

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 800));
  }
}

let server: ChildProcess | undefined;
let ws: WebSocket | undefined;
const events: TranscriptEvent[] = [];
let context: { tokens: number; window: number } | undefined;
const waiters = new Set<() => void>();

async function boot(env: Record<string, string> = {}): Promise<void> {
  server = bootServer({
    port: PORT,
    configDir,
    env: { RURI_NO_MEMORY: "1", ...env },
    stdio: ["ignore", "ignore", "inherit"],
  });
  ws = await connect(PORT, 60_000);
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw)) as ServerMessage;
    if (msg.type === "event" && msg.projectId === CHAT) events.push(msg.event);
    if (msg.type === "context" && msg.projectId === CHAT) context = msg.context;
    for (const waiter of [...waiters]) waiter();
  });
  send({ type: "view", channels: [CHAT], live: true });
  await new Promise((r) => setTimeout(r, 1500));
}
async function stop(): Promise<void> {
  if (!server) return;
  ws?.close();
  const exited = new Promise((resolve) => server!.once("exit", resolve));
  server.kill("SIGINT");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 8_000))]);
  server = undefined;
}
const send = (msg: ClientMessage) => ws!.send(JSON.stringify(msg));
function until(ok: () => boolean, ms: number): Promise<boolean> {
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
      resolve(false);
    }, ms);
    waiters.add(look);
  });
}
const results = () => events.filter((e) => e.kind === "result");
async function turn(text: string): Promise<string> {
  const before = results().length;
  const from = events.length;
  send({ type: "send", projectId: CHAT, text });
  await until(() => results().length > before, 240_000);
  return events
    .slice(from)
    .flatMap((e) => (e.kind === "assistant" ? [e.text] : []))
    .join("\n");
}
async function cleanup(code: number): Promise<never> {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("SELF-COMPACT FAIL: timed out");
  void cleanup(1);
}, 900_000).unref();

await boot();
await turn("Remember this codeword for later: PERIWINKLE-42. Reply with just OK, no tools.");
await turn(
  "Without using any tools, write about 900 words on the history of double-entry bookkeeping, then end with the word DONE.",
);
check("two turns ran and the context was measured", !!context && context.tokens > 0, context);
const tokens = context?.tokens ?? 0;
const window = context?.window ?? 200_000;
await stop();

// compaction just under what the context holds now: the next turn compacts
const pct = Math.max(1, Math.floor(((tokens - 1500) / window) * 100));
console.log(`    context ${tokens} of ${window}; auto-compact at ${pct}%`);
await boot({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(pct) });
const from = events.length;
const answer = await turn(
  "Look at the context ruri handed you after the compaction, in <ruri:after-compaction>. Which git branch does its <state> say the repo is on? Reply with just the branch name, no tools.",
);
const said = events
  .slice(from)
  .flatMap((e) => (e.kind === "info" ? [e.text] : []))
  .join("\n");
check(
  "the transcript says Claude compacted on its own",
  /Claude compacted this conversation on its own/.test(said),
  said,
);
check("ruri's re-injection reached the session: it names the branch", answer.includes(BRANCH), answer);
const codeword = await turn(
  "What was the codeword I gave you at the start? Reply with just the codeword, no tools.",
);
check("and the conversation carried on", /PERIWINKLE-42/.test(codeword), codeword);

console.log(failed === 0 ? "all good" : `${failed} failed`);
await cleanup(failed === 0 ? 0 : 1);
