/**
 * Feature parity on a non-Claude harness, end to end through the real
 * server: a Codex session's tool chips (ruri's own vocabulary), the patch
 * under an edit, the context gauge, the harness's own limit windows, and a
 * rewind. Costs one real Codex turn — run manually: bun run provider-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ContextUsage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7894;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-provider-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-provider-project-"));
fs.writeFileSync(path.join(projectDir, "hello.txt"), "before\n");

const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
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
}, 420_000).unref();

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
let promptId: string | undefined;
let phase: "run" | "rewind" = "run";
const tools: TranscriptEvent[] = [];
let context: ContextUsage | undefined;
let turnContext: ContextUsage | undefined;
let usage: Record<string, unknown> = {};
let removed = 0;
let composed: string | undefined;
let notice: string | undefined;

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  switch (msg.type) {
    case "snapshot":
      usage = msg.usage;
      send({ type: "add_project", name: "harness", path: projectDir });
      break;
    case "projects":
      if (!projectId && msg.projects.length > 0) {
        const project = msg.projects[msg.projects.length - 1]!;
        projectId = project.sessions[0]!.id;
        // the model is a project setting; the channel is its session —
        // "codex" alone means that harness's own default model
        send({ type: "set_model", projectId: project.id, model: "codex" });
        console.log(`[t] project ${projectId} on codex — sending the turn`);
        send({
          type: "send",
          projectId,
          text: "Read hello.txt, then rewrite it so it contains exactly: after. Use apply_patch.",
        });
      }
      break;
    case "usage":
      usage = msg.limits;
      break;
    case "context":
      context = msg.context;
      break;
    case "event": {
      const e = msg.event;
      if (e.kind === "user" && !promptId) promptId = e.id;
      if (e.kind === "tool") {
        tools.push(e);
        console.log(`[t] chip ${e.name} — ${e.summary.slice(0, 60)}${e.diff ? ` (+${e.diff.added} −${e.diff.removed})` : ""}`);
      }
      if (e.kind === "result" && phase === "run") {
        phase = "rewind";
        // what the gauge read at the end of the turn — the rewind below
        // zeroes it, which is its own correct behaviour
        turnContext = context;
        console.log(`[t] turn done; context ${JSON.stringify(context)} — rewinding`);
        setTimeout(() => send({ type: "rewind", projectId: projectId!, eventId: promptId! }), 500);
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
      notice = msg.message;
      console.log(`[t] server says: ${msg.message}`);
      break;
  }
});

function check(): void {
  const named = tools.some((t) => t.kind === "tool" && (t.name === "Bash" || t.name === "Read"));
  const patched = tools.some((t) => t.kind === "tool" && t.name === "Edit" && t.diff !== undefined);
  const gauged = (turnContext?.tokens ?? 0) > 0 && (turnContext?.window ?? 0) > 0;
  const limits = (usage as Record<string, { fiveHour?: number }>)["codex"];
  const windows = typeof limits?.fiveHour === "number";
  const rewound = removed > 0 && (composed ?? "").startsWith("Read hello.txt");
  console.log(`\ncontext at turn's end: ${JSON.stringify(turnContext)}; after the rewind: ${JSON.stringify(context)}`);
  console.log(`codex limits: ${JSON.stringify(limits)}`);
  console.log(
    `checks: ruriToolNames=${named} patchUnderEdit=${patched} contextGauge=${gauged} harnessWindows=${windows} rewind=${rewound}`,
  );
  if (notice) console.log(`notice: ${notice}`);
  const ok = named && patched && gauged && windows && rewound;
  console.log(ok ? "\nPROVIDER SESSION PASS" : "\nPROVIDER SESSION FAIL");
  done(ok ? 0 : 1);
}
