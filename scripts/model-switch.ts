/**
 * Switching model never touches a running turn, and switching back keeps
 * the prompt cache.
 *
 * Against the real server and the real Claude CLI:
 *   1. a turn starts on haiku; while it runs, the chat picks sonnet — the
 *      running turn still answers on haiku, on the same live session;
 *   2. the next prompt answers on sonnet;
 *   3. the chat picks haiku again and prompts — it answers on haiku, and the
 *      API reads the conversation's prefix back from the cache, which is
 *      only possible when the same conversation went out again, byte for
 *      byte, on a process that was never rebuilt.
 * Costs three very small turns — run manually: bun run model-switch-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7896;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-switch-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-switch-project-"));

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

let chat: string | undefined;
const results: Array<Extract<TranscriptEvent, { kind: "result" }>> = [];
const statuses: string[] = [];
let switched = false;

const PROMPT = (n: number) =>
  `Turn ${n}. Count from 1 to 12 on one line, separated by spaces, then say "done". Nothing else.`;

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  switch (msg.type) {
    case "snapshot":
      send({ type: "add_project", name: "switch", path: projectDir });
      break;
    case "projects": {
      const project = msg.projects[msg.projects.length - 1];
      if (!chat && project) {
        chat = project.sessions[0]!.id;
        // the chat's own pick, by session id — haiku, then the first turn
        send({ type: "set_model", projectId: chat, model: "haiku" });
        console.log(`[t] chat ${chat} on haiku — turn 1`);
        send({ type: "send", projectId: chat, text: PROMPT(1) });
      } else if (project && chat && !switched) {
        // the projects broadcast after the pick: the session carries it
        const mine = project.sessions.find((s) => s.id === chat);
        if (mine?.model === "haiku") {
          console.log(`[t] the pick landed on the session (${mine.model})`);
        }
      }
      break;
    }
    case "status":
      if (msg.projectId !== chat) break;
      statuses.push(msg.status);
      // the turn is running: pick sonnet right now, under it
      if (msg.status === "working" && !switched) {
        switched = true;
        console.log(`[t] turn 1 is running — picking sonnet under it`);
        send({ type: "set_model", projectId: chat, model: "sonnet" });
      }
      break;
    case "event": {
      if (msg.projectId !== chat || msg.event.kind !== "result") break;
      results.push(msg.event);
      console.log(`[t] turn ${results.length}: models=${JSON.stringify(msg.event.models)} cacheRead=${msg.event.cacheRead ?? 0}`);
      if (results.length === 1) {
        console.log(`[t] turn 2 — should answer on sonnet`);
        send({ type: "send", projectId: chat, text: PROMPT(2) });
      } else if (results.length === 2) {
        console.log(`[t] picking haiku again — turn 3 should read the prefix back from cache`);
        send({ type: "set_model", projectId: chat, model: "haiku" });
        send({ type: "send", projectId: chat, text: PROMPT(3) });
      } else {
        const [one, two, three] = results;
        const on = (r: typeof one, name: string) => (r?.models ?? []).some((m) => m.includes(name)) && (r?.models ?? []).every((m) => m.includes(name));
        const checks = [
          ["turn 1 answered on haiku, the model it started on", on(one, "haiku")],
          ["the switch never touched the running turn (no sonnet in it)", !(one?.models ?? []).some((m) => m.includes("sonnet"))],
          ["turn 2 answered on sonnet", on(two, "sonnet")],
          ["turn 3 answered on haiku again", on(three, "haiku")],
          ["turn 3 read the conversation back from the prompt cache", (three?.cacheRead ?? 0) > 0],
        ] as const;
        let failed = 0;
        for (const [name, ok] of checks) {
          console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
          if (!ok) failed += 1;
        }
        if (failed) console.log("results:", JSON.stringify(results, null, 1));
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
