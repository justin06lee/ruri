/**
 * A chat whose Claude session is gone answers anyway.
 *
 * "No conversation found with session ID" used to end the turn — and every
 * turn after it, since each failed start could leave the chat on yet
 * another session that was never written. Two ways in, each against the
 * real CLI:
 *
 * A. The chat's session id has no transcript, and the check before the
 *    prompt can't tell (Claude has never run in the project's folder). The
 *    start fails; its prompt goes again to a fresh session briefed on the
 *    conversation, and the chat never shows the error.
 * B. The chat's process dies holding its session id, and the transcript
 *    goes. The check before the next prompt lets the session go — and the
 *    dead process with it, whose id the next build used to resume again.
 *
 * Three short Haiku turns — run manually: bun run lost-session-test
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7885);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-lost-config-"));
const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-lost-a-"));
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-lost-b-"));
const CHAT_A = "c-lost-a";
const CHAT_B = "c-lost-b";
/** The id a real chat failed on: nothing by it exists anywhere. */
const GONE_ID = "28c0b0cb-8759-4a25-8af9-49c6913d5415";
const claudeProjects = path.join(
  process.env["CLAUDE_CONFIG_DIR"] ?? path.join(os.homedir(), ".claude"),
  "projects",
);

const ts = Date.now() - 60_000;
const history: TranscriptEvent[] = [
  { kind: "user", id: "u-code", text: "Remember this codeword for later: PERIWINKLE-42", ts },
  { kind: "assistant", id: "a-code", text: "Got it — the codeword is PERIWINKLE-42.", ts: ts + 1 },
  { kind: "result", id: "r-code", ok: true, ts: ts + 2 },
];
fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      { id: "p-lost-a", name: "lost-a", path: dirA, sessions: [{ id: CHAT_A, title: "A", model: "haiku" }] },
      { id: "p-lost-b", name: "lost-b", path: dirB, sessions: [{ id: CHAT_B, title: "B", model: "haiku" }] },
    ],
  }),
);
fs.writeFileSync(
  path.join(configDir, "sessions", `${CHAT_A}.json`),
  JSON.stringify({ events: history, summaries: {}, lastSessionId: GONE_ID, sessionIds: [GONE_ID] }),
);

const server = bootServer({
  port: PORT,
  configDir,
  env: { RURI_NO_MEMORY: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail).slice(0, 600));
  }
}
/** Claude's transcripts for the scratch projects go with them. */
function claudeDirsOf(dir: string): string[] {
  const tail = path.basename(dir);
  try {
    return fs
      .readdirSync(claudeProjects)
      .filter((name) => name.endsWith(tail))
      .map((name) => path.join(claudeProjects, name));
  } catch {
    return [];
  }
}
/** The server first, and the CLIs it closes on its way out — one still
 *  shutting down writes a last line into a transcript folder removed under it. */
async function cleanup(code: number): Promise<never> {
  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGINT");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
  await new Promise((r) => setTimeout(r, 1_000));
  for (const dir of [dirA, dirB]) {
    for (const claudeDir of claudeDirsOf(dir)) fs.rmSync(claudeDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("LOST-SESSION FAIL: timed out");
  void cleanup(1);
}, 300_000).unref();

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
        console.error("LOST-SESSION FAIL: could not connect");
        await cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Everything a chat was sent, in order — events and statuses alike. */
const seen = new Map<string, Array<{ event?: TranscriptEvent; status?: string }>>();
const waiters = new Set<() => void>();
const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "event") {
    const list = seen.get(msg.projectId) ?? [];
    list.push({ event: msg.event });
    seen.set(msg.projectId, list);
  }
  if (msg.type === "status") {
    const list = seen.get(msg.projectId) ?? [];
    list.push({ status: msg.status });
    seen.set(msg.projectId, list);
  }
  for (const waiter of [...waiters]) waiter();
});
function until(what: string, ok: () => boolean, ms: number): Promise<boolean> {
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
      console.log(`    (gave up waiting for ${what})`);
      resolve(false);
    }, ms);
    waiters.add(look);
  });
}
const events = (chat: string, from = 0) =>
  (seen.get(chat) ?? []).slice(from).flatMap((item) => (item.event ? [item.event] : []));
const results = (chat: string, from = 0) =>
  events(chat, from).filter((e): e is Extract<TranscriptEvent, { kind: "result" }> => e.kind === "result");
const said = (chat: string, from = 0) =>
  events(chat, from)
    .flatMap((e) => (e.kind === "assistant" || e.kind === "info" ? [e.text] : []))
    .join("\n");
const archived = (chat: string) =>
  JSON.parse(fs.readFileSync(path.join(configDir, "sessions", `${chat}.json`), "utf8")) as {
    lastSessionId?: string;
  };
const transcriptOf = (dir: string, id: string | undefined) =>
  id ? claudeDirsOf(dir).some((claudeDir) => fs.existsSync(path.join(claudeDir, `${id}.jsonl`))) : false;

// the socket is up when the server has loaded the seeded chats
send({ type: "view", channels: [CHAT_A, CHAT_B], live: true });
await new Promise((r) => setTimeout(r, 1500));

/* ── A. a session that isn't there, past a check that can't tell ───── */

check("A: Claude has never run in the folder, so the check can't tell", claudeDirsOf(dirA).length === 0);
send({
  type: "send",
  projectId: CHAT_A,
  text: "What was the codeword I gave you earlier? Reply with just the codeword, no tools.",
});
await until("A's answer", () => results(CHAT_A).length > 0, 120_000);
const [resultA] = results(CHAT_A);
const itemsA = seen.get(CHAT_A) ?? [];
const resultAt = itemsA.findIndex((item) => item.event?.kind === "result");
check("A: the turn ends well", resultA?.ok === true, resultA);
check("A: the chat never shows the lost session", !/No conversation found/.test(said(CHAT_A)), said(CHAT_A));
check("A: it says it started fresh", /is gone, so this prompt starts a fresh one/.test(said(CHAT_A)));
check("A: and the brief carried the conversation over", /PERIWINKLE-42/.test(said(CHAT_A)), said(CHAT_A));
check(
  "A: the chat never went idle before its answer",
  !itemsA.slice(0, resultAt).some((item) => item.status === "idle"),
  itemsA.map((item) => item.status ?? item.event?.kind),
);
await until("A to go idle", () => (seen.get(CHAT_A) ?? []).at(-1)?.status === "idle", 10_000);
await new Promise((r) => setTimeout(r, 1500)); // the archive writes behind
const idA = archived(CHAT_A).lastSessionId;
check("A: the chat is on a session that exists", idA !== GONE_ID && transcriptOf(dirA, idA), idA);

/* ── B. a dead process holding a session that has since gone ───────── */

send({ type: "send", projectId: CHAT_B, text: "Reply with the single word: ok" });
await until("B's first answer", () => results(CHAT_B).length > 0, 120_000);
check("B: the first turn ends well", results(CHAT_B)[0]?.ok === true, results(CHAT_B)[0]);
await new Promise((r) => setTimeout(r, 1500));
const idB = archived(CHAT_B).lastSessionId;
check("B: it is on a session that exists", transcriptOf(dirB, idB), idB);

// the chat's process dies (as a crash would), and its transcript goes
const pids = execFileSync("ps", ["-axwwE", "-o", "pid=,command="], { encoding: "utf8" })
  .split("\n")
  .filter((line) => line.includes(`RURI_CHANNEL=${CHAT_B}`) && /\bclaude\b/.test(line))
  .map((line) => Number(line.trim().split(/\s+/)[0]));
check("B: its process is found", pids.length > 0);
for (const pid of pids) process.kill(pid, "SIGKILL");
await new Promise((r) => setTimeout(r, 2000));
for (const claudeDir of claudeDirsOf(dirB)) fs.rmSync(path.join(claudeDir, `${idB}.jsonl`), { force: true });

const second = (seen.get(CHAT_B) ?? []).length;
send({ type: "send", projectId: CHAT_B, text: "Reply with the single word: ok" });
await until("B's second answer", () => results(CHAT_B, second).length > 0, 120_000);
const lostSaid = said(CHAT_B, second);
check("B: the second turn ends well", results(CHAT_B, second)[0]?.ok === true, results(CHAT_B, second)[0]);
check("B: the chat never shows the lost session", !/No conversation found/.test(lostSaid), lostSaid);
check(
  "B: let go of once, before the prompt — the dead process's id didn't come back",
  (lostSaid.match(/is gone, so this prompt starts a fresh one/g) ?? []).length === 1,
  lostSaid,
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
await cleanup(failed === 0 ? 0 : 1);
