/**
 * The bridge closes when nobody is driving it (server/server.ts):
 *
 *   1. a taken-over window handed back while no turn runs is closed a
 *      few seconds later — no tokens;
 *   2. a window a turn opened is closed a few seconds after the turn ends
 *      — one short Haiku turn that calls web_open.
 *
 * Boots the real desktop app with an isolated config, userData and port
 * (never touching the installed ruri.app), as scripts/bridge.ts does.
 * Needs `bun run build:web && bun run build:main` first.
 *
 *   bun run bridge-close-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { BridgeState, ClientMessage, ServerMessage } from "../shared/protocol.js";

const root = path.resolve(import.meta.dirname, "..");
const PORT = 7797;
const CDP_PORT = 9347;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-bclose-config-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-bclose-user-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-bclose-project-"));

const site = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>Close fixture</title><h1>Close fixture</h1>");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const address = site.address();
const SITE = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

const app = spawn(path.join(root, "node_modules", ".bin", "electron"), [root, `--remote-debugging-port=${CDP_PORT}`], {
  cwd: root,
  env: { ...process.env, RURI_CONFIG_DIR: configDir, RURI_USER_DATA: userData, RURI_PORT: String(PORT), RURI_NO_MEMORY: "1" },
  stdio: "ignore",
});

let failed = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) failed += 1;
}
function finish(): never {
  app.kill("SIGINT");
  setTimeout(() => app.kill("SIGKILL"), 3000).unref();
  site.close();
  for (const dir of [configDir, userData, projectDir]) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : "all good");
  process.exit(failed ? 1 : 0);
}
setTimeout(() => {
  check("finished in time", false);
  finish();
}, 240_000).unref();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) break;
  } catch {
    // not up yet
  }
  if (i > 240) {
    check("the app came up", false);
    finish();
  }
  await sleep(250);
}

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
let channelId: string | undefined;
let projectId: string | undefined;
let state: BridgeState | null | undefined;
let resultSeen = false;
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" || msg.type === "snapshot") {
    const project = msg.projects.find((p) => p.path === projectDir);
    projectId ??= project?.id;
    channelId ??= project?.sessions[0]?.id;
  }
  if (msg.type === "bridge" && msg.projectId === channelId) state = msg.state;
  if (msg.type === "event" && msg.projectId === channelId && msg.event.kind === "result") resultSeen = true;
});
send({ type: "add_project", name: "bridge-close", path: projectDir });
for (let i = 0; i < 40 && !channelId; i++) await sleep(100);
if (!channelId || !projectId) {
  check("add_project made a session", false);
  finish();
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return true;
    await sleep(200);
  }
  return test();
}

/* 1 — handed back while idle */
const opened = await fetch(`http://127.0.0.1:${PORT}/bridge/${channelId}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tool: "web_open", args: { url: SITE } }),
}).then((r) => r.json() as Promise<{ ok: boolean }>);
check("a window opened outside any turn", opened.ok && (await until(() => !!state, 5000)));
await sleep(4500);
check("and it is left alone while nobody hands anything back", !!state);
send({ type: "bridge_takeover", projectId: channelId! });
check("taken over", await until(() => state?.takenOver === true, 5000));
send({ type: "bridge_release", projectId: channelId! });
check("handed back while idle, it closes within a few seconds", await until(() => state === null, 8000));

/* 2 — a turn's window closes when the turn ends */
state = undefined;
send({ type: "set_model", projectId: projectId!, model: "haiku" });
send({
  type: "send",
  projectId: channelId!,
  text: `Call the mcp__bridge__web_open tool with the url ${SITE} and then reply with just the word done. Do not close it.`,
});
check("the turn opened a window", await until(() => !!state, 90_000));
check("the turn finished", await until(() => resultSeen, 90_000));
check("the window closes within a few seconds of the turn ending", await until(() => state === null, 8000));
finish();
