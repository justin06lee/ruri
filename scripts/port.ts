/**
 * The port is claimed, not hoped for — server/port.ts. Three cases, no tokens
 * and no network: bun run port-test
 *
 *   free      an unused port is simply taken
 *   orphan    a ruri that outlived its app is retired and its port taken back
 *   stranger  anything else on the port is left alone, and the fallback says so
 *
 * The orphan is the bug this exists for: `make install` moves the bundle of a
 * running app aside rather than deleting it, so a server from the superseded
 * bundle can hold the port for days. Every launch after that quietly came up
 * on an ephemeral port, which reads as a ruri that has forgotten its settings.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const PORT = 7898;
const HOST = "127.0.0.1";
const root = path.join(import.meta.dirname, "..");

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-port-config-"));
process.env["RURI_CONFIG_DIR"] = configDir;
process.env["RURI_NO_MEMORY"] = "1";

const { startServer } = await import("../server/server.js");

let failures = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: HOST });
    const answer = (occupied: boolean): void => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => answer(true));
    socket.once("timeout", () => answer(true));
    socket.once("error", () => answer(false));
  });
}

async function waitUntil(want: boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listening(PORT)) === want) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return false;
}

/** A ruri holding the port with no app behind it — the leftover, exactly. */
function spawnOrphan(): ReturnType<typeof spawn> {
  const orphanConfig = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-port-orphan-"));
  return spawn("bunx", ["tsx", "server/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      RURI_PORT: String(PORT),
      RURI_CONFIG_DIR: orphanConfig,
      RURI_NO_MEMORY: "1",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
}

try {
  // ── free ──────────────────────────────────────────────────────────────
  {
    const running = await startServer({ port: PORT, host: HOST, reclaimPort: true });
    check("free: takes the port it asked for", running.port === PORT, `got ${running.port}`);
    check("free: reports no fallback", running.portFallback === undefined, "a fallback was reported");
    await running.close();
  }

  // ── orphan ────────────────────────────────────────────────────────────
  {
    const orphan = spawnOrphan();
    const up = await waitUntil(true, 30_000);
    check("orphan: a leftover ruri is holding the port", up, "it never came up");

    const running = await startServer({ port: PORT, host: HOST, reclaimPort: true });
    check("orphan: the port is taken back", running.port === PORT, `fell back to ${running.port}`);
    check("orphan: no fallback reported", running.portFallback === undefined, "a fallback was reported");
    check("orphan: the leftover is gone", orphan.exitCode !== null || orphan.killed, "it is still running");
    await running.close();
    orphan.kill("SIGKILL");
  }

  // ── stranger ──────────────────────────────────────────────────────────
  {
    const stranger = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((done) => stranger.listen(PORT, HOST, done));

    const running = await startServer({ port: PORT, host: HOST, reclaimPort: true });
    check("stranger: goes around it", running.port !== PORT, "it took the stranger's port");
    check("stranger: says why", running.portFallback?.wanted === PORT, "no fallback reported");
    check("stranger: left alone", stranger.listening, "it was stopped");
    await running.close();
    await new Promise<void>((done) => stranger.close(() => done()));
  }
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nPORT OK" : `\nPORT FAIL: ${failures} check(s)`);
process.exit(failures === 0 ? 0 : 1);
