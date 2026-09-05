import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, dialog, Menu, screen, shell } from "electron";
import { Bridge } from "./bridge.js";
import { captureTargets } from "./capture.js";
import { HostClient } from "./host.js";

/**
 * The shell and the server are two processes.
 *
 * This one is the app: the window, the menu, the dialogs, the hidden
 * browser windows the bridge drives. The server — every session, every
 * terminal, the ledger, the UI it serves — is a separate process this one
 * spawns detached and then merely connects to. Quit the app and the server
 * carries on with everything in it; open the app again and it finds the
 * server on the port and picks up where it was. Replace the app with a
 * newer one and the old server steps aside on its own, once every session
 * is idle, and the new app spawns the new server in its place. Nothing
 * running is ever interrupted for an update.
 */

/**
 * GUI-launched macOS apps get a minimal PATH (/usr/bin:/bin:...), which would
 * break both finding the `claude` CLI and every Bash/git/npm invocation inside
 * sessions. Recover the user's real PATH from their login shell, with common
 * install dirs appended as a safety net.
 */
function fixPath(): void {
  if (process.platform !== "darwin") return;
  try {
    const shellBin = process.env["SHELL"] ?? "/bin/zsh";
    const out = execFileSync(shellBin, ["-ilc", 'printf "__RURI__%s__RURI__" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
    });
    const match = /__RURI__(.*)__RURI__/s.exec(out);
    if (match?.[1]) process.env["PATH"] = match[1];
  } catch {
    // fall through to the append below
  }
  const home = os.homedir();
  const extras = [
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const current = (process.env["PATH"] ?? "").split(path.delimiter);
  process.env["PATH"] = [...current, ...extras.filter((d) => !current.includes(d))].join(path.delimiter);
}

/** The port the packaged app serves itself on — see `main()` below. 7777 is
 *  the dev server's, deliberately not shared: a dev run and the installed app
 *  should not fight over one. */
const DESKTOP_PORT = 7776;

interface Health {
  ok: boolean;
  version?: string;
  pid?: number;
}

/** Whether a ruri server answers on the port, and which one it is. */
async function health(port: number): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return null;
    const body = (await res.json()) as Health & { service?: string };
    return body.service === "ruri" ? body : null;
  } catch {
    return null;
  }
}

/** The bundle's files on disk. Packaged, they are unpacked beside the asar
 *  (asarUnpack in package.json) so a plain node process can run them. */
function bundleRoot(): string {
  const appPath = app.getAppPath();
  const unpacked = appPath.replace(/app\.asar$/, "app.asar.unpacked");
  return fs.existsSync(unpacked) ? unpacked : appPath;
}

function configDir(): string {
  return process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri");
}

/**
 * Start the server, detached: its own process group, its output to a log,
 * unreferenced so this process can exit without it. It runs under this
 * same Electron binary as plain node — no other runtime is installed.
 */
function spawnServer(port: number): void {
  const root = bundleRoot();
  const entry = path.join(root, "dist-electron", "server.mjs");
  fs.mkdirSync(configDir(), { recursive: true });
  const log = fs.openSync(path.join(configDir(), "server.log"), "a");
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      RURI_PORT: String(port),
      RURI_STATIC: path.join(root, "dist-web"),
      RURI_VERSION: app.getVersion(),
    },
  });
  child.unref();
  fs.closeSync(log);
}

/** A server on the port, spawning one if none answers. */
async function ensureServer(port: number): Promise<Health> {
  const found = await health(port);
  if (found) return found;
  spawnServer(port);
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    await new Promise((r) => setTimeout(r, 250));
    const up = await health(port);
    if (up) return up;
  }
  throw new Error("the ruri server did not come up");
}

function createWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#f6f1e6",
    titleBarStyle: "hiddenInset",
    title: "ruri",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // the attachment viewer previews PDFs in an iframe via Chromium's
      // built-in PDF plugin, which is off by default
      plugins: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`http://127.0.0.1:${port}/${process.env["RURI_FIXTURE"] ? "?fixture" : ""}`);

  const screenshot = process.env["RURI_SCREENSHOT"];
  if (screenshot) {
    win.webContents.once("did-finish-load", () => {
      win.show();
      win.moveTop();
      win.focus();
      setTimeout(() => {
        void win.webContents
          .capturePage()
          .then((img) => fs.promises.writeFile(screenshot, img.toPNG()));
      }, 3000);
    });
  }
  return win;
}

/** Height of the titlebar band the peek skyline lives in (see styles.css). */
const PEEK_BAND = 46;

/**
 * Hover for the titlebar skyline. The whole bar is a window-drag region, so
 * the page never sees mouse events there — instead main polls the cursor
 * and hands window-relative coordinates to the page's __ruriPeekCursor
 * hook, which lifts the head under it. Quiet when the cursor is elsewhere.
 */
function watchPeeks(): void {
  let active = false;
  setInterval(() => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win || win.isDestroyed()) return;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    const inBand =
      win.isFocused() && x >= 0 && x <= bounds.width && y >= 0 && y <= PEEK_BAND;
    if (!inBand && !active) return;
    active = inBand;
    win.webContents
      .executeJavaScript(`window.__ruriPeekCursor?.(${x},${y},${inBand})`)
      .catch(() => {
        // page mid-navigation — next tick catches up
      });
  }, 66);
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

async function main(): Promise<void> {
  // Dev/screenshot runs: an isolated userData keeps the single-instance lock
  // (and caches) from colliding with an installed ruri.app that's running.
  const userData = process.env["RURI_USER_DATA"];
  if (userData) app.setPath("userData", userData);
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  fixPath();
  await app.whenReady();
  buildMenu();

  const port = Number(process.env["RURI_PORT"] ?? DESKTOP_PORT);
  // the windows and apps sessions drive to look at what they built — the
  // server owns the tools, this shell owns the windows (desktop/bridge.ts)
  const bridge = new Bridge();

  let server: Health;
  try {
    server = await ensureServer(port);
  } catch (err) {
    dialog.showErrorBox("ruri", `The server did not start: ${err instanceof Error ? err.message : String(err)}`);
    app.quit();
    return;
  }

  // The page comes from the server. When a newer server takes over, the
  // page it serves is newer too, and the window is reloaded to get it —
  // once, at the moment the versions line up.
  let pageFrom = server.version ?? "";
  const host = new HostClient(
    port,
    {
      version: app.getVersion(),
      appPath: app.getAppPath(),
      bridge,
      pickFolder: async () => {
        const win = BrowserWindow.getAllWindows()[0];
        const opts = {
          title: "Add project",
          buttonLabel: "Add",
          properties: ["openDirectory", "createDirectory"] as Array<"openDirectory" | "createDirectory">,
        };
        const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      capture: captureTargets,
    },
    async () => {
      // the server went away (it stepped aside for this build, or died):
      // bring one back from this bundle
      try {
        await ensureServer(port);
      } catch {
        // the reconnect loop keeps trying
      }
    },
    () => {
      void health(port).then((now) => {
        if (!now?.version || now.version === pageFrom) return;
        pageFrom = now.version;
        for (const win of BrowserWindow.getAllWindows()) win.webContents.reload();
      });
    },
  );
  host.connect();

  createWindow(port);
  watchPeeks();

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // macOS: closing the window keeps the app alive; the Dock icon reopens
  // it. Cmd+Q quits the app — and only the app: the server, and every
  // session in it, carries on until the next app connects.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    // the windows are this process's; the sessions are not
    host.close();
    void bridge.closeAll();
  });
  process.on("SIGINT", () => app.quit());
}

void main();
