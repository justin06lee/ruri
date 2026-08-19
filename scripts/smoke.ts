/**
 * End-to-end smoke test: boots the ruri server, connects over WebSocket like
 * the UI would, and runs two real Claude Code turns in a scratch project —
 * one plain reply, one that uses Bash (exercising the permission flow).
 * Costs a few real tokens — run manually: pnpm smoke
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PORT = 7877;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-smoke-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-smoke-project-"));
fs.writeFileSync(path.join(projectDir, "hello.txt"), "hello from ruri smoke\n");

const server = spawn("npx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: { ...process.env, RURI_PORT: String(PORT), RURI_CONFIG_DIR: configDir },
  stdio: ["ignore", "pipe", "inherit"],
});
server.stdout.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));

function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("SMOKE FAIL: timed out");
  cleanup(1);
}, 240_000);
deadline.unref();

async function connectWithRetry(url: string, timeoutMs: number): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(url);
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - start > timeoutMs) {
        console.error("SMOKE FAIL: could not connect to server");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const ws = await connectWithRetry(`ws://127.0.0.1:${PORT}`, 60_000);
ws.on("error", (err) => {
  console.error(`SMOKE FAIL: websocket error: ${err.message}`);
  cleanup(1);
});
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

let projectId: string | undefined;
let assistantTexts: string[] = [];
let toolNames: string[] = [];
let permissionCount = 0;
let sawDelta = false;
let resultsSeen = 0;
let phase: 1 | 2 | 3 = 1;

console.log("[client] connected");
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  switch (msg.type) {
    case "snapshot": {
      console.log(`[client] snapshot: ${msg.projects.length} projects`);
      send({ type: "add_project", name: "smoke", path: projectDir });
      break;
    }
    case "projects": {
      if (!projectId && msg.projects.length > 0) {
        projectId = msg.projects[msg.projects.length - 1]!.id;
        console.log(`[client] project added (${projectId}); sending turn 1`);
        send({ type: "send", projectId, text: "Reply with exactly: pong. Do not use any tools." });
      }
      break;
    }
    case "delta": {
      sawDelta = true;
      break;
    }
    case "event": {
      const e = msg.event;
      if (e.kind === "assistant") {
        assistantTexts.push(e.text);
        console.log(`[client] assistant: ${JSON.stringify(e.text.slice(0, 100))}`);
      } else if (e.kind === "tool") {
        toolNames.push(e.name);
        console.log(`[client] tool: ${e.name} — ${e.summary}`);
      } else if (e.kind === "result") {
        resultsSeen += 1;
        console.log(`[client] result: ok=${e.ok} cost=$${e.costUsd?.toFixed(4)} in ${((e.durationMs ?? 0) / 1000).toFixed(1)}s`);
        if (!e.ok) {
          console.error(`SMOKE FAIL: turn errored: ${e.error}`);
          cleanup(1);
        }
        if (phase === 1) {
          phase = 2;
          console.log("[client] sending turn 2 (needs Bash)");
          send({
            type: "send",
            projectId: projectId!,
            text: "Using a single Bash command, run `echo ruri-was-here > out.txt && cat out.txt` and tell me the output verbatim.",
          });
        } else if (phase === 2) {
          phase = 3;
          console.log("[client] sending turn 3 (WebFetch — should require permission)");
          send({
            type: "send",
            projectId: projectId!,
            text: "Use the WebFetch tool to fetch https://example.com and tell me the page's main heading text.",
          });
        } else {
          finish();
        }
      }
      break;
    }
    case "permission_request": {
      permissionCount += 1;
      console.log(`[client] permission request: ${msg.request.toolName} → allowing`);
      send({ type: "permission_response", requestId: msg.request.requestId, allow: true });
      break;
    }
    case "error": {
      console.error(`SMOKE FAIL: server error: ${msg.message}`);
      cleanup(1);
    }
  }
});

function finish(): void {
  const turn1ok = assistantTexts.some((t) => t.toLowerCase().includes("pong"));
  const turn2ok = assistantTexts.some((t) => t.includes("ruri-was-here"));
  const usedBash = toolNames.includes("Bash");
  console.log(
    `\nchecks: turn1=${turn1ok} turn2=${turn2ok} bashTool=${usedBash} deltas=${sawDelta} permissions=${permissionCount} results=${resultsSeen}`,
  );
  const turn3ok = assistantTexts.some((t) => t.includes("Example Domain"));
  console.log(`        turn3=${turn3ok} (permission round-trip: ${permissionCount >= 1})`);
  const ok = turn1ok && turn2ok && turn3ok && usedBash && sawDelta && permissionCount >= 1 && resultsSeen === 3;
  console.log(ok ? "\nSMOKE PASS" : "\nSMOKE FAIL");
  cleanup(ok ? 0 : 1);
}
