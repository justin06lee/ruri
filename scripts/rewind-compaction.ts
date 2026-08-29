/**
 * Rewinding around a compaction, with no model in the loop.
 *
 * The rewind used to refuse outright whenever a compaction sat anywhere in
 * the transcript — including behind the prompt, where it means nothing, and
 * the refusal was reached before the fallback that would have found the fork
 * point. This seeds an archive on disk with a compaction on each side of a
 * prompt and checks both rewinds land: the transcript truncates, the prompt
 * comes back to the composer, and nothing is refused.
 *
 * Costs nothing — no turn is ever run: bun run rewind-compaction-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7894;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-compaction-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-project-"));

const PROJECT_ID = "p-compaction";
const CHANNEL = "c-compaction";

/** before → compaction → the prompt we rewind → after. */
const ts = 1_700_000_000_000;
const events: TranscriptEvent[] = [
  { kind: "user", id: "u-old", text: "the first thing", ts },
  { kind: "assistant", id: "a-old", text: "did the first thing", ts: ts + 1 },
  { kind: "result", id: "r-old", ok: true, ts: ts + 2 },
  { kind: "compaction", id: "comp-1", text: "brief of everything before", ts: ts + 3 },
  { kind: "user", id: "u-target", text: "the prompt we rewind to", ts: ts + 4 },
  { kind: "assistant", id: "a-target", text: "did that", ts: ts + 5 },
  { kind: "result", id: "r-target", ok: true, ts: ts + 6 },
  { kind: "user", id: "u-after", text: "a later prompt", ts: ts + 7 },
];

fs.mkdirSync(path.join(configDir, "sessions"), { recursive: true });
fs.writeFileSync(
  path.join(configDir, "projects.json"),
  JSON.stringify({
    projects: [
      {
        id: PROJECT_ID,
        name: "compaction",
        path: projectDir,
        sessions: [{ id: CHANNEL, title: "Rewind" }],
        model: "claude-fable-5[1m]",
      },
    ],
  }),
);
fs.writeFileSync(
  path.join(configDir, "sessions", `${CHANNEL}.json`),
  JSON.stringify({ events, summaries: {}, contextTokens: 0 }),
);

const root = path.join(import.meta.dirname, "..");
const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: root,
  env: { ...process.env, RURI_PORT: String(PORT), RURI_CONFIG_DIR: configDir, RURI_NO_MEMORY: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));

function done(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("FAIL: timed out");
  done(1);
}, 60_000).unref();

async function connect(): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
      await new Promise<void>((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      return ws;
    } catch {
      if (Date.now() - start > 20_000) throw new Error("server never came up");
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

const ws = await connect();
const seen: ServerMessage[] = [];
ws.on("message", (raw) => seen.push(JSON.parse(String(raw)) as ServerMessage));
const send = (message: ClientMessage) => ws.send(JSON.stringify(message));
const settle = () => new Promise((r) => setTimeout(r, 1200));

await settle();

send({ type: "rewind", projectId: CHANNEL, eventId: "u-target" });
await settle();

const failed = seen.find(
  (m) => m.type === "error" && m.message.startsWith("rewind failed"),
) as Extract<ServerMessage, { type: "error" }> | undefined;
const removed = seen.find((m) => m.type === "events_removed") as
  | Extract<ServerMessage, { type: "events_removed" }>
  | undefined;
const composed = seen.find((m) => m.type === "compose") as
  | Extract<ServerMessage, { type: "compose" }>
  | undefined;

let bad = 0;
if (failed) {
  console.error(`FAIL: rewind refused — ${failed.message}`);
  bad++;
}
if (!removed || !removed.eventIds.includes("u-target") || !removed.eventIds.includes("u-after")) {
  console.error(`FAIL: the transcript did not truncate (${JSON.stringify(removed?.eventIds)})`);
  bad++;
}
if (removed?.eventIds.includes("u-old") || removed?.eventIds.includes("comp-1")) {
  console.error("FAIL: it truncated past the compaction, which is not what was asked");
  bad++;
}
if (composed?.text !== "the prompt we rewind to") {
  console.error(`FAIL: the prompt did not come back (${JSON.stringify(composed?.text)})`);
  bad++;
}

if (bad === 0) {
  console.log("PASS: rewound past a compaction that sat behind the prompt");
  console.log(`      truncated ${removed?.eventIds.length} events, prompt back in the composer`);
}

// Stage two: what's left is the first exchange with the compaction after it.
// Rewinding to that prompt can't fork (the running session began at the
// boundary), so it should take the harness path and say so — not refuse.
seen.length = 0;
send({ type: "rewind", projectId: CHANNEL, eventId: "u-old" });
await settle();

const refused = seen.find(
  (m) => m.type === "error" && m.message.startsWith("rewind failed"),
) as Extract<ServerMessage, { type: "error" }> | undefined;
const explained = seen.find(
  (m) => m.type === "error" && m.message.startsWith("rewound the conversation"),
) as Extract<ServerMessage, { type: "error" }> | undefined;
const removed2 = seen.find((m) => m.type === "events_removed") as
  | Extract<ServerMessage, { type: "events_removed" }>
  | undefined;
const composed2 = seen.find((m) => m.type === "compose") as
  | Extract<ServerMessage, { type: "compose" }>
  | undefined;

if (refused) {
  console.error(`FAIL: rewind with a compaction ahead of it refused — ${refused.message}`);
  bad++;
}
if (!removed2?.eventIds.includes("comp-1")) {
  console.error("FAIL: the compaction after the prompt was not truncated away");
  bad++;
}
if (composed2?.text !== "the first thing") {
  console.error(`FAIL: the earlier prompt did not come back (${JSON.stringify(composed2?.text)})`);
  bad++;
}
if (!explained?.message.includes("compacted after this prompt")) {
  console.error(`FAIL: it didn't say why the files were left alone (${JSON.stringify(explained?.message)})`);
  bad++;
}
if (bad === 0) console.log("PASS: a compaction ahead of the prompt rewinds the way a harness does, and says so");

done(bad === 0 ? 0 : 1);
