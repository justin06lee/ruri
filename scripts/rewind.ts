/**
 * Rewind end-to-end: boot the server, run one turn that rewrites a file, then
 * rewind that prompt and check three things — the file went back to how it
 * was, the transcript truncated, and the prompt came back to the composer.
 * Costs a real turn's tokens — run manually: bun run rewind-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PORT = 7893;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-project-"));
const target = path.join(projectDir, "hello.txt");
fs.writeFileSync(target, "before\n");

const root = path.join(import.meta.dirname, "..");
const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: root,
  env: { ...process.env, RURI_PORT: String(PORT), RURI_CONFIG_DIR: configDir },
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

let projectId: string | undefined;
let promptEventId: string | undefined;
let phase: "run" | "rewind" = "run";
let composed: string | undefined;
let removed = 0;
let serverError: string | undefined;

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  switch (msg.type) {
    case "snapshot":
      send({ type: "add_project", name: "rewind", path: projectDir });
      break;
    case "projects":
      if (!projectId && msg.projects.length > 0) {
        projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
        console.log(`[t] project ${projectId} — sending the turn`);
        send({
          type: "send",
          projectId,
          text: "Overwrite hello.txt in the project root so it contains exactly: after. Use the Write tool, nothing else.",
        });
      }
      break;
    case "event": {
      const e = msg.event;
      if (e.kind === "user" && !promptEventId) promptEventId = e.id;
      if (e.kind === "tool") console.log(`[t] tool ${e.name}`);
      if (e.kind === "result" && phase === "run") {
        phase = "rewind";
        const body = fs.readFileSync(target, "utf8");
        console.log(`[t] turn done; hello.txt = ${JSON.stringify(body)}`);
        if (body.trim() !== "after") {
          console.error("FAIL: the turn did not write the file — nothing to rewind");
          done(1);
        }
        console.log("[t] rewinding…");
        send({ type: "rewind", projectId: projectId!, eventId: promptEventId! });
      }
      break;
    }
    case "events_removed":
      removed += msg.eventIds.length;
      break;
    case "compose":
      composed = msg.text;
      setTimeout(check, 1500);
      break;
    case "permission_request":
      send({ type: "permission_response", requestId: msg.request.requestId, allow: true });
      break;
    case "error":
      console.log(`[t] server says: ${msg.message}`);
      serverError = msg.message;
      if (!composed) setTimeout(check, 2000);
      break;
  }
});

function check(): void {
  const body = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "<gone>";
  const filesBack = body.trim() === "before";
  const promptBack = (composed ?? "").startsWith("Overwrite hello.txt");
  console.log(`\nhello.txt after rewind: ${JSON.stringify(body)}`);
  console.log(`checks: filesRestored=${filesBack} promptReturned=${promptBack} eventsRemoved=${removed}`);
  if (serverError) console.log(`server error seen: ${serverError}`);
  const ok = filesBack && promptBack && removed > 0;
  console.log(ok ? "\nREWIND PASS" : "\nREWIND FAIL");
  done(ok ? 0 : 1);
}
