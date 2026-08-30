/**
 * Drive the real app and take pictures of it.
 *
 * Launches ruri with an isolated config and userData dir, so it never
 * touches the installed app's sessions, attaches to its window over the
 * DevTools protocol, and runs whatever steps the caller passes.
 *
 *   bun scripts/shot.mjs <steps.mjs>
 *
 * The steps file default-exports `async (page) => {}` and gets a tiny
 * driver: click, type, key, eval, wait, shot. No browser-automation
 * dependency — Electron already speaks CDP, and `ws` is already here.
 */
import { spawn } from "node:child_process";
import * as path from "node:path";
import WebSocket from "ws";

const [, , stepFile] = process.argv;
const root = path.resolve(import.meta.dirname, "..");
const CDP_PORT = Number(process.env["RURI_CDP_PORT"] ?? 9333);

const child = spawn(
  path.join(root, "node_modules", ".bin", "electron"),
  [root, `--remote-debugging-port=${CDP_PORT}`],
  {
    cwd: root,
    env: {
      ...process.env,
      RURI_CONFIG_DIR: process.env["RURI_CONFIG_DIR"] ?? "/tmp/ruri-shot-config",
      RURI_USER_DATA: process.env["RURI_USER_DATA"] ?? "/tmp/ruri-shot-user",
      RURI_PORT: process.env["RURI_PORT"] ?? "7789",
    },
    stdio: "ignore",
  },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page target, once devtools is listening and the window exists. */
async function findPage() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // devtools not up yet
    }
    await sleep(250);
  }
  throw new Error("no page target — the window never came up");
}

const target = await findPage();
const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});

let nextId = 0;
const pending = new Map();
const listeners = new Map();
ws.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  if (message.method) {
    for (const fn of listeners.get(message.method) ?? []) fn(message.params);
    return;
  }
  const waiting = pending.get(message.id);
  if (!waiting) return;
  pending.delete(message.id);
  if (message.error) waiting.reject(new Error(JSON.stringify(message.error)));
  else waiting.resolve(message.result);
});

function cdp(method, params = {}) {
  const id = (nextId += 1);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const page = {
  async eval(expression) {
    const result = await cdp("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? "eval threw");
    }
    return result.result.value;
  },
  /** Click the first match, through a real pointer sequence at its centre. */
  async click(selector) {
    const box = await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`no element for ${selector}`);
    await page.clickAt(box.x, box.y);
  },
  async clickAt(x, y) {
    const common = { x, y, button: "left", clickCount: 1, buttons: 1 };
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await sleep(30);
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...common, buttons: 0 });
  },
  /** Where a selector's box is, in page coordinates. */
  box(selector) {
    return page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
  },
  async type(text) {
    for (const char of text) {
      await cdp("Input.dispatchKeyEvent", { type: "keyDown", text: char });
      await cdp("Input.dispatchKeyEvent", { type: "keyUp" });
    }
  },
  async key(key, code, windowsVirtualKeyCode, text) {
    await cdp("Input.dispatchKeyEvent", {
      type: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode,
      nativeVirtualKeyCode: windowsVirtualKeyCode,
      ...(text ? { text } : {}),
    });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
  },
  enter() {
    return page.key("Enter", "Enter", 13, "\r");
  },
  /** Subscribe to a CDP event — the screencast below is the reason. */
  on(method, fn) {
    const set = listeners.get(method) ?? new Set();
    set.add(fn);
    listeners.set(method, set);
    return () => set.delete(fn);
  },
  /**
   * Every frame the browser actually paints, while `during` runs. rAF is
   * throttled in a window that isn't in front, so counting frames from
   * inside the page lies; this is the compositor's own output.
   */
  async record(during, dir) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(dir, { recursive: true });
    let n = 0;
    const stop = page.on("Page.screencastFrame", (params) => {
      writeFileSync(`${dir}/${String(n++).padStart(3, "0")}.png`, Buffer.from(params.data, "base64"));
      void cdp("Page.screencastFrameAck", { sessionId: params.sessionId });
    });
    await cdp("Page.startScreencast", { format: "png", everyNthFrame: 1 });
    await during();
    await cdp("Page.stopScreencast");
    stop();
    return n;
  },
  wait: sleep,
  async shot(file) {
    const { data } = await cdp("Page.captureScreenshot", { format: "png" });
    await Bun.write(file, Buffer.from(data, "base64"));
    console.log("shot", file);
  },
  cdp,
};

try {
  if (stepFile) {
    const steps = await import(path.resolve(stepFile));
    await steps.default(page);
  } else {
    await page.shot("/tmp/ruri-shot.png");
  }
} finally {
  ws.close();
  child.kill();
}
