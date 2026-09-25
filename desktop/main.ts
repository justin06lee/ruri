import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { app, BrowserWindow, dialog, Menu, screen, session, shell, systemPreferences } from "electron";
import { startServer } from "../server/server.js";
import { Bridge } from "./bridge.js";
import { captureTargets } from "./capture.js";
import { askAgainIfNewBuild, permissions } from "./permissions.js";
import { warn } from "../server/log.js";
import type { WindowDragPhase } from "../shared/protocol.js";

const execFileAsync = promisify(execFile);

/**
 * GUI-launched macOS apps get a minimal PATH (/usr/bin:/bin:...), which would
 * break both finding the `claude` CLI and every Bash/git/npm invocation inside
 * sessions. Recover the user's real PATH from their login shell, with common
 * install dirs appended as a safety net. Async, so it overlaps Electron's
 * own start-up instead of holding it for however long the rc files take.
 */
async function fixPath(): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    const shellBin = process.env["SHELL"] ?? "/bin/zsh";
    // -ilc, not -lc: PATH is commonly set in .zshrc/.bashrc, which only an
    // interactive shell reads; a login shell alone would miss it
    const { stdout } = await execFileAsync(shellBin, ["-ilc", 'printf "__RURI__%s__RURI__" "$PATH"'], {
      encoding: "utf8",
      timeout: 5000,
    });
    const match = /__RURI__(.*)__RURI__/s.exec(stdout);
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

/** How much Chromium may keep on disk per storage partition. */
const CACHE_CAP_BYTES = 16 * 1024 * 1024;

/** How long a quit waits for the bridge and the server to close. */
const QUIT_TIMEOUT_MS = 5_000;

/**
 * The bridge gives every project its own storage partition (cookies and
 * logins for the sites its sessions drive), and Chromium keeps each one on
 * disk under userData/Partitions for good — a project closed months ago
 * still had its cache and its compiled scripts sitting there. Any partition
 * whose project is no longer in the workspace is removed at launch, and the
 * ones that stay lose their caches — logins and cookies are kept, the
 * pages' cached files and compiled scripts are not (nothing has a bridge
 * window open yet this early, so nothing is reading them).
 */
const PARTITION_CACHES = ["Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"];

function prunePartitions(userData: string): void {
  const dir = path.join(userData, "Partitions");
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const alive = new Set(projectIdsOnDisk());
  if (!alive.size) return;
  for (const name of names) {
    if (!name.startsWith("bridge-")) continue;
    if (alive.has(name.slice("bridge-".length))) {
      for (const cache of PARTITION_CACHES) {
        fs.rm(path.join(dir, name, cache), { recursive: true, force: true }, () => {});
      }
      continue;
    }
    fs.rm(path.join(dir, name), { recursive: true, force: true }, () => {});
  }
}

/** The workspace's project ids, read straight from the store's file. */
function projectIdsOnDisk(): string[] {
  const file = path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "projects.json",
  );
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { projects?: Array<{ id?: unknown }> };
    return (data.projects ?? []).map((p) => p.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

/** The app's own window — the one the peek band is in, as against the
 *  bridge's hidden ones. */
let appWindow: BrowserWindow | undefined;
/** Where the window and the cursor were as a press on the band began. */
let carrying: { cursor: Electron.Point; at: [number, number] } | undefined;
/** Where the window stood before a double-click on the band filled the
 *  screen with it — for the one that puts it back. */
let unzoomed: Electron.Rectangle | undefined;

/**
 * Carry the window by the peek band. The band is the title bar, but its
 * pictures have to see the pointer, so while ruri is the window in use
 * the band is no drag region at all (web/src/components/PeekBand.tsx) —
 * and a press on it moves the window here instead: from where the window
 * stood, by as far as the cursor has come. The page says when the press
 * starts, moves and ends; nothing here runs between presses.
 */
function windowDrag(phase: WindowDragPhase): void {
  const win = appWindow;
  if (!win || win.isDestroyed() || win.isFullScreen()) return;
  if (phase === "start") {
    const [x = 0, y = 0] = win.getPosition();
    carrying = { cursor: screen.getCursorScreenPoint(), at: [x, y] };
    return;
  }
  if (phase === "move") {
    if (!carrying) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(
      carrying.at[0] + cursor.x - carrying.cursor.x,
      carrying.at[1] + cursor.y - carrying.cursor.y,
    );
    return;
  }
  if (phase === "end") {
    carrying = undefined;
    return;
  }
  // a double-click does what one on a title bar does, by the Mac's own
  // setting for it (Desktop & Dock → "Double-click a window's title bar")
  const action = systemPreferences.getUserDefault("AppleActionOnDoubleClick", "string");
  if (action === "Minimize") {
    win.minimize();
    return;
  }
  if (action === "None") return;
  const bounds = win.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  if (!win.isMaximized() && (bounds.width < area.width || bounds.height < area.height)) {
    unzoomed = bounds;
    win.maximize();
    return;
  }
  // back again — to the frame it had, put back by hand when this is what
  // filled the screen: macOS's own un-zoom, which unmaximize() asks for,
  // is not dependable (a window it is not showing stays as big as ever)
  if (unzoomed) win.setBounds(unzoomed);
  else win.unmaximize();
  unzoomed = undefined;
}

function createWindow(port: number, token: string): BrowserWindow {
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
  // Links open outside, and only web links: anything a page could hand
  // shell.openExternal is handed the user's default app for its scheme,
  // so schemes are allowlisted rather than passed through.
  const origin = `http://127.0.0.1:${port}`;
  const openOutside = (url: string): void => {
    let scheme: string;
    try {
      scheme = new URL(url).protocol;
    } catch {
      return;
    }
    if (scheme === "http:" || scheme === "https:" || scheme === "mailto:") void shell.openExternal(url);
  };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  // the window is the app's own page and nothing else: a navigation off
  // the origin (a link without target, a redirect) is stopped here and
  // sent outside the same way
  win.webContents.on("will-navigate", (event, url) => {
    if (url === origin || url.startsWith(`${origin}/`)) return;
    event.preventDefault();
    openOutside(url);
  });
  // ?fixture: canned data, for screenshots; ?awake: a window driven from
  // behind everything else, which must not go to sleep on its driver
  // (scripts/shot.mjs, web/src/lib/awake.ts)
  // the token is what lets the page open the socket (server/server.ts)
  const query = [
    `token=${encodeURIComponent(token)}`,
    process.env["RURI_FIXTURE"] && "fixture",
    process.env["RURI_AWAKE"] && "awake",
  ]
    .filter(Boolean)
    .join("&");
  void win.loadURL(`http://127.0.0.1:${port}/?${query}`);
  appWindow = win;

  const screenshot = process.env["RURI_SCREENSHOT"];
  if (screenshot) {
    win.webContents.once("did-finish-load", () => {
      win.show();
      win.moveTop();
      win.focus();
      setTimeout(() => {
        void win.webContents.capturePage().then((img) => fs.promises.writeFile(screenshot, img.toPNG()));
      }, 3000);
    });
  }
  return win;
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
  // The window is a page on 127.0.0.1, and Chromium caches what it fetches
  // from there as if it were the far side of the world — it had put by
  // 600 MB of a localhost app's own uploads. A cache of the local disk
  // saves nothing; capping it small keeps Chromium's bookkeeping and no
  // more. The cap is per storage partition, so the bridge's windows (real
  // sites, where a cache does earn its keep) get the same modest one each.
  app.commandLine.appendSwitch("disk-cache-size", String(CACHE_CAP_BYTES));
  // the login shell and Electron's own start-up take their time side by
  // side; the server (which spawns CLIs off PATH) starts after both
  await Promise.all([fixPath(), app.whenReady()]);
  buildMenu();
  // whatever the old, uncapped cache put by is let go of now
  void session.defaultSession.clearCache().catch(() => {});
  prunePartitions(app.getPath("userData"));

  const staticDir = path.join(import.meta.dirname, "..", "dist-web");
  // the windows and apps sessions drive to look at what they built — the
  // server owns the tools, this shell owns the windows (desktop/bridge.ts)
  const bridge = new Bridge();
  // the window's key to the server: a script that drives the app sets it
  // (scripts/lib/server.ts), a launch from the Dock gets a fresh one
  const token = process.env["RURI_TOKEN"] || randomBytes(32).toString("hex");
  const running = await startServer({
    token,
    // A fixed port on purpose. The window is a page served from it, so the
    // port is the origin, and the origin is what everything the window keeps
    // for itself is filed under — a fresh port every launch meant every one
    // of those preferences started empty. Only one ruri runs at a time (the
    // single-instance lock above), so the port is ours by rights: if a ruri
    // that outlived its app is sitting on it, it is retired for it rather
    // than tiptoed around (reclaimPort, server/port.ts). Anything else on the
    // port is left alone, and then the app still comes up on an ephemeral one
    // — and says so, below.
    port: Number(process.env["RURI_PORT"] ?? DESKTOP_PORT),
    reclaimPort: true,
    staticDir,
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
    bridge,
    permissions,
    windowDrag,
  });

  createWindow(running.port, token);
  // a fresh build is a stranger to macOS: it asks for its grants again,
  // dialog by dialog, once the window is up (desktop/permissions.ts)
  setTimeout(() => void askAgainIfNewBuild().catch(() => {}), 1500);

  // A GUI app's stdout goes nowhere anyone will look, and a window on an
  // unexpected origin is indistinguishable from a ruri that has lost its
  // settings. So the one case the server could not fix itself is said out
  // loud, with the thing to do about it.
  if (running.portFallback) {
    const { wanted, reason } = running.portFallback;
    void dialog.showMessageBox({
      type: "warning",
      title: "ruri is on a different port",
      message: `Port ${wanted} was not available, so ruri started on ${running.port}.`,
      detail:
        `${reason[0]!.toUpperCase()}${reason.slice(1)}.\n\n` +
        `Your projects and sessions are all here — but this window is a new origin, ` +
        `so anything the window itself remembers (sidebar widths, what was last open) ` +
        `starts fresh. Free port ${wanted} and relaunch to get it back.`,
      buttons: ["OK"],
    });
  }

  app.on("second-instance", () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  // macOS: closing the window keeps the app (and its warm sessions) alive;
  // the Dock icon reopens it. Cmd+Q actually quits and tears sessions down.
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(running.port, token);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  // Quit waits for the teardown: nothing a session launched outlives ruri,
  // and the archive writes transcripts and drafts on a debounce that
  // close() flushes — a quit that did not wait lost whatever had not
  // landed. The first before-quit is cancelled and the teardown started;
  // when it finishes (or QUIT_TIMEOUT_MS is up, for a bridge app that
  // will not go), quit() is called again and the flag lets it through.
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    const teardown = Promise.allSettled([bridge.closeAll(), running.close()]);
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS).unref?.());
    void Promise.race([teardown, deadline]).then(() => app.quit());
  });
  // a signal to stop is a quit like Cmd+Q: SIGTERM (a plain `kill`, a
  // supervisor) used to end the process on the spot, and with it whatever
  // the archive had not yet written
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void running.close().finally(() => app.quit());
    });
  }
}

// A GUI app has no terminal to die into: what nobody caught is logged and
// the app stays up, since the window and its sessions are worth more than
// a clean exit code.
process.on("unhandledRejection", (err) => warn("desktop", err, "unhandled rejection"));
process.on("uncaughtException", (err) => warn("desktop", err, "uncaught exception"));

void main();
