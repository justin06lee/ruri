import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, dialog, Menu, screen, shell } from "electron";
import { startServer } from "../server/server.js";

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

  const staticDir = path.join(import.meta.dirname, "..", "dist-web");
  const running = await startServer({
    // A fixed port on purpose. The window is a page served from it, so the
    // port is the origin, and the origin is what everything the window keeps
    // for itself is filed under — a fresh port every launch meant every one
    // of those preferences started empty. Only one ruri runs at a time (the
    // single-instance lock above), so this is free; if something else has
    // taken it the server falls back to an ephemeral port and the app still
    // comes up, with the server holding the preferences either way.
    port: Number(process.env["RURI_PORT"] ?? DESKTOP_PORT),
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
  });

  createWindow(running.port);
  watchPeeks();

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
    if (BrowserWindow.getAllWindows().length === 0) createWindow(running.port);
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  app.on("before-quit", () => {
    void running.close();
  });
  process.on("SIGINT", () => {
    void running.close().finally(() => app.quit());
  });
}

void main();
