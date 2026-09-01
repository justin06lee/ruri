/**
 * Fork end-to-end: boot the server, run one turn that plants a word, fork
 * the conversation at that exchange, and ask the fork for the word. Three
 * things are checked — the fork answers from the shared history, the fork
 * has its own transcript holding the exchange, and the original transcript
 * is left exactly as it was. Costs two short turns' tokens — run manually:
 *   bun run fork-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7894;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-fork-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-fork-project-"));
const WORD = "pineapple";

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
}, 300_000).unref();

async function connect(): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(`ws://127.0.0.1:${PORT}`);
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - start > 60_000) {
        console.error("FAIL: no server");
        done(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const ws = await connect();
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

let originalId: string | undefined;
let forkId: string | undefined;
let promptEventId: string | undefined;
let phase: "plant" | "fork" | "ask" = "plant";
const transcripts = new Map<string, TranscriptEvent[]>();
let forkReply = "";

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  switch (msg.type) {
    case "snapshot":
      send({ type: "add_project", name: "fork", path: projectDir });
      break;
    case "projects": {
      const project = msg.projects[msg.projects.length - 1];
      if (!originalId && project) {
        originalId = project.sessions[0]!.id;
        send({ type: "set_model", projectId: project.id, model: "haiku" });
        console.log(`[t] session ${originalId} — planting the word`);
        send({
          type: "send",
          projectId: originalId,
          text: `Remember this word for later: ${WORD}. Reply with just "ok".`,
        });
      }
      break;
    }
    case "transcript":
      transcripts.set(msg.projectId, msg.events);
      break;
    case "open_session":
      forkId = msg.projectId;
      console.log(`[t] forked into ${forkId} — asking the fork for the word`);
      phase = "ask";
      send({
        type: "send",
        projectId: forkId,
        text: "What was the word I asked you to remember? Reply with just the word.",
      });
      break;
    case "event": {
      const list = transcripts.get(msg.projectId) ?? [];
      list.push(msg.event);
      transcripts.set(msg.projectId, list);
      if (msg.event.kind === "user" && msg.projectId === originalId && !promptEventId) promptEventId = msg.event.id;
      if (msg.event.kind === "assistant" && msg.projectId === forkId) forkReply += msg.event.text;
      if (msg.event.kind !== "result") break;
      if (phase === "plant" && msg.projectId === originalId) {
        phase = "fork";
        console.log(`[t] turn done — forking at the prompt`);
        send({ type: "fork", projectId: originalId!, eventId: promptEventId! });
      } else if (phase === "ask" && msg.projectId === forkId) {
        const original = transcripts.get(originalId!) ?? [];
        const fork = transcripts.get(forkId!) ?? [];
        const checks = [
          [`fork remembers the word`, forkReply.toLowerCase().includes(WORD)],
          [`fork's transcript holds the planted exchange first`, fork[0]?.kind === "user" && fork[0].text.includes(WORD)],
          [`fork's transcript grew by its own exchange`, fork.filter((e) => e.kind === "user").length === 2],
          [`original untouched (one exchange, no fork traffic)`, original.filter((e) => e.kind === "user").length === 1],
        ] as const;
        let failed = 0;
        for (const [name, ok] of checks) {
          console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
          if (!ok) failed += 1;
        }
        if (failed) console.log("fork replied:", JSON.stringify(forkReply));
        done(failed ? 1 : 0);
      }
      break;
    }
    case "error":
      console.error("[server error]", msg.message);
      break;
    default:
      break;
  }
});
