/**
 * A picture a reply points at by path shows up.
 *
 * A reply's `![icon](build/icon.png)` used to render as a broken image: the
 * page cannot open files, and the server served only what a Read tool event
 * had named. Now the paths a reply writes in markdown images are registered
 * as the event is recorded — relative to the project — and the page asks for
 * them through /read by the path as written.
 *
 * One tiny real turn against the real server — run manually: bun run md-image-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7883);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-mdimg-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-mdimg-project-"));
// a 1×1 PNG, in build/icon.png of the project
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
fs.mkdirSync(path.join(projectDir, "build"));
fs.writeFileSync(path.join(projectDir, "build", "icon.png"), PNG);

const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: { ...process.env, RURI_PORT: String(PORT), RURI_CONFIG_DIR: configDir },
  stdio: ["ignore", "ignore", "inherit"],
});

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}
function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("MD-IMAGE FAIL: timed out");
  cleanup(1);
}, 180_000).unref();

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
        console.error("MD-IMAGE FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
let reply = "";
let done = false;
const waiters = new Set<() => void>();
const ws = await connect(`ws://127.0.0.1:${PORT}`);
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "event" && msg.projectId === projectId) {
    if (msg.event.kind === "assistant") reply += msg.event.text;
    if (msg.event.kind === "result") done = true;
  }
  for (const waiter of [...waiters]) waiter();
});
function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!ok()) return;
      clearTimeout(timer);
      waiters.delete(look);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve();
    }, ms);
    waiters.add(look);
  });
}

send({ type: "add_project", name: "mdimg", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("MD-IMAGE FAIL: no project");
  cleanup(1);
}
send({
  type: "send",
  projectId,
  text: "Reply with exactly this line of markdown and nothing else, no tools: ![the icon](build/icon.png)",
});
await until("the reply", () => done, 120_000);
check("the reply names the picture by path", reply.includes("](build/icon.png)"), reply);

const asked = await fetch(`http://127.0.0.1:${PORT}/readfile?p=${encodeURIComponent("build/icon.png")}`);
check("the page can ask for it by the path as written", asked.status === 200, asked.status);
check("and gets the picture", asked.headers.get("content-type") === "image/png" && (await asked.arrayBuffer()).byteLength === PNG.length);
const other = await fetch(`http://127.0.0.1:${PORT}/readfile?p=${encodeURIComponent("build/other.png")}`);
check("a path no reply named is still refused", other.status === 403, other.status);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
