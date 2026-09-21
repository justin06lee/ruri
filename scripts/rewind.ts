/**
 * Rewind end-to-end, with a real model: boot the server on a scratch git
 * repository, run two turns — the first writes a file with the Write tool,
 * the second rewrites it through the shell and commits, which is exactly
 * what Claude's own file checkpoints never see — then rewind the second
 * prompt and check that everything it did came back out: the file is as
 * the first turn left it, the commit is gone, nothing is staged, the
 * transcript truncated, the prompt is back in the composer, and the context
 * gauge reads what the first exchange left rather than the tip.
 *
 * Costs two short turns on Haiku — run manually: bun run rewind-test
 */
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PORT = 7893;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-project-"));
const target = path.join(projectDir, "hello.txt");
const git = (...args: string[]) => execFileSync("git", args, { cwd: projectDir, encoding: "utf8" }).trim();
fs.writeFileSync(target, "before\n");
git("init", "-q", "-b", "master");
git("config", "user.email", "t@example.com");
git("config", "user.name", "t");
git("add", "-A");
git("commit", "-q", "-m", "init");
const start = git("rev-parse", "HEAD");

const root = path.join(import.meta.dirname, "..");
const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: root,
  env: { ...process.env, RURI_PORT: String(PORT), RURI_TOKEN: TOKEN, RURI_CONFIG_DIR: configDir },
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
  const began = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(wsUrl(PORT));
        sock.on("error", () => {});
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - began > 60_000) {
        console.error("FAIL: no server");
        done(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

const ws = await connect();
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

const PROMPTS = [
  "Overwrite hello.txt in the project root so it contains exactly the line: one. Use the Write tool, nothing else.",
  "Using only the Bash tool, run exactly: printf 'two\\n' > hello.txt && git add -A && git commit -q -m two",
];

let channel: string | undefined;
const prompts: string[] = [];
const contexts: number[] = [];
let turn = 0;
let composed: string | undefined;
const removed: string[] = [];
let notice: string | undefined;

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  switch (msg.type) {
    case "snapshot":
      send({ type: "add_project", name: "rewind", path: projectDir });
      break;
    case "projects":
      if (!channel && msg.projects.length > 0) {
        channel = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
        send({ type: "set_model", projectId: channel, model: "haiku" });
        send({ type: "set_permission_mode", projectId: channel, mode: "bypassPermissions" });
        console.log(`[t] chat ${channel} — turn one`);
        send({ type: "send", projectId: channel, text: PROMPTS[0]! });
      }
      break;
    case "context":
      if (msg.projectId === channel) contexts[turn] = msg.context.tokens;
      break;
    case "event": {
      const e = msg.event;
      if (e.kind === "user") prompts.push(e.id);
      if (e.kind === "tool") console.log(`[t] tool ${e.name}`);
      if (e.kind === "result" && turn < 2) {
        turn += 1;
        console.log(`[t] turn ${turn} done; hello.txt = ${JSON.stringify(fs.readFileSync(target, "utf8"))}`);
        // a beat, so the turn's closing checkpoint is down before the next move
        setTimeout(() => {
          if (turn === 1) send({ type: "send", projectId: channel!, text: PROMPTS[1]! });
          else {
            console.log(`[t] contexts by turn: ${JSON.stringify(contexts.slice(0, 2))} — rewinding turn two`);
            send({ type: "rewind", projectId: channel!, eventId: prompts[1]! });
          }
        }, 1500);
      }
      break;
    }
    case "events_removed":
      removed.push(...msg.eventIds);
      break;
    case "compose":
      composed = msg.text;
      setTimeout(check, 2000);
      break;
    case "error":
      console.log(`[t] server says: ${msg.message}`);
      notice = msg.message;
      break;
  }
});

function check(): void {
  let bad = 0;
  const ok = (pass: boolean, what: string, got?: unknown) => {
    console.log(
      `${pass ? "ok  " : "FAIL"}  ${what}${pass || got === undefined ? "" : ` (got ${JSON.stringify(got)})`}`,
    );
    if (!pass) bad++;
  };
  const body = fs.readFileSync(target, "utf8");
  ok(body.trim() === "one", "the file is as turn one left it — the shell's change taken back", body);
  ok(git("rev-parse", "HEAD") === start, "the commit turn two made is gone", git("log", "--oneline"));
  ok(git("diff", "--cached", "--name-only") === "", "nothing is left staged", git("status", "--porcelain"));
  ok(removed.includes(prompts[1]!) && !removed.includes(prompts[0]!), "the transcript truncated at turn two");
  ok((composed ?? "").startsWith("Using only the Bash tool"), "the prompt is back in the composer", composed);
  const gauge = contexts[2];
  ok(
    gauge !== undefined && gauge > 0 && gauge === contexts[0],
    "the context gauge reads what turn one left",
    { now: gauge, afterTurnOne: contexts[0], afterTurnTwo: contexts[1] },
  );
  ok(!notice?.startsWith("rewind failed"), "the rewind was not refused", notice);
  console.log(bad === 0 ? "\nREWIND PASS" : "\nREWIND FAIL");
  done(bad === 0 ? 0 : 1);
}
