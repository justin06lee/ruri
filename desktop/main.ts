import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, BrowserWindow, Menu, shell } from "electron";
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

function createWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#0d1117",
    titleBarStyle: "hiddenInset",
    title: "ruri",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void win.loadURL(`http://127.0.0.1:${port}/`);

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
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  fixPath();
  await app.whenReady();
  buildMenu();

  const staticDir = path.join(import.meta.dirname, "..", "dist-web");
  const running = await startServer({
    port: Number(process.env["RURI_PORT"] ?? 0),
    staticDir,
  });

  createWindow(running.port);

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
