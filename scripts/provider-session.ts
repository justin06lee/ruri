/**
 * Feature parity on a non-Claude harness, end to end through the real
 * server: the session's tool chips (ruri's own vocabulary), the patch under
 * an edit, narration interleaved with the chips it came before, the context
 * gauge, the harness's own limit windows, and a rewind.
 *
 * Costs one real turn on that harness — run manually:
 *   bun run provider-test            # codex
 *   RURI_TEST_PROVIDER=gemini bun run provider-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ContextUsage, ServerMessage, TranscriptEvent } from "../shared/protocol.js";

const PORT = 7894;
const HARNESS = process.env["RURI_TEST_PROVIDER"] ?? "codex";
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
/** Every event of the turn, in the order it arrived — the narration a
 *  harness writes before a tool call must land above that call's chip. */
const order: string[] = [];
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
        // the model is a project setting; the channel is its session — the
        // bare provider id means that harness's own default model
        send({ type: "set_model", projectId: project.id, model: HARNESS });
        console.log(`[t] project ${projectId} on ${HARNESS} — sending the turn`);
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
      if (phase === "run") order.push(e.kind);
      if (e.kind === "user" && !promptId) promptId = e.id;
      if (e.kind === "tool") {
        tools.push(e);
        console.log(`[t] chip ${e.name} — ${e.summary.slice(0, 60)}${e.diff ? ` (+${e.diff.added} −${e.diff.removed})` : ""}`);
      }
      if (e.kind === "result" && phase === "run") {
        if (e.error) console.log(`[t] turn error: ${e.error}`);
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
  const RURI_NAMES = ["Bash", "Read", "Write", "Edit", "Grep", "Glob"];
  const named = tools.some((t) => t.kind === "tool" && RURI_NAMES.includes(t.name));
  const patched = tools.some((t) => t.kind === "tool" && t.diff !== undefined);
  const gauged = (turnContext?.tokens ?? 0) > 0 && (turnContext?.window ?? 0) > 0;
  const limits = (usage as Record<string, { fiveHour?: number }>)[HARNESS];
  // only harnesses that publish their windows are held to this one
  const windows = HARNESS === "codex" ? typeof limits?.fiveHour === "number" : true;
  const rewound = removed > 0 && (composed ?? "").startsWith("Read hello.txt");
  // the harness narrates before it acts, so an assistant event must come
  // before the first chip rather than after every one of them
  const firstTool = order.indexOf("tool");
  const firstAssistant = order.indexOf("assistant");
  const ordered = firstTool === -1 || (firstAssistant !== -1 && firstAssistant < firstTool);
  console.log(`\ncontext at turn's end: ${JSON.stringify(turnContext)}; after the rewind: ${JSON.stringify(context)}`);
  console.log(`${HARNESS} limits: ${JSON.stringify(limits)}`);
  console.log(`event order: ${order.join(" → ")}`);
  console.log(
    `checks: ruriToolNames=${named} patchUnderEdit=${patched} contextGauge=${gauged} harnessWindows=${windows} rewind=${rewound} interleaved=${ordered}`,
  );
  if (notice) console.log(`notice: ${notice}`);
  const ok = named && patched && gauged && windows && rewound && ordered;
  console.log(ok ? "\nPROVIDER SESSION PASS" : "\nPROVIDER SESSION FAIL");
  done(ok ? 0 : 1);
}
