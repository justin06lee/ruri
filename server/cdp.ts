import * as net from "node:net";
import WebSocket from "ws";

/**
 * Driving a page over the DevTools protocol.
 *
 * Both halves of the bridge come down to the same wire. A page in ruri's own
 * hidden window is reached through Electron's `webContents.debugger`; a
 * dev-built Electron app the session launched is reached over a WebSocket to
 * the `--remote-debugging-port` it was started with. Either way the verbs
 * are Chrome's — Input.dispatchMouseEvent, Runtime.evaluate,
 * Page.captureScreenshot — and so the driver is written once, against the
 * smallest possible picture of a connection (`CdpLink`), and each tier
 * supplies its own.
 *
 * Nothing in here knows about Electron, sessions or the config dir, which
 * is what lets it live on the server side and be exercised without a
 * window.
 */

/** What a driver needs from whatever speaks CDP for it: send a command,
 *  hear an event. Electron's debugger and a raw socket both fit. */
export interface CdpLink {
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to one event; the return value unsubscribes. */
  on(method: string, listener: (params: Record<string, unknown>) => void): () => void;
}

/** A CDP connection over `ws`, for apps started with a debugging port. */
export class CdpSocket implements CdpLink {
  private readonly ws: WebSocket;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
  private closed = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      let message: {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message?: string };
      };
      try {
        message = JSON.parse(raw.toString()) as typeof message;
      } catch {
        return;
      }
      if (message.method) {
        for (const fn of this.listeners.get(message.method) ?? []) fn(message.params ?? {});
        return;
      }
      if (message.id === undefined) return;
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiting.resolve(message.result);
    });
    ws.on("close", () => {
      this.closed = true;
      for (const waiting of this.pending.values()) waiting.reject(new Error("the app closed the connection"));
      this.pending.clear();
    });
    ws.on("error", () => {
      // surfaces as the close above
    });
  }

  static connect(url: string): Promise<CdpSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
      ws.once("open", () => resolve(new CdpSocket(ws)));
      ws.once("error", (error) => reject(error));
    });
  }

  get alive(): boolean {
    return !this.closed;
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("the app is no longer connected"));
    const id = (this.nextId += 1);
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(listener);
    this.listeners.set(method, set);
    return () => {
      set.delete(listener);
    };
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // already gone
    }
  }
}

/** A port nobody is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface PageTarget {
  webSocketDebuggerUrl: string;
  title: string;
  url: string;
}

/** The first page target a debugging port offers, once it is listening. */
export async function findPageTarget(port: number, timeoutMs: number): Promise<PageTarget> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const list = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
        title?: string;
        url?: string;
      }>;
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) {
        return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, title: page.title ?? "", url: page.url ?? "" };
      }
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error(`no page target on port ${port} after ${Math.round(timeoutMs / 1000)}s — did the app start with --remote-debugging-port?`);
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ── what the page said and fetched ─────────────────────────────── */

export interface ConsoleEntry {
  at: number;
  level: string;
  text: string;
  /** `url:line` of whoever logged it, when known. */
  source?: string;
}

export interface NetworkEntry {
  at: number;
  method: string;
  url: string;
  status?: number;
  failed?: string;
}

/** How many entries of each kind are kept: enough to read a session's
 *  worth back, small enough that a chatty page never costs memory. */
const RING = 500;

/** Kept newest-last, never longer than RING. */
class Ring<T> {
  readonly items: T[] = [];
  push(item: T): void {
    this.items.push(item);
    if (this.items.length > RING) this.items.splice(0, this.items.length - RING);
  }
  clear(): void {
    this.items.length = 0;
  }
}

/* ── finding things on the page ─────────────────────────────────── */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Runs inside the page: find one element by selector, bring it into
 *  view, and say where it is. Null when it isn't there or has no size. */
function locateScript(selector: string): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || style.visibility === "hidden" || style.display === "none") return { hidden: true };
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`;
}

/**
 * Runs inside the page: the element a person would mean by some words.
 * Things made to be clicked are preferred, an exact match beats a
 * substring, and among the rest the smallest wins — the button, not the
 * form it sits in.
 */
function locateTextScript(text: string): string {
  return `(() => {
    const needle = ${JSON.stringify(text)}.trim().toLowerCase();
    if (!needle) return null;
    const clickable = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], label, summary, input[type="submit"], input[type="button"], input[type="reset"], option, [onclick]';
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== "hidden" && s.display !== "none" && s.pointerEvents !== "none";
    };
    const own = (el) => {
      if (el instanceof HTMLInputElement) return (el.value || el.getAttribute("aria-label") || "").trim();
      return (el.innerText || el.textContent || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim();
    };
    let best = null;
    for (const el of document.querySelectorAll("body *")) {
      if (!visible(el)) continue;
      const words = own(el).toLowerCase();
      if (!words || !words.includes(needle) || words.length > needle.length + 200) continue;
      const r = el.getBoundingClientRect();
      const score = [
        el.matches(clickable) ? 0 : 1,
        words === needle ? 0 : 1,
        r.width * r.height,
      ];
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && (score[1] < best.score[1] || (score[1] === best.score[1] && score[2] < best.score[2])))) {
        best = { el, score };
      }
    }
    if (!best) return null;
    best.el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = best.el.getBoundingClientRect();
    const tag = best.el.tagName.toLowerCase();
    return { x: r.left, y: r.top, width: r.width, height: r.height, what: tag + (best.el.id ? "#" + best.el.id : "") };
  })()`;
}

/* ── keys ───────────────────────────────────────────────────────── */

interface KeyDef {
  key: string;
  code: string;
  vk: number;
  /** What it types, when it types something. */
  text?: string;
}

/** Keys with names, as people write them. */
const NAMED_KEYS: Record<string, KeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

/** Modifier names → CDP's bit flags. */
const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

/**
 * The editing commands the platform would run for a chord. A key event
 * dispatched over CDP goes to the page, not through the browser's own
 * shortcut handling, so ⌘A on its own selects nothing; naming the command
 * gets the editor to do what the chord means.
 */
const MAC_COMMANDS: Record<string, string> = {
  "meta+a": "selectAll",
  "meta+c": "copy",
  "meta+v": "paste",
  "meta+x": "cut",
  "meta+z": "undo",
  "meta+shift+z": "redo",
  "meta+arrowleft": "moveToBeginningOfLine",
  "meta+arrowright": "moveToEndOfLine",
  "meta+arrowup": "moveToBeginningOfDocument",
  "meta+arrowdown": "moveToEndOfDocument",
  "meta+backspace": "deleteToBeginningOfLine",
  "alt+backspace": "deleteWordBackward",
  "alt+arrowleft": "moveWordLeft",
  "alt+arrowright": "moveWordRight",
  "shift+arrowleft": "moveLeftAndModifySelection",
  "shift+arrowright": "moveRightAndModifySelection",
  "shift+arrowup": "moveUpAndModifySelection",
  "shift+arrowdown": "moveDownAndModifySelection",
};

/** A chord as typed ("Meta+Shift+A", "Enter") into the parts CDP wants. */
export function parseChord(
  chord: string,
  extraModifiers: string[] = [],
): { def: KeyDef; modifiers: number; commands: string[] } {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const keyPart = parts.pop() ?? "";
  const names = [...parts, ...extraModifiers].map((m) => m.toLowerCase());
  let modifiers = 0;
  for (const name of names) {
    const bit = MODIFIER_BITS[name];
    if (bit === undefined) throw new Error(`unknown modifier "${name}" (use Meta, Ctrl, Alt, Shift)`);
    modifiers |= bit;
  }
  const lower = keyPart.toLowerCase();
  let def = NAMED_KEYS[lower];
  if (!def) {
    const fn = /^f(\d{1,2})$/.exec(lower);
    if (fn?.[1]) {
      const n = Number(fn[1]);
      def = { key: `F${n}`, code: `F${n}`, vk: 111 + n };
    } else if (keyPart.length === 1) {
      const char = keyPart;
      const upper = char.toUpperCase();
      if (/[a-z]/i.test(char)) {
        const shifted = (modifiers & 8) !== 0 || char === upper;
        def = { key: shifted ? upper : char.toLowerCase(), code: `Key${upper}`, vk: upper.charCodeAt(0), text: shifted ? upper : char.toLowerCase() };
      } else if (/[0-9]/.test(char)) {
        def = { key: char, code: `Digit${char}`, vk: char.charCodeAt(0), text: char };
      } else {
        def = { key: char, code: "", vk: 0, text: char };
      }
    } else {
      throw new Error(`unknown key "${keyPart}"`);
    }
  }
  const mods = ["meta", "ctrl", "alt", "shift"].filter((m) => (modifiers & MODIFIER_BITS[m]!) !== 0);
  const canonical = [...mods, def.key.toLowerCase()].join("+");
  const command = MAC_COMMANDS[canonical];
  return { def, modifiers, commands: command ? [command] : [] };
}

/* ── the driver ─────────────────────────────────────────────────── */

/** What each wait-for call may ask for. */
export interface WaitCondition {
  selector?: string;
  text?: string;
  url?: string;
  idle?: boolean;
}

/** How long a page gets to go quiet on the network before it is "idle". */
const IDLE_MS = 500;
/** How often a wait looks again. */
const POLL_MS = 150;
/** How long a screenshot may take before it is taken to be never. */
const SCREENSHOT_TIMEOUT_MS = 10_000;

/**
 * One page, driven. Holds the console and network rings for it from the
 * moment `enable()` runs, and does everything through the link it was
 * given — it never learns which tier it belongs to.
 */
export class PageDriver {
  readonly console = new Ring<ConsoleEntry>();
  readonly network = new Ring<NetworkEntry>();
  private readonly inflight = new Map<string, NetworkEntry>();
  private quietSince = Date.now();
  private readonly unsubscribe: Array<() => void> = [];

  constructor(readonly link: CdpLink) {}

  /** Turn the domains on and start listening. Call once. */
  async enable(): Promise<void> {
    this.unsubscribe.push(
      this.link.on("Runtime.consoleAPICalled", (params) => {
        const p = params as {
          type?: string;
          args?: Array<{ value?: unknown; description?: string; type?: string }>;
          stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> };
        };
        const text = (p.args ?? [])
          .map((arg) => (arg.value !== undefined ? stringify(arg.value) : (arg.description ?? arg.type ?? "")))
          .join(" ");
        const frame = p.stackTrace?.callFrames?.[0];
        this.console.push({
          at: Date.now(),
          level: p.type === "warning" ? "warn" : (p.type ?? "log"),
          text,
          ...(frame?.url ? { source: `${frame.url}:${(frame.lineNumber ?? 0) + 1}` } : {}),
        });
      }),
      this.link.on("Runtime.exceptionThrown", (params) => {
        const p = params as {
          exceptionDetails?: {
            text?: string;
            url?: string;
            lineNumber?: number;
            exception?: { description?: string };
          };
        };
        const d = p.exceptionDetails;
        this.console.push({
          at: Date.now(),
          level: "error",
          text: d?.exception?.description ?? d?.text ?? "uncaught exception",
          ...(d?.url ? { source: `${d.url}:${(d.lineNumber ?? 0) + 1}` } : {}),
        });
      }),
      this.link.on("Network.requestWillBeSent", (params) => {
        const p = params as { requestId?: string; request?: { method?: string; url?: string } };
        if (!p.requestId) return;
        const entry: NetworkEntry = {
          at: Date.now(),
          method: p.request?.method ?? "GET",
          url: p.request?.url ?? "",
        };
        this.inflight.set(p.requestId, entry);
        this.network.push(entry);
      }),
      this.link.on("Network.responseReceived", (params) => {
        const p = params as { requestId?: string; response?: { status?: number } };
        const entry = p.requestId ? this.inflight.get(p.requestId) : undefined;
        if (entry && p.response?.status !== undefined) entry.status = p.response.status;
      }),
      this.link.on("Network.loadingFinished", (params) => this.settle((params as { requestId?: string }).requestId)),
      this.link.on("Network.loadingFailed", (params) => {
        const p = params as { requestId?: string; errorText?: string; canceled?: boolean };
        const entry = p.requestId ? this.inflight.get(p.requestId) : undefined;
        // a request that already got its response and was then canceled — a
        // fetch whose body nobody read — is a completed request, not a
        // failed one; only a request that never got a status really failed
        if (entry && entry.status === undefined) entry.failed = p.canceled ? "canceled" : (p.errorText ?? "failed");
        this.settle(p.requestId);
      }),
    );
    await this.link.send("Page.enable");
    await this.link.send("Runtime.enable");
    await this.link.send("Network.enable");
  }

  private settle(requestId: string | undefined): void {
    if (!requestId) return;
    this.inflight.delete(requestId);
    if (this.inflight.size === 0) this.quietSince = Date.now();
  }

  /** True when nothing has been in flight for IDLE_MS. */
  get idle(): boolean {
    return this.inflight.size === 0 && Date.now() - this.quietSince >= IDLE_MS;
  }

  /** The page moved on: what was in flight for the old one no longer counts. */
  reset(): void {
    this.inflight.clear();
    this.quietSince = Date.now();
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  /** Evaluate an expression in the page and bring the value back. */
  async eval<T = unknown>(expression: string): Promise<T> {
    const result = await this.link.send<{
      result?: { value?: unknown; description?: string; type?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "the script threw");
    }
    return result.result?.value as T;
  }

  /** Where the page is: URL, title, and the viewport in CSS pixels. */
  where(): Promise<{ url: string; title: string; width: number; height: number }> {
    return this.eval("({ url: location.href, title: document.title, width: innerWidth, height: innerHeight })");
  }

  /** The rectangle of one selector, scrolled into view. Throws when it
   *  isn't on the page or has no size. */
  async locate(selector: string): Promise<Rect> {
    const found = await this.eval<(Rect & { hidden?: boolean }) | null>(locateScript(selector));
    if (!found) throw new Error(`nothing matches "${selector}"`);
    if (found.hidden) throw new Error(`"${selector}" is on the page but not visible`);
    return found;
  }

  /** Click by selector, by the words on the thing, or at a point. */
  async click(target: { selector?: string; text?: string; x?: number; y?: number }): Promise<string> {
    let x: number;
    let y: number;
    let what: string;
    if (target.selector) {
      const r = await this.locate(target.selector);
      x = r.x + r.width / 2;
      y = r.y + r.height / 2;
      what = target.selector;
    } else if (target.text) {
      const found = await this.eval<(Rect & { what: string }) | null>(locateTextScript(target.text));
      if (!found) throw new Error(`nothing on the page says "${target.text}"`);
      x = found.x + found.width / 2;
      y = found.y + found.height / 2;
      what = `${found.what} "${target.text}"`;
    } else if (target.x !== undefined && target.y !== undefined) {
      x = target.x;
      y = target.y;
      what = `(${x}, ${y})`;
    } else {
      throw new Error("give a selector, text, or x and y");
    }
    await this.clickAt(x, y);
    return what;
  }

  /** A real pointer: move, press, release, at page coordinates. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.link.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
    await this.link.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(40);
    await this.link.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
  }

  /** Focus a selector (when given) and type the text as key events, so a
   *  controlled input sees every character. A newline presses Enter. */
  async type(text: string, selector?: string): Promise<void> {
    if (selector) {
      const r = await this.locate(selector);
      // a click, not el.focus(): the page's own handlers run, and the caret
      // lands where a person's would
      await this.clickAt(r.x + r.width / 2, r.y + r.height / 2);
      await sleep(40);
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const char of line) {
        await this.link.send("Input.dispatchKeyEvent", { type: "keyDown", text: char, unmodifiedText: char, key: char });
        await this.link.send("Input.dispatchKeyEvent", { type: "keyUp", key: char });
      }
      if (i < lines.length - 1) await this.press("Enter");
    }
  }

  /** One chord: "Enter", "Escape", "Meta+A", "Shift+Tab". */
  async press(chord: string, modifiers: string[] = []): Promise<void> {
    const { def, modifiers: bits, commands } = parseChord(chord, modifiers);
    // a printable key with nothing but shift held types its character
    const types = def.text !== undefined && (bits & ~8) === 0;
    const base = {
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.vk,
      nativeVirtualKeyCode: def.vk,
      modifiers: bits,
    };
    await this.link.send("Input.dispatchKeyEvent", {
      ...base,
      type: types ? "keyDown" : "rawKeyDown",
      ...(types ? { text: def.text, unmodifiedText: def.text } : {}),
      ...(commands.length ? { commands } : {}),
    });
    await this.link.send("Input.dispatchKeyEvent", { ...base, type: "keyUp" });
  }

  /** A wheel gesture over an element, or over the middle of the page. */
  async scroll(target: { selector?: string; dx?: number; dy?: number }): Promise<void> {
    let x: number;
    let y: number;
    if (target.selector) {
      const r = await this.locate(target.selector);
      x = r.x + r.width / 2;
      y = r.y + r.height / 2;
    } else {
      const { width, height } = await this.where();
      x = width / 2;
      y = height / 2;
    }
    const dx = target.dx ?? 0;
    const dy = target.dy ?? (target.dx === undefined ? 500 : 0);
    await this.link.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
    await sleep(120);
  }

  /** A PNG of the viewport, of one element's rectangle (padded), or of the
   *  whole document. Device pixels — full resolution on a retina screen. */
  async screenshot(opts: { selector?: string; full?: boolean; pad?: number } = {}): Promise<Buffer> {
    const params: Record<string, unknown> = { format: "png" };
    if (opts.selector) {
      const r = await this.locate(opts.selector);
      const pad = opts.pad ?? 0;
      const x = Math.max(0, Math.floor(r.x - pad));
      const y = Math.max(0, Math.floor(r.y - pad));
      params["clip"] = { x, y, width: Math.ceil(r.width + pad * 2), height: Math.ceil(r.height + pad * 2), scale: 1 };
      params["captureBeyondViewport"] = true;
    } else if (opts.full) {
      const metrics = await this.link.send<{ cssContentSize?: { width: number; height: number } }>("Page.getLayoutMetrics");
      const size = metrics.cssContentSize;
      if (size) {
        params["clip"] = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 };
        params["captureBeyondViewport"] = true;
      }
    }
    // a page that paints no frame — a window hidden by its own app — would
    // hold this forever; a picture that isn't coming is an answer too
    const outcome = await Promise.race([
      this.link.send<{ data: string }>("Page.captureScreenshot", params),
      sleep(SCREENSHOT_TIMEOUT_MS).then(() => undefined),
    ]);
    if (!outcome) throw new Error("the page produced no frame to photograph — its window may be hidden or minimised");
    return Buffer.from(outcome.data, "base64");
  }

  /** Poll until the condition holds. Answers with what was met; throws
   *  with what wasn't when time runs out. */
  async waitFor(cond: WaitCondition, timeoutMs: number): Promise<string> {
    const until = Date.now() + timeoutMs;
    let last = "";
    for (;;) {
      try {
        if (cond.selector) {
          const found = await this.eval<(Rect & { hidden?: boolean }) | null>(locateScript(cond.selector));
          if (found && !found.hidden) return `"${cond.selector}" is on the page`;
          last = found ? `"${cond.selector}" is there but hidden` : `"${cond.selector}" never appeared`;
        } else if (cond.text) {
          const needle = cond.text.toLowerCase();
          const has = await this.eval<boolean>(
            `(document.body ? document.body.innerText : "").toLowerCase().includes(${JSON.stringify(needle)})`,
          );
          if (has) return `the page says "${cond.text}"`;
          last = `the page never said "${cond.text}"`;
        } else if (cond.url) {
          const href = await this.eval<string>("location.href");
          const re = /^\/(.+)\/([a-z]*)$/.exec(cond.url);
          const hit = re?.[1] ? new RegExp(re[1], re[2]).test(href) : href.includes(cond.url);
          if (hit) return `the URL is ${href}`;
          last = `the URL stayed ${href}`;
        } else if (cond.idle) {
          if (this.idle) return "the network went quiet";
          last = `${this.inflight.size} request(s) still in flight`;
        } else {
          throw new Error("give a selector, text, url, or idle: true");
        }
      } catch (err) {
        // a page mid-navigation has no document to ask — look again
        last = err instanceof Error ? err.message : String(err);
        if (last.startsWith("give a ")) throw err;
      }
      if (Date.now() >= until) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s: ${last}`);
      await sleep(POLL_MS);
    }
  }

  /** What was logged and fetched, as lines. */
  logs(kind: "console" | "network" | "all", clear = false): string {
    const out: string[] = [];
    if (kind !== "network") {
      out.push(`console (${this.console.items.length}):`);
      for (const e of this.console.items) {
        out.push(`  [${e.level}] ${e.text}${e.source ? `  (${e.source})` : ""}`);
      }
    }
    if (kind !== "console") {
      out.push(`network (${this.network.items.length}):`);
      for (const e of this.network.items) {
        const outcome = e.failed ? `FAILED ${e.failed}` : e.status !== undefined ? String(e.status) : "…";
        out.push(`  ${e.method} ${e.url} → ${outcome}`);
      }
    }
    if (clear) {
      if (kind !== "network") this.console.clear();
      if (kind !== "console") this.network.clear();
    }
    return out.join("\n");
  }
}

/** How much of an eval result is worth carrying back. */
const EVAL_CAP = 20_000;

/** A value from the page, as text, safely and not endlessly. */
export function stringify(value: unknown): string {
  let text: string;
  if (value === undefined) text = "undefined";
  else if (typeof value === "string") text = value;
  else {
    try {
      const seen = new WeakSet<object>();
      text = JSON.stringify(
        value,
        (_key, v: unknown) => {
          if (typeof v === "object" && v !== null) {
            if (seen.has(v)) return "[circular]";
            seen.add(v);
          }
          if (typeof v === "bigint") return `${v}n`;
          if (typeof v === "function") return `[function ${v.name}]`;
          return v;
        },
        2,
      ) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > EVAL_CAP ? `${text.slice(0, EVAL_CAP)}\n… (${text.length - EVAL_CAP} more characters)` : text;
}
