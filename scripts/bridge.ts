/**
 * End-to-end test of the bridge, over its HTTP face.
 *
 * Serves a tiny page on a port of its own, boots the real desktop app the
 * way scripts/shot.mjs does (isolated config, userData and port, so the
 * installed ruri.app is never touched), makes a project over the WebSocket
 * so there is a real session id to drive through, and then works the
 * bridge the way a non-Claude harness would — POST /bridge/<channelId> —
 * asserting on every answer:
 *
 *   tier 1: web_open → web_click by text → web_wait_for text → web_type
 *           into the input → web_screenshot → web_logs → web_close
 *   tier 2: app_launch TextEdit (open -g) → app_ui_tree → app_ui typing
 *           into the document → app_screenshot → app_quit
 *
 * The tier-2 pass needs macOS to have granted Accessibility and Screen
 * Recording to whatever is responsible for this process; when it hasn't,
 * that pass is skipped with a line saying so rather than failed.
 *
 *   bun run bridge-test
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";
import type { BridgeState, ClientMessage, ServerMessage } from "../shared/protocol.js";

const root = path.resolve(import.meta.dirname, "..");
const PORT = Number(process.env["RURI_PORT"] ?? 7793);
const CDP_PORT = Number(process.env["RURI_CDP_PORT"] ?? 9343);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-bridge-config-"));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-bridge-user-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-bridge-project-"));

/* ── the page under test ────────────────────────────────────────── */

const PAGE = `<!doctype html>
<html><head><title>Bridge fixture</title></head>
<body>
  <h1 id="headline">Untouched</h1>
  <form onsubmit="event.preventDefault(); document.getElementById('echo').textContent = 'You typed: ' + document.getElementById('name').value;">
    <input id="name" placeholder="your name" />
    <button type="submit">Say it</button>
  </form>
  <button id="flip" onclick="document.getElementById('headline').textContent = 'Flipped'; console.log('flipped the headline')">Flip the headline</button>
  <a id="away" href="/second">Go to the second page</a>
  <p id="echo"></p>
  <script>fetch('/ping').then(r => r.text()).then(t => console.info('ping said', t));</script>
</body></html>`;

const SECOND = `<!doctype html><html><head><title>Second page</title></head><body><h1>The second page</h1><a href="/">back</a></body></html>`;

const site = http.createServer((req, res) => {
  if (req.url === "/ping") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pong");
    return;
  }
  if (req.url === "/missing") {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url === "/second" ? SECOND : PAGE);
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
const siteAddress = site.address();
const SITE = `http://127.0.0.1:${typeof siteAddress === "object" && siteAddress ? siteAddress.port : 0}`;

/* ── the app ────────────────────────────────────────────────────── */

const child = spawn(path.join(root, "node_modules", ".bin", "electron"), [root, `--remote-debugging-port=${CDP_PORT}`], {
  cwd: root,
  env: {
    ...process.env,
    RURI_CONFIG_DIR: configDir,
    RURI_USER_DATA: userData,
    RURI_PORT: String(PORT),
    RURI_NO_MEMORY: "1",
  },
  stdio: "ignore",
});

let failed = 0;
let passed = 0;
const notes: string[] = [];

function cleanup(code: number): never {
  child.kill("SIGINT");
  setTimeout(() => child.kill("SIGKILL"), 3_000).unref();
  site.close();
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}

const deadline = setTimeout(() => {
  console.error("BRIDGE FAIL: timed out");
  cleanup(1);
}, 240_000);
deadline.unref();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(): Promise<void> {
  for (let i = 0; i < 240; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/healthz`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  console.error("BRIDGE FAIL: the app never answered /healthz");
  cleanup(1);
}

await waitHealthy();
console.log(`[test] ruri up on :${PORT}, fixture site on ${SITE}`);

/* ── a session to drive through ─────────────────────────────────── */

const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
await new Promise<void>((resolve, reject) => {
  ws.once("open", () => resolve());
  ws.once("error", reject);
});
const bridgeEvents: Array<{ projectId: string; state: BridgeState | null }> = [];
let channelId: string | undefined;
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" || msg.type === "snapshot") {
    const project = msg.projects.find((p) => p.path === projectDir);
    channelId ??= project?.sessions[0]?.id;
  }
  if (msg.type === "bridge") bridgeEvents.push({ projectId: msg.projectId, state: msg.state });
});
ws.send(JSON.stringify({ type: "add_project", name: "bridge-fixture", path: projectDir } satisfies ClientMessage));
for (let i = 0; i < 40 && !channelId; i += 1) await sleep(100);
if (!channelId) {
  console.error("BRIDGE FAIL: add_project never produced a session");
  cleanup(1);
}
console.log(`[test] channel ${channelId}`);

/* ── the bridge, over HTTP ──────────────────────────────────────── */

interface Reply {
  ok: boolean;
  text?: string;
  image?: string;
  error?: string;
}

async function call(tool: string, args: Record<string, unknown> = {}, id = channelId): Promise<Reply> {
  const res = await fetch(`http://127.0.0.1:${PORT}/bridge/${id}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, args }),
  });
  return (await res.json()) as Reply;
}

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function isPng(file: string | undefined): boolean {
  if (!file || !fs.existsSync(file)) return false;
  const head = fs.readFileSync(file).subarray(0, 8);
  return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

console.log("[tier 1] the hidden window");
{
  const gone = await call("web_open", { url: SITE }, "not-a-session");
  check("unknown channel is refused", !gone.ok && /no such session/.test(gone.error ?? ""), gone.error);

  const bad = await call("web_click", {});
  check("a call before web_open says so", !bad.ok && /web_open/.test(bad.error ?? ""), bad.error);

  const open = await call("web_open", { url: SITE });
  check("web_open loads the page", open.ok && /Bridge fixture/.test(open.text ?? ""), open.error ?? open.text);
  check("web_open returns a picture", isPng(open.image), open.image);

  const refused = await call("web_open", { url: "http://127.0.0.1:1/" });
  check("web_open reports a failed load readably", !refused.ok && /ERR_CONNECTION_REFUSED|couldn't load/.test(refused.error ?? ""), refused.error);

  const back = await call("web_open", { url: SITE });
  check("web_open again", back.ok, back.error);

  const click = await call("web_click", { text: "flip the headline" });
  check("web_click by text", click.ok && /Clicked button/.test(click.text ?? ""), click.error ?? click.text);

  const waited = await call("web_wait_for", { text: "Flipped", timeoutMs: 5000 });
  check("web_wait_for sees the flipped headline", waited.ok && /Flipped/.test(waited.text ?? ""), waited.error ?? waited.text);

  const typed = await call("web_type", { selector: "#name", text: "Ruri\n" });
  check("web_type into the input and Enter submits", typed.ok, typed.error);
  const echoed = await call("web_wait_for", { text: "You typed: Ruri", timeoutMs: 5000 });
  check("the form saw every character", echoed.ok, echoed.error);

  const value = await call("web_eval", { js: "document.getElementById('name').value" });
  check("web_eval reads the input back", value.ok && value.text === "Ruri", value.text ?? value.error);

  const chord = await call("web_press", { key: "Meta+A" });
  check("web_press takes a chord", chord.ok, chord.error);
  await call("web_type", { text: "Aoki" });
  const replaced = await call("web_eval", { js: "document.getElementById('name').value" });
  check("Meta+A selected the field, so typing replaced it", replaced.ok && replaced.text === "Aoki", replaced.text ?? replaced.error);

  const shot = await call("web_screenshot", { selector: "#headline" });
  check("web_screenshot of one element", shot.ok && isPng(shot.image) && /Saved \d+x\d+ PNG/.test(shot.text ?? ""), shot.error ?? shot.text);
  const full = await call("web_screenshot", { full: true });
  check("web_screenshot of the whole document", full.ok && isPng(full.image), full.error);

  // awaited, so CDP records the 404 rather than seeing an unawaited fetch
  // get canceled when the eval returns
  await call("web_eval", { js: "fetch('/missing').then(r => r.status)" });
  await sleep(300);
  const logs = await call("web_logs", { kind: "all" });
  check("web_logs has the console line", logs.ok && /flipped the headline/.test(logs.text ?? ""), logs.text?.slice(0, 300));
  check("web_logs has the network lines", /GET .*\/ping → 200/.test(logs.text ?? "") && /\/missing → 404/.test(logs.text ?? ""), (logs.text ?? "").split("network")[1]?.slice(0, 400));

  const link = await call("web_click", { text: "second page" });
  check("web_click follows a link", link.ok, link.error);
  const there = await call("web_wait_for", { url: "/second", timeoutMs: 5000 });
  check("web_wait_for url", there.ok, there.error);
  const where = await call("web_where");
  check("web_where says where", where.ok && /\/second/.test(where.text ?? "") && /hidden from the user/.test(where.text ?? ""), where.text ?? where.error);

  const scrolled = await call("web_scroll", { dy: 200 });
  check("web_scroll answers", scrolled.ok, scrolled.error);

  const idle = await call("web_wait_for", { idle: true, timeoutMs: 5000 });
  check("web_wait_for idle", idle.ok, idle.error);

  const closed = await call("web_close");
  check("web_close", closed.ok, closed.error);
  const after = await call("web_where");
  check("nothing open after close", !after.ok, after.text);
}

await sleep(400);
{
  const forThis = bridgeEvents.filter((e) => e.projectId === channelId);
  const withPreview = forThis.find((e) => e.state?.kind === "web" && e.state.previewUrl);
  check("the strip was told about the page", withPreview !== undefined, `${forThis.length} bridge events`);
  const last = forThis.at(-1);
  check("the strip was told the window closed", last?.state === null, JSON.stringify(last?.state));
  if (withPreview?.state?.previewUrl) {
    const res = await fetch(`http://127.0.0.1:${PORT}${withPreview.state.previewUrl}`);
    check("the preview is served", res.ok && res.headers.get("content-type") === "image/png", String(res.status));
  }
}

console.log("[tier 2] a native app");
{
  const doc = path.join(projectDir, "bridge-note.txt");
  fs.writeFileSync(doc, "Hello.\n");
  const launched = await call("app_launch", { app: "TextEdit", args: [doc] });
  if (!launched.ok) {
    check("app_launch TextEdit", false, launched.error);
  } else {
    const handle = /"handle":"([^"]+)"/.exec(launched.text ?? "")?.[1];
    check("app_launch answers with a native handle", /"kind":"native"/.test(launched.text ?? "") && handle !== undefined, launched.text);
    const listed = await call("app_list");
    check("app_list shows it", listed.ok && new RegExp(`${handle}: native TextEdit`).test(listed.text ?? ""), listed.text);

    await sleep(800);
    const tree = await call("app_ui_tree", { handle, depth: 5 });
    if (!tree.ok && /Accessibility|Automation/.test(tree.error ?? "")) {
      notes.push(`tier 2 UI scripting skipped: ${tree.error}`);
      console.log(`  skip app_ui_tree / app_ui — ${tree.error}`);
    } else {
      check("app_ui_tree walks the window", tree.ok && /AXWindow/.test(tree.text ?? "") && /AXTextArea/.test(tree.text ?? ""), tree.error ?? tree.text?.slice(0, 300));
      const typed = await call("app_ui", { handle, script: 'set value of text area 1 of scroll area 1 of window 1 to "Typed through the bridge."' });
      check("app_ui sets the document text", typed.ok, typed.error);
      const read = await call("app_ui", { handle, script: "get value of text area 1 of scroll area 1 of window 1" });
      check("app_ui reads it back", read.ok && /Typed through the bridge/.test(read.text ?? ""), read.error ?? read.text);
    }

    const shot = await call("app_screenshot", { handle });
    if (!shot.ok && /Screen Recording/.test(shot.error ?? "")) {
      notes.push(`tier 2 screenshot skipped: ${shot.error}`);
      console.log(`  skip app_screenshot — ${shot.error}`);
    } else {
      check("app_screenshot photographs the window", shot.ok && isPng(shot.image) && /TextEdit/.test(shot.text ?? ""), shot.error ?? shot.text);
    }

    const quit = await call("app_quit", { handle });
    check("app_quit", quit.ok, quit.error);
    await sleep(1500);
    const gone = await call("app_list");
    check("app_list is empty after quit", gone.ok && /nothing launched/.test(gone.text ?? ""), gone.text);
  }
}

console.log("[tier 2] an Electron app");
{
  const mainFile = path.join(projectDir, "main.cjs");
  fs.writeFileSync(
    mainFile,
    `const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 640, height: 480, title: "Bridge target" });
  win.loadURL(${JSON.stringify(SITE)});
});
app.on("window-all-closed", () => app.quit());
`,
  );
  const launched = await call("app_launch", {
    command: path.join(root, "node_modules", ".bin", "electron"),
    args: [mainFile],
    cwd: projectDir,
  });
  if (!launched.ok) {
    check("app_launch an Electron app", false, launched.error);
  } else {
    const handle = /"handle":"([^"]+)"/.exec(launched.text ?? "")?.[1];
    check("app_launch answers with an electron handle", /"kind":"electron"/.test(launched.text ?? "") && handle !== undefined, launched.text);
    check("app_launch returns a picture of it", isPng(launched.image), launched.image);
    const ready = await call("app_wait_for", { handle, text: "Untouched", timeoutMs: 10000 });
    check("app_wait_for sees the page", ready.ok, ready.error);
    const click = await call("app_click", { handle, selector: "#flip" });
    check("app_click by selector", click.ok, click.error);
    const flipped = await call("app_eval", { handle, js: "document.getElementById('headline').textContent" });
    check("app_eval reads the flipped headline", flipped.ok && flipped.text === "Flipped", flipped.text ?? flipped.error);
    const typed = await call("app_type", { handle, selector: "#name", text: "Electron" });
    check("app_type", typed.ok, typed.error);
    const value = await call("app_eval", { handle, js: "document.getElementById('name').value" });
    check("the input took the text", value.ok && value.text === "Electron", value.text ?? value.error);
    const logs = await call("app_logs", { handle, kind: "console" });
    check("app_logs", logs.ok && /flipped the headline/.test(logs.text ?? ""), logs.text?.slice(0, 200));
    const shot = await call("app_screenshot", { handle, selector: "#headline" });
    check("app_screenshot of one element", shot.ok && isPng(shot.image), shot.error);
    const front = await fetch(`http://127.0.0.1:${PORT}/healthz`).then((r) => r.ok);
    check("ruri is still answering", front);
    const quit = await call("app_quit", { handle });
    check("app_quit closes it", quit.ok, quit.error);
  }
}

clearTimeout(deadline);
ws.close();
for (const note of notes) console.log(`[note] ${note}`);
console.log(`\n${failed === 0 ? "BRIDGE PASS" : "BRIDGE FAIL"}: ${passed} passed, ${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
