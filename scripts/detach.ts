/**
 * The server outlives the app, and an update never touches it.
 *
 * Against the real shell (the unpackaged Electron app) and the real server:
 *   1. the app comes up and spawns a server; a client connects to it;
 *   2. the app is killed outright (SIGKILL — a crash, not a quit) — the
 *      server keeps its pid, and the client's socket is still open;
 *   3. the app opens again and finds that same server, spawning nothing;
 *   4. a stale server is put on the port (version 0.0.1) and the app opens
 *      against it — the old server steps aside (everything is idle) and the
 *      app spawns one of its own version in its place.
 * Needs the web and main bundles built (this builds them). No tokens spent.
 * Run manually: bun run detach-test
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

const PORT = 7899;
const root = path.join(import.meta.dirname, "..");
const version = (JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version: string }).version;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-detach-user-"));
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-detach-config-"));
// the binary itself, not the .bin wrapper script: a signal to the wrapper
// leaves the real app running, which is exactly what this test must not
// mistake for the server surviving
const electron = (await import("electron")).default as unknown as string;

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

interface Health {
  version?: string;
  pid?: number;
}
async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(1_000) });
    return res.ok ? ((await res.json()) as Health) : null;
  } catch {
    return null;
  }
}
async function waitFor(pred: (h: Health | null) => boolean, ms: number): Promise<Health | null> {
  const start = Date.now();
  for (;;) {
    const h = await health();
    if (pred(h)) return h;
    if (Date.now() - start > ms) return h;
    await new Promise((r) => setTimeout(r, 300));
  }
}

const env = {
  ...process.env,
  RURI_PORT: String(PORT),
  RURI_USER_DATA: userData,
  RURI_CONFIG_DIR: configDir,
  RURI_NO_MEMORY: "1",
};

function launchShell(): ChildProcess {
  return spawn(electron, [root], { env, stdio: "ignore" });
}

function killServer(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already gone
  }
}

let shell: ChildProcess | null = null;
async function cleanup(code: number): Promise<never> {
  shell?.kill("SIGKILL");
  killServer((await health())?.pid);
  await waitFor((h) => h === null, 10_000);
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(configDir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("FAIL: timed out");
  void cleanup(1);
}, 240_000).unref();

console.log("[t] building the bundles");
execFileSync("bun", ["run", "build:web"], { cwd: root, stdio: "ignore" });
execFileSync("bun", ["run", "build:main"], { cwd: root, stdio: "ignore" });

if (await health()) {
  console.error(`FAIL: something already answers on ${PORT}`);
  process.exit(1);
}

/* ── 1. the app spawns a server ────────────────────────────────────── */
console.log("[t] opening the app");
shell = launchShell();
const first = await waitFor((h) => h !== null, 40_000);
check("the app brought a server up", first !== null, first);
check("and told it which version it is", first?.version === version, { server: first?.version, app: version });
const pid1 = first?.pid;

const client = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise<void>((resolve, reject) => {
  client.once("open", () => resolve());
  client.once("error", reject);
});
let clientClosed = false;
client.on("close", () => {
  clientClosed = true;
});

/* ── 2. the app dies; the server does not ──────────────────────────── */
console.log("[t] killing the app outright");
shell.kill("SIGKILL");
await new Promise((r) => setTimeout(r, 2_500));
const afterCrash = await health();
check("the server survived the app's death", afterCrash?.pid === pid1, { before: pid1, after: afterCrash });
check("a client's socket to it was never closed", !clientClosed && client.readyState === WebSocket.OPEN);

/* ── 3. the app reopens onto the same server ───────────────────────── */
console.log("[t] opening the app again");
shell = launchShell();
await new Promise((r) => setTimeout(r, 6_000));
const reopened = await health();
check("the reopened app found the running server (same pid)", reopened?.pid === pid1, { before: pid1, after: reopened });
check("and the client is still connected", !clientClosed && client.readyState === WebSocket.OPEN);
shell.kill("SIGKILL");
client.close();
await new Promise((r) => setTimeout(r, 1_000));
killServer(pid1);
await waitFor((h) => h === null, 10_000);

/* ── 4. a stale server steps aside for a newer app ─────────────────── */
console.log("[t] putting a stale server (0.0.1) on the port");
const stale = spawn(electron, [path.join(root, "dist-electron", "server.mjs")], {
  detached: true,
  stdio: "ignore",
  env: { ...env, ELECTRON_RUN_AS_NODE: "1", RURI_VERSION: "0.0.1", RURI_STATIC: path.join(root, "dist-web") },
});
stale.unref();
const staleUp = await waitFor((h) => h?.version === "0.0.1", 30_000);
check("the stale server is up", staleUp?.version === "0.0.1", staleUp);
const pid2 = staleUp?.pid;

console.log("[t] opening the app against it");
shell = launchShell();
const replaced = await waitFor((h) => h?.version === version && h.pid !== pid2, 40_000);
check("the stale server stepped aside and the app's own version took over", replaced?.version === version && replaced.pid !== pid2, {
  stale: pid2,
  now: replaced,
});

console.log(failed === 0 ? "\nall passed" : `\n${failed} failed`);
await cleanup(failed === 0 ? 0 : 1);
