/**
 * The door: a server with a known token refuses the wrong callers and
 * admits the right one (server/server.ts — originAllowed, tokenMatches).
 *
 *   - the socket: no token, a wrong token, and a foreign Origin are turned
 *     away; the token with the server's own origin, vite's, or none, gets in
 *   - HTTP: a POST needs the token and a permitted origin; the bridge call
 *     needs only the origin rule; GET stays open
 *   - the token file is written 0600 and removed on close
 *
 * No harness, no tokens spent. Run: bun run auth-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import { startServer } from "../server/server.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-auth-"));
process.env["RURI_CONFIG_DIR"] = configDir;
const PORT = Number(process.env["RURI_PORT"] ?? 7899);
const TOKEN = "token-for-the-auth-test";
const running = await startServer({ port: PORT, token: TOKEN });
const base = `http://127.0.0.1:${PORT}`;

/** What one socket attempt comes to: "open" (a snapshot arrived) or the status it was refused with. */
function socket(query: string, headers: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`, { headers });
    ws.once("open", () =>
      ws.once("message", () => {
        ws.close();
        resolve("open");
      }),
    );
    ws.once("error", () => {});
    ws.once("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
  });
}

const post = async (p: string, headers: Record<string, string> = {}) =>
  (await fetch(`${base}${p}`, { method: "POST", body: "{}", headers })).status;

try {
  check("socket: no token is refused", (await socket("")) === "http 401");
  check("socket: a wrong token is refused", (await socket("?token=nope")) === "http 401");
  check("socket: a foreign Origin is refused", (await socket(`?token=${TOKEN}`, { origin: "http://evil.example" })) === "http 403");
  check("socket: own origin gets in", (await socket(`?token=${TOKEN}`, { origin: base })) === "open");
  check("socket: vite's origin gets in (dev)", (await socket(`?token=${TOKEN}`, { origin: "http://localhost:5173" })) === "open");
  check("socket: no Origin (a script) gets in", (await socket(`?token=${TOKEN}`)) === "open");

  check("http: a POST without the token is 401", (await post("/anything")) === 401);
  check("http: a POST with the header passes the guard", (await post("/anything", { "x-ruri-token": TOKEN })) === 404);
  check("http: a POST with ?token= passes the guard", (await post(`/anything?token=${TOKEN}`)) === 404);
  check("http: a POST from a foreign Origin is 403", (await post("/anything", { "x-ruri-token": TOKEN, origin: "http://evil.example" })) === 403);
  check("http: the bridge call needs no token", (await post("/bridge/no-such-session")) === 404);
  check("http: the bridge call refuses a foreign Origin", (await post("/bridge/no-such-session", { origin: "http://evil.example" })) === 403);
  check("http: GET stays open", (await fetch(`${base}/healthz`)).status === 200);

  // past the door, the shape of what is said is checked too
  // (shared/clientSchema.ts): a message that does not fit is answered with
  // an error and dropped, and the socket stays open for the next one
  const answers = await new Promise<string[]>((resolve) => {
    const got: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { type: string; message?: string; tabs?: unknown };
      if (msg.type === "snapshot") {
        ws.send(JSON.stringify({ type: "terminal_open", projectId: "p", termId: 42, cols: 80, rows: 24 }));
        ws.send(JSON.stringify({ type: "no_such_message" }));
        ws.send(JSON.stringify({ type: "terminal_list", projectId: "p" }));
        return;
      }
      got.push(msg.type === "error" ? `error ${msg.message ?? ""}` : msg.type);
      if (got.length === 3) {
        ws.close();
        resolve(got);
      }
    });
  });
  check("wire: a field of the wrong shape is refused", answers[0]?.startsWith("error bad message: termId") === true, answers);
  check("wire: an unknown message type is refused", answers[1]?.startsWith("error bad message") === true, answers);
  check("wire: the socket stays open for the next message", answers[2] === "terminal_tabs", answers);

  const file = path.join(configDir, "token");
  check("token file: holds the token", fs.readFileSync(file, "utf8") === TOKEN);
  check("token file: readable by this user only", (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  await running.close();
  check("token file: gone after close", !fs.existsSync(file));
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
