import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, dialog, Menu, screen, session, shell } from "electron";
import { startServer } from "../server/server.js";
import { Bridge } from "./bridge.js";
import { captureTargets } from "./capture.js";
import { askAgainIfNewBuild, permissions } from "./permissions.js";

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

/** How much Chromium may keep on disk per storage partition. */
const CACHE_CAP_BYTES = 16 * 1024 * 1024;

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
function watchPeeks(win: BrowserWindow): void {
  let active = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = () => {
    if (win.isDestroyed()) {
      stop();
      return;
    }
    const point = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    const x = point.x - bounds.x;
    const y = point.y - bounds.y;
    const inBand = x >= 0 && x <= bounds.width && y >= 0 && y <= PEEK_BAND;
    if (!inBand && !active) return;
    active = inBand;
    win.webContents
      .executeJavaScript(`window.__ruriPeekCursor?.(${x},${y},${inBand})`)
      .catch(() => {
        // page mid-navigation — next tick catches up
      });
  };
  // Only while the window is the one in front: a ruri behind another app
  // has no titlebar to hover, and used to keep asking where the cursor was
  // fifteen times a second all the same, all day, for a head it could not
  // lift. Focus starts the clock and blur stops it.
  const start = () => {
    if (timer || win.isDestroyed()) return;
    timer = setInterval(tick, 66);
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    if (!active) return;
    active = false;
    if (!win.isDestroyed()) {
      win.webContents.executeJavaScript("window.__ruriPeekCursor?.(0,0,false)").catch(() => {});
    }
  };
  win.on("focus", start);
  win.on("blur", stop);
  win.on("hide", stop);
  win.on("minimize", stop);
  win.on("closed", stop);
  if (win.isFocused()) start();
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
  fixPath();
  await app.whenReady();
  buildMenu();
  // whatever the old, uncapped cache put by is let go of now
  void session.defaultSession.clearCache().catch(() => {});
  prunePartitions(app.getPath("userData"));

  const staticDir = path.join(import.meta.dirname, "..", "dist-web");
  // the windows and apps sessions drive to look at what they built — the
  // server owns the tools, this shell owns the windows (desktop/bridge.ts)
  const bridge = new Bridge();
  const running = await startServer({
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
  });

  watchPeeks(createWindow(running.port));
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
    if (BrowserWindow.getAllWindows().length === 0) watchPeeks(createWindow(running.port));
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    // nothing a session launched outlives ruri
    void bridge.closeAll();
    void running.close();
  });
  process.on("SIGINT", () => {
    void running.close().finally(() => app.quit());
  });
}

void main();
