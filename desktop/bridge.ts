import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow, app as electronApp, nativeImage } from "electron";
import type { BridgeState } from "../shared/protocol.js";
import {
  bridgeDir,
  type BridgeCall,
  type BridgeContext,
  type BridgeHost,
  type BridgeResult,
} from "../server/bridge.js";
import { PageDriver, sleep, stringify, type CdpLink } from "../server/cdp.js";
import * as apps from "./apps.js";

/**
 * The bridge's hands: the half that needs Electron.
 *
 * Per channel, a browser window nobody sees — made on the first web_open,
 * destroyed on web_close or when the session goes — and whatever apps the
 * session has launched (desktop/apps.ts). The window is driven through its
 * own webContents debugger, which is the DevTools protocol in-process, so
 * the driver in server/cdp.ts does the work and this file only has to say
 * where the window is.
 *
 * Three things are decided here rather than there. What the model sees
 * after an action is a scaled preview, not the full capture — a picture is
 * worth a thousand tokens, and a retina viewport is worth many more. What
 * the user sees is a smaller one still, written to disk no more than a few
 * times a second and announced through the state listener, which the
 * server turns into a `bridge` message for the strip beside the composer.
 * And the window stays hidden: it shows only when the user takes it over,
 * and the close button hides it again rather than ending the session's
 * work.
 */

/** A desktop layout's worth of window. */
const WINDOW = { width: 1280, height: 800 };
/** A page that hasn't loaded by now is not going to. */
const LOAD_TIMEOUT_MS = 20_000;
/** How long a freshly loaded page gets before it is photographed. */
const SETTLE_MS = 300;
/** What the model sees after an action: enough to read, cheap to carry. */
const PREVIEW_MAX_WIDTH = 1000;
/** What the user sees in the strip. */
const STRIP_MAX_WIDTH = 640;
/** The strip is refreshed at most this often. */
const STRIP_GAP_MS = 250;
/** Room around an element in its own screenshot, as desktop/capture.ts. */
const SHOT_PAD = 10;
/** A whole-document screenshot stops here, however long the page. */
const FULL_MAX_HEIGHT = 8_000;
/** How long a wait waits when nobody says. */
const DEFAULT_WAIT_MS = 15_000;

interface Web {
  win: BrowserWindow;
  driver: PageDriver;
}

interface Meta {
  kind: BridgeState["kind"];
  title: string;
  address: string;
}

interface Channel {
  channelId: string;
  projectId: string;
  web?: Web;
  apps: Map<string, apps.AppHandle>;
  /** What the strip is about: the page, or the app last touched. */
  meta?: Meta;
  takenOver: boolean;
  /** Numbering for shot-<n>.png. */
  shotN: number;
  /** The strip's own throttle. */
  stripAt: number;
  stripTimer?: NodeJS.Timeout;
  stripLatest?: Buffer;
  previewAt?: number;
}

/** A PNG no wider than `maxWidth`, re-encoded only when it has to be. */
function scaled(png: Buffer, maxWidth: number): Buffer {
  const image = nativeImage.createFromBuffer(png);
  const { width } = image.getSize();
  if (width <= maxWidth) return png;
  return image.resize({ width: maxWidth, quality: "good" }).toPNG();
}

/** What a session wrote as a URL, as something a window can load. */
function toHref(raw: string): string {
  const text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith("about:") || text.startsWith("data:")) return text;
  if (text.startsWith("/") || text.startsWith("~/") || text.startsWith("./")) {
    const file = text.startsWith("~/") ? path.join(process.env["HOME"] ?? "", text.slice(2)) : path.resolve(text);
    return pathToFileURL(file).toString();
  }
  return `http://${text}`;
}

export class Bridge implements BridgeHost {
  private readonly channels = new Map<string, Channel>();
  private readonly listeners: Array<(channelId: string, state: BridgeState | null) => void> = [];

  onState(listener: (channelId: string, state: BridgeState | null) => void): void {
    this.listeners.push(listener);
  }

  states(): Record<string, BridgeState> {
    const out: Record<string, BridgeState> = {};
    for (const channel of this.channels.values()) {
      const state = this.stateOf(channel);
      if (state) out[channel.channelId] = state;
    }
    return out;
  }

  private stateOf(channel: Channel): BridgeState | null {
    if (!channel.meta) return null;
    return {
      ...channel.meta,
      ...(channel.previewAt
        ? { previewUrl: `/bridge/preview/${channel.channelId}?t=${channel.previewAt}` }
        : {}),
      at: channel.previewAt ?? Date.now(),
      takenOver: channel.takenOver,
    };
  }

  private emit(channel: Channel): void {
    const state = this.stateOf(channel);
    for (const listener of this.listeners) listener(channel.channelId, state);
  }

  private channel(ctx: BridgeContext): Channel {
    let channel = this.channels.get(ctx.channelId);
    if (!channel) {
      channel = { ...ctx, apps: new Map(), takenOver: false, shotN: 0, stripAt: 0 };
      this.channels.set(ctx.channelId, channel);
    }
    return channel;
  }

  /* ── pictures ─────────────────────────────────────────────────── */

  private save(channel: Channel, png: Buffer): string {
    const dir = bridgeDir(channel.channelId);
    fs.mkdirSync(dir, { recursive: true });
    channel.shotN += 1;
    const file = path.join(dir, `shot-${channel.shotN}.png`);
    fs.writeFileSync(file, png);
    return file;
  }

  /** Hand the strip a new picture, no more often than STRIP_GAP_MS. */
  private strip(channel: Channel, png: Buffer): void {
    channel.stripLatest = png;
    const due = channel.stripAt + STRIP_GAP_MS - Date.now();
    if (due <= 0) {
      this.writeStrip(channel);
      return;
    }
    if (channel.stripTimer) return;
    channel.stripTimer = setTimeout(() => {
      channel.stripTimer = undefined;
      this.writeStrip(channel);
    }, due);
  }

  private writeStrip(channel: Channel): void {
    const png = channel.stripLatest;
    if (!png || !this.channels.has(channel.channelId)) return;
    channel.stripLatest = undefined;
    try {
      const dir = bridgeDir(channel.channelId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "preview.png"), scaled(png, STRIP_MAX_WIDTH));
      channel.stripAt = Date.now();
      channel.previewAt = channel.stripAt;
    } catch {
      // the strip keeps its last picture
    }
    this.emit(channel);
  }

  /** The usual answer: words, a preview scaled for the model, the strip
   *  refreshed for the user. */
  private answer(channel: Channel, text: string, png: Buffer, maxWidth = PREVIEW_MAX_WIDTH): BridgeResult {
    const preview = scaled(png, maxWidth);
    const file = this.save(channel, preview);
    this.strip(channel, png);
    return { text, image: { png: preview, path: file } };
  }

  /* ── the hidden window ────────────────────────────────────────── */

  private async web(channel: Channel): Promise<Web> {
    if (channel.web && !channel.web.win.isDestroyed()) return channel.web;
    const win = new BrowserWindow({
      ...WINDOW,
      show: false,
      backgroundColor: "#ffffff",
      title: "ruri bridge",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        // logins persist for the project across its sessions, and are never
        // the user's own browser's
        partition: `persist:bridge-${channel.projectId}`,
      },
    });
    // popups navigate this window instead of opening another
    win.webContents.setWindowOpenHandler(({ url }) => {
      void win.loadURL(url).catch(() => {
        // reported by whatever the session does next
      });
      return { action: "deny" };
    });
    // the user closing a taken-over window gives it back; the session's
    // work in it goes on
    win.on("close", (event) => {
      if (!this.channels.has(channel.channelId)) return;
      event.preventDefault();
      win.hide();
      channel.takenOver = false;
      this.emit(channel);
    });
    // a window that has never navigated has no document, and the debugger's
    // Page/Runtime domains have nothing to enable against — the first
    // sendCommand then waits forever. One blank load gives it a document.
    await win.loadURL("about:blank");
    const dbg = win.webContents.debugger;
    dbg.attach("1.3");
    const link: CdpLink = {
      send: <T,>(method: string, params?: Record<string, unknown>) => dbg.sendCommand(method, params) as Promise<T>,
      on: (method, listener) => {
        const handler = (_event: Electron.Event, name: string, params: unknown): void => {
          if (name === method) listener((params ?? {}) as Record<string, unknown>);
        };
        dbg.on("message", handler);
        return () => dbg.off("message", handler);
      },
    };
    const driver = new PageDriver(link);
    await driver.enable();
    channel.web = { win, driver };
    return channel.web;
  }

  private openWeb(channel: Channel): Web {
    if (!channel.web || channel.web.win.isDestroyed()) {
      throw new Error("nothing is open — web_open a URL first");
    }
    return channel.web;
  }

  private async load(web: Web, href: string): Promise<void> {
    web.driver.reset();
    const outcome = await Promise.race([
      web.win.loadURL(href).then(
        () => "ok" as const,
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      ),
      sleep(LOAD_TIMEOUT_MS).then(() => "timeout" as const),
    ]);
    if (outcome === "timeout") throw new Error(`${href} didn't finish loading in ${LOAD_TIMEOUT_MS / 1000}s`);
    if (outcome !== "ok") {
      // a page that redirected itself mid-load aborts the first load and
      // is fine; anything else is a real failure, said the way Chromium
      // says it (ERR_CONNECTION_REFUSED and friends)
      if (/ERR_ABORTED/.test(outcome.message)) {
        await sleep(500);
        return;
      }
      throw new Error(`couldn't load ${href}: ${outcome.message}`);
    }
  }

  /**
   * A picture of the page. Not through the protocol: a window that has
   * never been shown paints no frame for Page.captureScreenshot to copy,
   * and the request waits forever for one. Electron's own capturePage
   * makes the view paint for the capture and leaves it hidden after
   * (`stayHidden`) — the same call desktop/capture.ts photographs with.
   * The whole document is had by making the hidden window as tall as the
   * page for a moment; nobody sees it grow.
   */
  private async shootWeb(web: Web, opts: { selector?: string; full?: boolean } = {}): Promise<Buffer> {
    const contents = web.win.webContents;
    const capture = { stayHidden: true, stayAwake: true };
    if (opts.selector) {
      const r = await web.driver.locate(opts.selector);
      const [vw, vh] = web.win.getContentSize();
      const x = Math.max(0, Math.floor(r.x - SHOT_PAD));
      const y = Math.max(0, Math.floor(r.y - SHOT_PAD));
      const rect = {
        x,
        y,
        width: Math.max(1, Math.min((vw ?? WINDOW.width) - x, Math.ceil(r.width + SHOT_PAD * 2))),
        height: Math.max(1, Math.min((vh ?? WINDOW.height) - y, Math.ceil(r.height + SHOT_PAD * 2))),
      };
      return (await contents.capturePage(rect, capture)).toPNG();
    }
    if (opts.full) {
      const [w, h] = web.win.getContentSize();
      const width = w ?? WINDOW.width;
      const height = h ?? WINDOW.height;
      const wanted = await web.driver.eval<number>(
        "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)",
      );
      const tall = Math.min(FULL_MAX_HEIGHT, Math.max(height, Math.ceil(wanted)));
      if (tall === height) return (await contents.capturePage(undefined, capture)).toPNG();
      web.win.setContentSize(width, tall);
      try {
        await sleep(SETTLE_MS);
        return (await contents.capturePage(undefined, capture)).toPNG();
      } finally {
        web.win.setContentSize(width, height);
      }
    }
    return (await contents.capturePage(undefined, capture)).toPNG();
  }

  private async describeWeb(channel: Channel, web: Web): Promise<{ url: string; title: string; width: number; height: number }> {
    const where = await web.driver.where();
    channel.meta = { kind: "web", title: where.title || where.url, address: where.url };
    return where;
  }

  /** The words and the picture after a web action. */
  private async afterWeb(channel: Channel, web: Web, did: string): Promise<BridgeResult> {
    await sleep(SETTLE_MS);
    const where = await this.describeWeb(channel, web);
    const png = await this.shootWeb(web);
    return this.answer(channel, `${did}\nNow at ${where.url} — "${where.title}".`, png);
  }

  /* ── apps ─────────────────────────────────────────────────────── */

  private appOf(channel: Channel, handle: string): apps.AppHandle {
    const app = channel.apps.get(handle);
    if (!app) throw new Error(`no launched app "${handle}" — app_list shows what this session holds`);
    return app;
  }

  private driverOf(app: apps.AppHandle): PageDriver {
    if (app.kind !== "electron" || !app.driver) {
      throw new Error(`${app.handle} (${app.app}) is a native app — drive it with app_ui_tree, app_ui and app_screenshot`);
    }
    if (app.socket && !app.socket.alive) throw new Error(`${app.app} has closed its debugging connection — it may have quit`);
    return app.driver;
  }

  private async afterApp(channel: Channel, app: apps.AppHandle, did: string): Promise<BridgeResult> {
    await sleep(SETTLE_MS);
    const driver = this.driverOf(app);
    const where = await driver.where();
    channel.meta = { kind: "electron", title: where.title || app.app, address: app.address };
    const png = await driver.screenshot();
    return this.answer(channel, `${did}\n${app.app}: ${where.url} — "${where.title}".`, png);
  }

  /* ── the tools ────────────────────────────────────────────────── */

  async run(ctx: BridgeContext, call: BridgeCall): Promise<BridgeResult> {
    const channel = this.channel(ctx);
    switch (call.tool) {
      case "web_open": {
        const web = await this.web(channel);
        const href = toHref(call.args.url);
        await this.load(web, href);
        await sleep(SETTLE_MS);
        const where = await this.describeWeb(channel, web);
        const png = await this.shootWeb(web);
        return this.answer(
          channel,
          `Opened "${where.title}" — ${where.url} (viewport ${where.width}x${where.height}).`,
          png,
        );
      }
      case "web_click": {
        const web = this.openWeb(channel);
        const what = await web.driver.click(call.args);
        return this.afterWeb(channel, web, `Clicked ${what}.`);
      }
      case "web_type": {
        const web = this.openWeb(channel);
        await web.driver.type(call.args.text, call.args.selector);
        const shown = call.args.text.length > 60 ? `${call.args.text.slice(0, 60)}…` : call.args.text;
        return this.afterWeb(channel, web, `Typed ${JSON.stringify(shown)}${call.args.selector ? ` into ${call.args.selector}` : ""}.`);
      }
      case "web_press": {
        const web = this.openWeb(channel);
        await web.driver.press(call.args.key, call.args.modifiers ?? []);
        return this.afterWeb(channel, web, `Pressed ${call.args.key}.`);
      }
      case "web_scroll": {
        const web = this.openWeb(channel);
        await web.driver.scroll(call.args);
        const where = await this.describeWeb(channel, web);
        const y = await web.driver.eval<number>("scrollY");
        return { text: `Scrolled${call.args.selector ? ` ${call.args.selector}` : ""}; the page is at scrollY ${Math.round(y)} on ${where.url}.` };
      }
      case "web_screenshot": {
        const web = this.openWeb(channel);
        const png = await this.shootWeb(web, call.args);
        const file = this.save(channel, png);
        const { width, height } = nativeImage.createFromBuffer(png).getSize();
        this.strip(channel, png);
        await this.describeWeb(channel, web);
        return {
          text: `Saved ${width}x${height} PNG to ${file}${call.args.selector ? ` (${call.args.selector})` : call.args.full ? " (whole document)" : ""}.`,
          image: { png, path: file },
        };
      }
      case "web_eval": {
        const web = this.openWeb(channel);
        return { text: stringify(await web.driver.eval(call.args.js)) };
      }
      case "web_logs": {
        const web = this.openWeb(channel);
        return { text: web.driver.logs(call.args.kind ?? "all", call.args.clear ?? false) };
      }
      case "web_wait_for": {
        const web = this.openWeb(channel);
        const met = await web.driver.waitFor(call.args, call.args.timeoutMs ?? DEFAULT_WAIT_MS);
        return this.afterWeb(channel, web, `Done waiting: ${met}.`);
      }
      case "web_where": {
        const web = this.openWeb(channel);
        const where = await this.describeWeb(channel, web);
        return {
          text: `${where.url}\n"${where.title}"\nviewport ${where.width}x${where.height}\n${channel.takenOver ? "the user has taken the window over" : "hidden from the user"}`,
        };
      }
      case "web_close": {
        this.closeWeb(channel);
        return { text: "Closed the window." };
      }
      case "app_launch": {
        const { app, command, args = [], cwd } = call.args;
        let launched: apps.AppHandle;
        if (command) launched = await apps.launchElectron(command, args, cwd);
        else if (app) launched = await apps.launchNative(app, args);
        else throw new Error("give an app to open, or a command to run");
        channel.apps.set(launched.handle, launched);
        channel.meta = { kind: launched.kind, title: launched.app, address: launched.address };
        const line = JSON.stringify({ handle: launched.handle, kind: launched.kind, pid: launched.pid, app: launched.app });
        if (launched.kind === "electron") {
          return this.afterApp(channel, launched, `Launched ${launched.app}: ${line}`);
        }
        this.emit(channel);
        return {
          text: `Launched ${launched.app} in the background: ${line}\nIt is a native app: app_ui_tree shows its controls, app_ui drives them, app_screenshot photographs it.${launched.preexisting ? " It was already running before this session." : ""}`,
        };
      }
      case "app_click": {
        const app = this.appOf(channel, call.args.handle);
        const what = await this.driverOf(app).click(call.args);
        return this.afterApp(channel, app, `Clicked ${what}.`);
      }
      case "app_type": {
        const app = this.appOf(channel, call.args.handle);
        await this.driverOf(app).type(call.args.text, call.args.selector);
        return this.afterApp(channel, app, `Typed ${JSON.stringify(call.args.text.slice(0, 60))}.`);
      }
      case "app_press": {
        const app = this.appOf(channel, call.args.handle);
        await this.driverOf(app).press(call.args.key, call.args.modifiers ?? []);
        return this.afterApp(channel, app, `Pressed ${call.args.key}.`);
      }
      case "app_scroll": {
        const app = this.appOf(channel, call.args.handle);
        await this.driverOf(app).scroll(call.args);
        return { text: `Scrolled ${app.app}.` };
      }
      case "app_eval": {
        const app = this.appOf(channel, call.args.handle);
        return { text: stringify(await this.driverOf(app).eval(call.args.js)) };
      }
      case "app_wait_for": {
        const app = this.appOf(channel, call.args.handle);
        const met = await this.driverOf(app).waitFor(call.args, call.args.timeoutMs ?? DEFAULT_WAIT_MS);
        return this.afterApp(channel, app, `Done waiting: ${met}.`);
      }
      case "app_logs": {
        const app = this.appOf(channel, call.args.handle);
        return { text: this.driverOf(app).logs(call.args.kind ?? "all", call.args.clear ?? false) };
      }
      case "app_screenshot": {
        const app = this.appOf(channel, call.args.handle);
        let png: Buffer;
        let title: string;
        if (app.kind === "electron") {
          const driver = this.driverOf(app);
          png = await driver.screenshot({ ...call.args, pad: SHOT_PAD });
          title = (await driver.where()).title || app.app;
        } else {
          ({ png, title } = await apps.captureNative(app));
        }
        channel.meta = { kind: app.kind, title, address: app.address };
        const file = this.save(channel, png);
        const { width, height } = nativeImage.createFromBuffer(png).getSize();
        this.strip(channel, png);
        return { text: `Saved ${width}x${height} PNG of ${app.app} ("${title}") to ${file}.`, image: { png, path: file } };
      }
      case "app_ui_tree": {
        const app = this.appOf(channel, call.args.handle);
        const tree = await apps.uiTree(app, call.args.depth ?? 4);
        channel.meta = { kind: app.kind, title: (await apps.windowTitle(app)) ?? app.app, address: app.address };
        this.emit(channel);
        return { text: tree };
      }
      case "app_ui": {
        const app = this.appOf(channel, call.args.handle);
        const out = await apps.uiScript(app, call.args.script);
        channel.meta = { kind: app.kind, title: (await apps.windowTitle(app)) ?? app.app, address: app.address };
        // the user's picture follows the script when the picture is free
        if (app.kind === "native") {
          void apps.captureNative(app).then((shot) => this.strip(channel, shot.png)).catch(() => this.emit(channel));
        } else {
          this.emit(channel);
        }
        return { text: out };
      }
      case "app_list": {
        const lines = [...channel.apps.values()].map(
          (app) => `${app.handle}: ${app.kind} ${app.app} (pid ${app.pid}${app.pid && !isAlive(app.pid) ? ", gone" : ""}) — ${app.address}`,
        );
        return { text: lines.join("\n") || "(nothing launched)" };
      }
      case "app_quit": {
        const app = this.appOf(channel, call.args.handle);
        const how = await apps.quit(app);
        channel.apps.delete(app.handle);
        this.forget(channel, app);
        return { text: `${app.app}: ${how}.` };
      }
      default: {
        const unknown: never = call;
        throw new Error(`unknown tool ${JSON.stringify(unknown)}`);
      }
    }
  }

  /** The window went: the strip shows an app if one is left, or nothing. */
  private closeWeb(channel: Channel): void {
    const web = channel.web;
    channel.web = undefined;
    if (web && !web.win.isDestroyed()) {
      web.driver.dispose();
      web.win.destroy();
    }
    if (channel.meta?.kind === "web") {
      const next = [...channel.apps.values()].at(-1);
      channel.meta = next ? { kind: next.kind, title: next.app, address: next.address } : undefined;
      if (!channel.meta) channel.previewAt = undefined;
    }
    channel.takenOver = false;
    this.emit(channel);
  }

  /** An app went: the same, the other way round. */
  private forget(channel: Channel, app: apps.AppHandle): void {
    if (channel.meta && channel.meta.address === app.address && channel.meta.kind === app.kind) {
      const next = [...channel.apps.values()].at(-1);
      channel.meta = channel.web
        ? { kind: "web", title: channel.meta.title, address: channel.meta.address }
        : next
          ? { kind: next.kind, title: next.app, address: next.address }
          : undefined;
      if (channel.web) {
        // the page's own words come back with its next action
        void this.describeWeb(channel, channel.web).then(() => this.emit(channel)).catch(() => this.emit(channel));
        return;
      }
      if (!channel.meta) channel.previewAt = undefined;
    }
    this.emit(channel);
  }

  /* ── the user's side ──────────────────────────────────────────── */

  async takeover(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel?.meta) return;
    if (channel.meta.kind === "web") {
      const web = channel.web;
      if (!web || web.win.isDestroyed()) return;
      web.win.show();
      web.win.focus();
    } else {
      const app = [...channel.apps.values()].findLast((a) => a.address === channel.meta?.address);
      if (app) await apps.activate(app);
    }
    channel.takenOver = true;
    this.emit(channel);
  }

  async release(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    if (channel.meta?.kind === "web") {
      channel.web?.win.hide();
    }
    // an app goes behind by ruri coming back in front — hiding it would
    // cost its picture (see desktop/apps.ts)
    electronApp.focus({ steal: true });
    channel.takenOver = false;
    this.emit(channel);
  }

  async close(channelId: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;
    this.channels.delete(channelId);
    if (channel.stripTimer) clearTimeout(channel.stripTimer);
    if (channel.web && !channel.web.win.isDestroyed()) {
      channel.web.driver.dispose();
      channel.web.win.destroy();
    }
    await Promise.all([...channel.apps.values()].map((app) => apps.quit(app).catch(() => undefined)));
    for (const listener of this.listeners) listener(channelId, null);
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.channels.values()].map(async (channel) => {
        this.channels.delete(channel.channelId);
        if (channel.stripTimer) clearTimeout(channel.stripTimer);
        if (channel.web && !channel.web.win.isDestroyed()) channel.web.win.destroy();
        await Promise.all([...channel.apps.values()].map((app) => apps.quit(app, true).catch(() => undefined)));
      }),
    );
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
