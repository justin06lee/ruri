/**
 * A turn the API drops goes again by itself.
 *
 * An overloaded model comes back through the CLI as subtype "success" with
 * is_error set — the CLI finished, the call inside it did not — which ruri
 * used to read as a clean turn and sign "done", leaving the user to notice
 * the apology in the transcript and type "continue" themselves. Now the
 * result says what happened, and ruri types it: three tries, backing off,
 * down the same session, cancelled by anything the user does.
 *
 * There is no switch for it — an overload is weather, not a decision — so
 * the one pass here is the whole story: a dropped turn is reported as
 * dropped, goes again three times, says so each time, and is handed back
 * to the user when the three are up.
 *
 * It runs against the real server and the real CLI, pointed at a mock
 * gateway on this machine that answers 529 to everything. No tokens are
 * spent and no request leaves the box. CLAUDE_CODE_MAX_RETRIES=0 turns off
 * the CLI's own retry loop, which would otherwise spend three minutes per
 * attempt discovering the same thing.
 *
 * Run manually: bun run retry-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { TOKEN, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage, TurnProgress } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7881);
const GATEWAY_PORT = Number(process.env["RURI_GATEWAY_PORT"] ?? 8791);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-retry-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-retry-project-"));

/** Everything the model would have said, had it been reachable. */
let gatewayHits = 0;
const gateway = http.createServer((_req, res) => {
  gatewayHits += 1;
  res.writeHead(529, { "content-type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
});
await new Promise<void>((resolve) => gateway.listen(GATEWAY_PORT, "127.0.0.1", resolve));

const server = spawn("bunx", ["tsx", "server/index.ts"], {
  cwd: path.join(import.meta.dirname, ".."),
  env: {
    ...process.env,
    RURI_PORT: String(PORT),
    RURI_TOKEN: TOKEN,
    RURI_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${GATEWAY_PORT}`,
    CLAUDE_CODE_MAX_RETRIES: "0",
  },
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
  gateway.close();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("RETRY FAIL: timed out");
  cleanup(1);
}, 420_000);
deadline.unref();

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
        console.error("RETRY FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/* ── the server's state, as this client sees it ───────────────────── */

let projectId: string | undefined;
let status = "idle";
/** Every result this channel produced, newest last. */
const results: Array<{ ok: boolean; error?: string; transient?: boolean }> = [];
/** Every info line, in order — the retries narrate themselves through these. */
const notes: string[] = [];
/** The last working-line reading, and whether one ever arrived at all. */
let turn: TurnProgress | null = null;
let sawTurn = false;
const waiters = new Set<() => void>();

const ws = await connect(wsUrl(PORT));
ws.on("error", (err) => {
  console.error(`RETRY FAIL: websocket error: ${err.message}`);
  cleanup(1);
});
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));

ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "status" && msg.projectId === projectId) status = msg.status;
  if (msg.type === "turn" && msg.projectId === projectId) {
    turn = msg.turn;
    if (msg.turn) sawTurn = true;
  }
  if (msg.type === "event" && msg.projectId === projectId) {
    if (msg.event.kind === "result") {
      results.push({
        ok: msg.event.ok,
        ...(msg.event.error !== undefined ? { error: msg.event.error } : {}),
        ...(msg.event.transient !== undefined ? { transient: msg.event.transient } : {}),
      });
    }
    if (msg.event.kind === "info") notes.push(msg.event.text);
  }
  for (const waiter of [...waiters]) waiter();
});

function until(what: string, done: () => boolean, ms: number): Promise<void> {
  if (done()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!done()) return;
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

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ── the run ──────────────────────────────────────────────────────── */

send({ type: "add_project", name: "retry", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("RETRY FAIL: no project");
  cleanup(1);
}
const id = projectId;

// one dropped turn: reported as dropped, and the first retry announced
send({ type: "send", projectId: id, text: "say hi" });
await until("the dropped turn", () => results.length >= 1, 90_000);

const first = results[0];
check("a turn the API drops is not reported as done", first?.ok === false, first);
check("and its error names the 529", (first?.error ?? "").includes("529"), first);
check("and it is marked worth trying again", first?.transient === true, first);
check("the working line ran while it ran", sawTurn, { sawTurn });

await until("the channel to settle", () => status === "idle", 20_000);
check("and stood down when the turn ended", turn === null, { turn });
check(
  "the first wait is announced the moment the turn drops",
  notes.length === 1 && notes[0]!.includes("8s") && notes[0]!.includes("1 of 3"),
  notes,
);

// three tries, each announced, then back to the user — the waits are 8s,
// 25s and 60s, and each attempt takes about a second
await until(
  "three retries and the give-up",
  () => results.length >= 4 && notes.length >= 4,
  240_000,
);
await settle(2_000);

check("the dropped turn goes again three times", results.length === 4, results);
check(
  "every attempt is dropped the same way",
  results.every((r) => r.ok === false && r.transient === true),
  results,
);
check(
  "each wait says how long and which try it is",
  notes.length === 4 &&
    notes[0]!.includes("8s") &&
    notes[0]!.includes("1 of 3") &&
    notes[1]!.includes("25s") &&
    notes[1]!.includes("2 of 3") &&
    notes[2]!.includes("60s") &&
    notes[2]!.includes("3 of 3"),
  notes,
);
check("and the last word hands it back to the user", notes[3]?.includes("leaving this one to you") === true, notes);
check("every try went to the mock gateway, none to a real API", gatewayHits > 0, { gatewayHits });
check("and the working line is down again at the end", turn === null, { turn });

// handed back means handed back: nothing goes again on its own
await settle(10_000);
check("after the third, nothing goes again", results.length === 4 && notes.length === 4, { results, notes });

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
