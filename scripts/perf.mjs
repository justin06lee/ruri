/**
 * What the page costs, measured: the built bundle in its fixture mode, in a
 * hidden Electron window, driven over the DevTools protocol while a CPU
 * profile and a timeline trace run.
 *
 *   bun run build:web && bun scripts/perf.mjs typing   # 60 keystrokes in a chat's composer
 *   bun run build:web && bun scripts/perf.mjs stream   # a 40-paragraph reply into a 36-turn chat
 *
 * `typing` reports main-thread JS per keystroke; `stream` per paragraph
 * (each arriving with a tool event and a subagent's card moving on). Both
 * report style recalcs, layouts and paints, and the functions that took
 * the most time. The fixture plays the server's part (`window.__ruriReceive`,
 * web/src/store.ts), so nothing here spends a token.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import WebSocket from "ws";

const mode = process.argv[2] ?? "stream";
const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist-web");
if (!fs.existsSync(path.join(dist, "index.html"))) {
  console.error("build the page first: bun run build:web");
  process.exit(1);
}

// the bundle, served the way the app serves it
const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".woff2": "font/woff2" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  let file = path.join(dist, decodeURIComponent(url.pathname));
  if (!file.startsWith(dist) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
    file = path.join(dist, "index.html");
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const page = `http://127.0.0.1:${server.address().port}/?fixture&awake`;

// a window that only loads the page, with the debugger port open
const shell = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-perf-"));
fs.writeFileSync(path.join(shell, "package.json"), '{"name":"ruri-perf","main":"main.cjs"}');
fs.writeFileSync(
  path.join(shell, "main.cjs"),
  `const { app, BrowserWindow } = require("electron");
app.commandLine.appendSwitch("remote-debugging-port", "9359");
app.setPath("userData", ${JSON.stringify(path.join(shell, "data"))});
app.whenReady().then(() => {
  const w = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { backgroundThrottling: false } });
  w.loadURL(${JSON.stringify(page)});
});`,
);
const electron = spawn(
  path.join(root, "node_modules", ".bin", "electron"),
  [shell, "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"],
  { stdio: "ignore" },
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const done = (code) => {
  electron.kill();
  server.close();
  fs.rmSync(shell, { recursive: true, force: true });
  process.exit(code);
};

let target;
for (let i = 0; i < 80 && !target; i++) {
  await sleep(250);
  try {
    const list = await (await fetch("http://127.0.0.1:9359/json")).json();
    target = list.find((t) => t.type === "page");
  } catch {
    // not up yet
  }
}
if (!target) {
  console.error("the window never came up");
  done(1);
}
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 1 << 30 });
await new Promise((resolve) => ws.on("open", resolve));
let seq = 0;
const pending = new Map();
const trace = [];
let traced;
const traceDone = new Promise((resolve) => (traced = resolve));
ws.on("message", (data) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Tracing.dataCollected") trace.push(...msg.params.value);
  if (msg.method === "Tracing.tracingComplete") traced();
});
const cdp = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description);
  return r.result?.result?.value;
};

await sleep(2500);
// into the fixture's first project chat
await evaluate(`(async () => {
  if (!document.querySelector('.session-row')) {
    document.querySelector('.folder-row.project-folder')?.click();
    await new Promise((r) => setTimeout(r, 400));
  }
  document.querySelector('.session-row')?.click();
  await new Promise((r) => setTimeout(r, 1000));
})()`);

if (mode === "stream") {
  // a working chat's history: 36 exchanges, through the server's door
  await evaluate(`(async () => {
    const R = window.__ruriReceive; const now = Date.now();
    const para = (i) => "The reconnect path in \`store.ts\` resets its backoff only on a clean open, so a server restart mid-turn left the client waiting the full thirty seconds. Paragraph " + i + ".";
    for (let k = 0; k < 36; k++) {
      const t = now - 3_600_000 + k * 60_000;
      R({ type: "event", projectId: "p1", event: { kind: "user", id: "u" + k, text: "Look into the reconnect logic, part " + k, ts: t } });
      for (let j = 0; j < 4; j++) R({ type: "event", projectId: "p1", event: { kind: "tool", id: "t" + k + "-" + j, name: j % 2 ? "Read" : "Grep", summary: "web/src/store.ts", ts: t + 1000 + j } });
      R({ type: "event", projectId: "p1", event: { kind: "assistant", id: "a" + k, text: [0, 1, 2, 3, 4, 5].map(para).join("\\n\\n"), ts: t + 5000 } });
      R({ type: "event", projectId: "p1", event: { kind: "result", id: "r" + k, ok: true, durationMs: 20000, ts: t + 6000 } });
    }
    await new Promise((r) => setTimeout(r, 2500));
  })()`);
}

await cdp("Profiler.enable");
await cdp("Profiler.setSamplingInterval", { interval: 100 });
await cdp("Tracing.start", {
  categories: "devtools.timeline,disabled-by-default-devtools.timeline",
  transferMode: "ReportEvents",
});
await cdp("Profiler.start");
const started = Date.now();
let units;
if (mode === "typing") {
  units = 60;
  await evaluate(`document.querySelector('.composer-box textarea')?.focus()`);
  for (let i = 0; i < units; i++) {
    const c = "the quick brown fox "[i % 20];
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: c, text: c });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: c });
    await sleep(40);
  }
} else {
  units = 40;
  await evaluate(`(async () => {
    const R = window.__ruriReceive; const now = Date.now();
    R({ type: "event", projectId: "p1", event: { kind: "user", id: "live-u", text: "Now make the retry visible", ts: now } });
    R({ type: "status", projectId: "p1", status: "working" });
    for (let i = 0; i < ${units}; i++) {
      const p = i % 7 === 3
        ? "\`\`\`ts\\nexport function retryIn(attempt: number): number {\\n  return Math.min(30_000, 500 * 2 ** attempt);\\n}\\n\`\`\`"
        : "Paragraph " + i + ": the banner reads the store's \`retryAt\` and counts down with the shared clock, and disappears the moment the socket opens again — **no flash** on a quick reconnect.";
      R({ type: "delta", projectId: "p1", messageId: "live-a", delta: p + "\\n\\n" });
      if (i % 4 === 1) R({ type: "event", projectId: "p1", event: { kind: "tool", id: "live-t" + i, name: "Edit", summary: "web/src/components/Banner.tsx", ts: Date.now() } });
      R({ type: "event", projectId: "p1", event: { kind: "tool", id: "e5b", name: "Agent", summary: "Run the whole suite", agent: { key: "toolu_fixture_2", type: "general-purpose", description: "Run the whole suite", prompt: "Run every test", status: "running", background: true, activity: "Bash bun run test " + i, tokens: 12400 + i * 300, tools: 7 + i, startedAt: now - 40000 }, ts: now - 40000 } });
      await new Promise((r) => setTimeout(r, 120));
    }
    R({ type: "event", projectId: "p1", event: { kind: "assistant", id: "live-a", text: "done", ts: Date.now() } });
  })()`);
}
const wall = Date.now() - started;
const {
  result: { profile },
} = await cdp("Profiler.stop");
await cdp("Tracing.end");
await traceDone;

const unit = mode === "typing" ? "keystroke" : "paragraph";
const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const self = new Map();
let busy = 0;
profile.samples.forEach((id, i) => {
  const frame = nodes.get(id).callFrame;
  const ms = (profile.timeDeltas[i] ?? 0) / 1000;
  if (frame.functionName === "(idle)" || frame.functionName === "(program)") return;
  busy += ms;
  const key = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop()}:${frame.lineNumber + 1}`;
  self.set(key, (self.get(key) ?? 0) + ms);
});
console.log(`${mode}: ${units} ${unit}s in ${wall} ms`);
console.log(`  main-thread JS  ${(busy / units).toFixed(2)} ms per ${unit}`);
for (const name of ["UpdateLayoutTree", "Layout", "Paint"]) {
  const events = trace.filter((e) => e.name === name && e.ph === "X");
  const ms = events.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000;
  const label = { UpdateLayoutTree: "style recalc", Layout: "layout", Paint: "paint" }[name];
  console.log(`  ${label.padEnd(15)} ${(ms / units).toFixed(2)} ms per ${unit} (${events.length} of them)`);
}
console.log("  most time, by function (self):");
for (const [key, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 12))
  console.log(`    ${ms.toFixed(1).padStart(8)} ms  ${key}`);
done(0);
