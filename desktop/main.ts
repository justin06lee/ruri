import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  screen,
  session,
  shell,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { Bridge } from "./bridge.js";
import { captureTargets } from "./capture.js";
import { movingPage, offlinePage } from "./offline.js";
import { askAgainIfNewBuild, permissions } from "./permissions.js";
import { discover, type Peer } from "./peers.js";
import { computerName, Remote, Unreachable, type Host, type Spot } from "./remote.js";
import { ServerProcess, type ServerUp } from "./serverProcess.js";
import { setUpOverSsh } from "./sshSetup.js";
import { configPath } from "../server/configDir.js";
import { readWords, urlHost } from "../server/invite.js";
import { errorMessage, warn } from "../server/log.js";
import type { WindowDragPhase } from "../shared/protocol.js";

const execFileAsync = promisify(execFile);

/** macOS, as against Linux: the only two ruri is built for. */
const MAC = process.platform === "darwin";

/**
 * GUI-launched apps get a minimal PATH — macOS's is /usr/bin:/bin:..., and a
 * Linux desktop's is whatever the session started with, which leaves out
 * what only .bashrc adds (bun's, OpenCode's) — and that would break both
 * finding the harness CLIs and every Bash/git/npm invocation inside
 * sessions. Recover the user's real PATH from their login shell, with common
 * install dirs appended as a safety net. Async, so it overlaps Electron's
 * own start-up instead of holding it for however long the rc files take.
 */
async function fixPath(): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const shellBin = process.env["SHELL"] ?? (MAC ? "/bin/zsh" : "/bin/bash");
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
  // setting for it (Desktop & Dock → "Double-click a window's title bar");
  // elsewhere it fills the screen, as a title bar's does by default
  const action = MAC ? systemPreferences.getUserDefault("AppleActionOnDoubleClick", "string") : "Maximize";
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

/** What the window shows: a page, and the origin it may move about in. */
interface Target {
  url: string;
  /** Navigations off it go outside; "" for a page of the shell's own. */
  origin: string;
}

/** What the window was last told to show. */
let shown: Target | undefined;

/** The window's URL query: the key that lets the page open its socket
 *  (server/server.ts, server/sharing.ts), and the scripts' switches —
 *  ?fixture: canned data, for screenshots; ?awake: a window driven from
 *  behind everything else, which must not go to sleep on its driver
 *  (scripts/shot.mjs, web/src/lib/awake.ts). */
function pageQuery(key: string): string {
  return [
    `token=${encodeURIComponent(key)}`,
    process.env["RURI_FIXTURE"] && "fixture",
    process.env["RURI_AWAKE"] && "awake",
  ]
    .filter(Boolean)
    .join("&");
}

function createWindow(target: Target): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: "#f6f1e6",
    // the peek band is the title bar on macOS, under the traffic lights; a
    // Linux desktop keeps its own title bar (a frameless window there has
    // no buttons to close it by, nor the desktop's own look)
    ...(MAC ? { titleBarStyle: "hiddenInset" as const } : {}),
    title: "ruri",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // the attachment viewer previews PDFs in an iframe via Chromium's
      // built-in PDF plugin, which is off by default
      plugins: true,
      // what the page may ask of this shell rather than of the server —
      // which computer it is onto, above all (desktop/preload.ts)
      preload: path.join(import.meta.dirname, "preload.cjs"),
    },
  });
  // Links open outside, and only web links: anything a page could hand
  // shell.openExternal is handed the user's default app for its scheme,
  // so schemes are allowlisted rather than passed through.
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
    const origin = shown?.origin;
    if (origin && (url === origin || url.startsWith(`${origin}/`))) return;
    event.preventDefault();
    openOutside(url);
  });
  shown = target;
  void win.loadURL(target.url);
  // the menu is for its shortcuts (Ctrl+Q, copy and paste, zoom); a bar of
  // File and Edit across the top of the page is not how ruri looks
  if (!MAC) win.setMenuBarVisibility(false);
  appWindow = win;
  win.on("closed", () => {
    if (appWindow === win) appWindow = undefined;
  });

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

/** Show a page in the app's window — the one that is up, or a new one. */
function show(target: Target): void {
  const win = appWindow;
  if (!win || win.isDestroyed()) {
    createWindow(target);
    return;
  }
  shown = target;
  void win.loadURL(target.url);
}

/** Whether this computer is letting other devices use it (server/sharing.ts). */
function sharingOn(): boolean {
  try {
    return (JSON.parse(fs.readFileSync(configPath("sharing.json"), "utf8")) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

/** `ruri --serve`: up with no window, for a computer other devices use. */
const SERVE = process.argv.includes("--serve");

/** No screen to draw on: Linux with neither X nor Wayland — a computer
 *  reached over SSH, a service started at boot before anyone logs in. */
const HEADLESS = process.platform === "linux" && !process.env["DISPLAY"] && !process.env["WAYLAND_DISPLAY"];

/** How an invite's words are put on a terminal: numbered, three a line. */
function inviteText(words: string[], expires: number): string {
  const until = new Date(expires).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const cells = words.map((w, i) => `${i + 1} ${w}`.padEnd(14));
  return (
    `\nTo use ${computerName()} from another device: open ruri there, Settings, Devices,\n` +
    `pick ${computerName()} and type these six words. They pair one device, once, until ${until}.\n\n` +
    `    ${cells.slice(0, 3).join("")}\n    ${cells.slice(3).join("")}\n`
  );
}

/** An invite from the ruri running on this computer, over its local port
 *  with its token (server/routes.ts) — sharing is turned on if it was off. */
async function localInvite(port: number, token: string): Promise<{ words: string[]; expires: number }> {
  const res = await fetch(`http://127.0.0.1:${port}/sharing/invite`, {
    method: "POST",
    headers: { "x-ruri-token": token },
  });
  const body = (await res.json()) as { words?: string[]; expires?: number; error?: string };
  if (!res.ok || !body.words || !body.expires) throw new Error(body.error ?? `status ${res.status}`);
  return { words: body.words, expires: body.expires };
}

/** `ruri --invite`: ask the ruri already running here for an invite, print
 *  it, and go — for a computer reached over ssh, with nobody at its screen. */
async function printInvite(): Promise<number> {
  const port = Number(process.env["RURI_PORT"] ?? DESKTOP_PORT);
  let token: string;
  try {
    token = fs.readFileSync(configPath("token"), "utf8").trim();
  } catch {
    console.error(
      "ruri isn't running on this computer. Start it first — `ruri --serve` runs it with no window.",
    );
    return 1;
  }
  try {
    const { words, expires } = await localInvite(port, token);
    console.log(inviteText(words, expires));
    return 0;
  } catch (err) {
    console.error(`No invite: ${errorMessage(err)}`);
    return 1;
  }
}

function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      // the app menu is the Mac's; elsewhere Quit lives in File
      { role: MAC ? "appMenu" : "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
}

async function main(): Promise<void> {
  // With no screen, Chromium stops as it starts ("Missing X server") —
  // and it picks its platform before anything here could change it. So
  // the process becomes itself again, told to draw nowhere: the same pid,
  // which a service manager is watching. This runs before Chromium's own
  // start-up, which waits for this script.
  if (HEADLESS && !process.argv.includes("--ozone-platform=headless")) {
    process.execve?.(process.execPath, [
      process.execPath,
      ...process.argv.slice(1),
      "--ozone-platform=headless",
    ]);
  }
  // `ruri --invite` is a question for the ruri already running, not a
  // second one: asked, answered on the terminal, and gone
  if (process.argv.includes("--invite")) {
    app.exit(await printInvite());
    return;
  }
  // Dev/screenshot runs: an isolated userData keeps the single-instance lock
  // (and caches) from colliding with an installed ruri.app that's running.
  const userData = process.env["RURI_USER_DATA"];
  if (userData) app.setPath("userData", userData);
  // Chromium's own on-disk state (storage, caches, the bridge's logins)
  // goes to userData, which on Linux is ~/.config/ruri — ruri's own config
  // dir. It gets a folder of its own there instead of spreading through it.
  else if (!MAC) app.setPath("userData", path.join(app.getPath("appData"), "ruri", "chromium"));
  // a second launch says what screen it has, so a ruri serving with none
  // can hand over to one opened on a screen (second-instance, below)
  const screenEnv = {
    DISPLAY: process.env["DISPLAY"] ?? "",
    WAYLAND_DISPLAY: process.env["WAYLAND_DISPLAY"] ?? "",
    XAUTHORITY: process.env["XAUTHORITY"] ?? "",
  };
  if (!app.requestSingleInstanceLock(screenEnv)) {
    app.quit();
    return;
  }
  // `ruri --quit` is for a ruri that is running; this one only started
  if (process.argv.includes("--quit")) {
    console.error("ruri isn't running on this computer.");
    app.exit(1);
    return;
  }
  // The window is a page on 127.0.0.1, and Chromium caches what it fetches
  // from there as if it were the far side of the world — it had put by
  // 600 MB of a localhost app's own uploads. A cache of the local disk
  // saves nothing; capping it small keeps Chromium's bookkeeping and no
  // more. The cap is per storage partition, so the bridge's windows (real
  // sites, where a cache does earn its keep) get the same modest one each.
  app.commandLine.appendSwitch("disk-cache-size", String(CACHE_CAP_BYTES));
  // drawing nowhere (main() started this process again headless): the
  // bridge's windows still render, off screen, without a GPU to do it
  if (HEADLESS) app.disableHardwareAcceleration();
  // the login shell and Electron's own start-up take their time side by
  // side; the server (which spawns CLIs off PATH) starts after both
  await Promise.all([fixPath(), app.whenReady()]);
  buildMenu();
  // whatever the old, uncapped cache put by is let go of — once. Clearing
  // it at every launch threw away the bundle and the code V8 compiled from
  // it, so every launch parsed and compiled the whole page again.
  const capped = path.join(app.getPath("userData"), "cache-capped");
  if (!fs.existsSync(capped)) {
    void session.defaultSession
      .clearCache()
      .then(() => fs.writeFileSync(capped, ""))
      .catch(() => {});
  }
  prunePartitions(app.getPath("userData"));

  const staticDir = path.join(import.meta.dirname, "..", "dist-web");
  // the windows and apps sessions drive to look at what they built — the
  // server owns the tools, this shell owns the windows (desktop/bridge.ts)
  const bridge = new Bridge();
  // the window's key to the server: a script that drives the app sets it
  // (scripts/lib/server.ts), a launch from the Dock gets a fresh one
  const token = process.env["RURI_TOKEN"] || randomBytes(32).toString("hex");
  // the other computers this device is paired with, and which one, if
  // any, the window is onto (desktop/remote.ts) — their certificates are
  // theirs alone, and Chromium is told so
  const remote = new Remote();
  remote.pin(session.defaultSession);

  // This computer's server: running while the window is onto this
  // computer (or while it serves others), and not at all while the window
  // is onto another — that is the point of using another.
  let server: ServerProcess | undefined;
  let running: ServerUp | undefined;
  /** The computer the window is onto, and where it answered ("" while it
   *  cannot be reached). Undefined: this one. */
  let away: { host: Host; address: string } | undefined;
  /** The check on the far computer, or the next try at reaching it. */
  let watch: NodeJS.Timeout | undefined;

  const localTarget = (): Target => {
    const origin = `http://127.0.0.1:${running!.port}`;
    return { origin, url: `${origin}/?${pageQuery(token)}` };
  };
  const remoteTarget = (host: Host, address: string): Target => {
    const origin = `https://${urlHost(address)}:${host.port}`;
    return { origin, url: `${origin}/?${pageQuery(host.key)}` };
  };

  /** Start this computer's server; false if it could not. */
  const startLocal = async (): Promise<boolean> => {
    if (running) return true;
    // The server runs in a process of its own, not on this thread: this
    // thread is the one every keystroke reaches the window through, and the
    // server's work — histories read, archives written, git asked — held
    // them up (server/hostLink.ts, desktop/serverProcess.ts). What it needs
    // of the shell it asks for, and gets from the services below.
    const started = new ServerProcess(
      path.join(import.meta.dirname, "server.mjs"),
      {
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
      },
      {
        pickFolder: async () => {
          const win = appWindow;
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
        // macOS's grants; Linux has none to read or ask for (Settings says so)
        ...(MAC ? { permissions } : {}),
        windowDrag,
      },
    );
    let up: ServerUp;
    try {
      up = await started.launch();
    } catch (err) {
      dialog.showErrorBox("ruri could not start", `Its server stopped as it started: ${errorMessage(err)}`);
      return false;
    }
    server = started;
    running = up;
    // a server started again after one died comes back on the same port, and
    // the window's socket finds it there; only if something else has taken
    // the port since does the window need a page from the new one
    started.onRestart = (again) => {
      if (server !== started || again.port === running?.port) return;
      running = again;
      if (away || !appWindow) return;
      const stale = appWindow;
      appWindow = undefined;
      createWindow(localTarget());
      stale.destroy();
    };
    // A GUI app's stdout goes nowhere anyone will look, and a window on an
    // unexpected origin is indistinguishable from a ruri that has lost its
    // settings. So the one case the server could not fix itself is said out
    // loud, with the thing to do about it.
    if (up.portFallback) {
      const { wanted, reason } = up.portFallback;
      void dialog.showMessageBox({
        type: "warning",
        title: "ruri is on a different port",
        message: `Port ${wanted} was not available, so ruri started on ${up.port}.`,
        detail:
          `${reason[0]!.toUpperCase()}${reason.slice(1)}.\n\n` +
          `Your projects and sessions are all here — but this window is a new origin, ` +
          `so anything the window itself remembers (sidebar widths, what was last open) ` +
          `starts fresh. Free port ${wanted} and relaunch to get it back.`,
        buttons: ["OK"],
      });
    }
    return true;
  };

  /** Close this computer's server down — every chat on it stopped,
   *  everything written — waiting no longer than a quit would. */
  const stopLocal = async (): Promise<void> => {
    const stopping = server;
    server = undefined;
    running = undefined;
    if (!stopping) return;
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS).unref?.());
    await Promise.race([Promise.allSettled([bridge.closeAll(), stopping.close()]), deadline]);
  };

  const stopWatching = (): void => {
    clearTimeout(watch);
    watch = undefined;
  };

  /** Put a page in the window — or, with the window closed (macOS keeps
   *  the app without one), keep it for when it opens again: a check in the
   *  background never opens a window by itself. */
  const present = (target: Target, open: boolean): void => {
    if (open || appWindow) show(target);
    else shown = target;
  };

  /** Onto another computer: find it, show it, and keep an eye on it.
   *  `open`: a window is wanted for it now, not only if one is up. */
  const goRemote = async (host: Host, open = false): Promise<void> => {
    stopWatching();
    try {
      const address = await remote.reach(host);
      // a choice made since this began is not undone by its answer
      if (away?.host.id !== host.id) return;
      away = { host, address };
      present(remoteTarget(host, address), open);
      // Every quarter of a minute: is it still there? Two misses running
      // — a laptop gone from home to a café, the other computer asleep —
      // and every address it goes by is tried again, which either finds
      // it somewhere else or says it can't be reached.
      let misses = 0;
      const check = async (): Promise<void> => {
        if (away?.host.id !== host.id || away.address !== address) return;
        misses = (await remote.answers(host, address)) ? 0 : misses + 1;
        if (away?.host.id !== host.id) return;
        if (misses >= 2) void goRemote(host);
        else watch = setTimeout(() => void check(), 15_000);
      };
      watch = setTimeout(() => void check(), 15_000);
    } catch (err) {
      if (away?.host.id !== host.id) return;
      away = { host, address: "" };
      const unpaired = err instanceof Unreachable && err.unpaired;
      present(
        {
          origin: "",
          url: offlinePage({
            name: host.name,
            detail: errorMessage(err),
            addresses: host.addresses,
            unpaired,
          }),
        },
        open,
      );
      // tried again until it answers, or the user goes back to this computer
      if (!unpaired) watch = setTimeout(() => void goRemote(host), 5_000);
    }
  };

  /** The window onto this computer again. */
  const useLocal = async (): Promise<void> => {
    stopWatching();
    away = undefined;
    remote.use(undefined);
    if (await startLocal()) show(localTarget());
  };

  /** The window onto another computer — and this one's server stopped. */
  const useHost = async (host: Host): Promise<void> => {
    remote.use(host.id);
    away = { host, address: "" };
    // off this computer's page first: it is about to have no server
    if (running) present({ origin: "", url: movingPage(host.name) }, false);
    await stopLocal();
    await goRemote(host, true);
  };

  // What the page may ask of this shell (desktop/preload.ts) — the page in
  // the app's window only, not one a bridge window is showing.
  const fromWindow = (event: IpcMainEvent | IpcMainInvokeEvent) =>
    appWindow !== undefined && event.sender === appWindow.webContents;
  const shellState = () => ({
    computer: computerName(),
    user: os.userInfo().username,
    using: away ? { id: away.host.id, name: away.host.name, address: away.address } : null,
    // never the keys: the page has no need of them
    hosts: remote
      .hosts()
      .map((h) => ({ id: h.id, name: h.name, addresses: h.addresses, pairedAt: h.pairedAt })),
  });
  ipcMain.handle("ruri:state", (event) => (fromWindow(event) ? shellState() : null));
  /** The user's other computers, found afresh (desktop/peers.ts). */
  let peers: Peer[] = [];
  ipcMain.handle("ruri:peers", async (event) => {
    if (!fromWindow(event)) return [];
    peers = await discover(remote);
    return peers;
  });
  /** Answered first, then the switch: the page that asked is replaced. */
  const switchTo = (host: Host) => setTimeout(() => void useHost(host), 600);
  // Set a computer up over SSH and pair with it — no invite; each step the
  // far side reports goes to the page as it happens (desktop/sshSetup.ts)
  ipcMain.handle("ruri:setup", async (event, raw: unknown) => {
    if (!fromWindow(event) || !raw || typeof raw !== "object")
      return { ok: false, error: "Not from this window." };
    const ask = raw as { user?: unknown; address?: unknown; install?: unknown; password?: unknown };
    if (
      typeof ask.user !== "string" ||
      !ask.user.trim() ||
      typeof ask.address !== "string" ||
      !ask.address.trim()
    ) {
      return { ok: false, error: "Say which account and computer." };
    }
    const address = ask.address.trim();
    const outcome = await setUpOverSsh(
      {
        user: ask.user.trim(),
        address,
        device: computerName().replace(/[^\w .-]/g, ""),
        install: ask.install === true,
        ...(typeof ask.password === "string" && ask.password ? { password: ask.password } : {}),
      },
      (step) => {
        if (!event.sender.isDestroyed()) event.sender.send("ruri:setup-step", step);
      },
    );
    if (!outcome.ok) return outcome;
    const host = remote.adopt(outcome.pairing, address);
    switchTo(host);
    return { ok: true, name: host.name, harnesses: outcome.harnesses };
  });
  // Pair by an invite's six words, with whichever computer made them: the
  // one at `address` if given, else each found with sharing on that this
  // device isn't paired with yet
  ipcMain.handle("ruri:pair-words", async (event, raw: unknown) => {
    if (!fromWindow(event) || !raw || typeof raw !== "object")
      return { ok: false, error: "Not from this window." };
    const ask = raw as { words?: unknown; address?: unknown; port?: unknown };
    const read = readWords(typeof ask.words === "string" ? ask.words : "");
    if ("error" in read) return { ok: false, error: read.error };
    let spots: Spot[];
    if (typeof ask.address === "string" && ask.address.trim()) {
      spots = [{ address: ask.address.trim(), port: typeof ask.port === "number" ? ask.port : 7775 }];
    } else {
      if (!peers.length) peers = await discover(remote);
      spots = peers.flatMap((p) =>
        p.ruri && !p.ruri.hostId ? [{ address: p.ruri.address, port: p.ruri.port }] : [],
      );
    }
    try {
      const { host } = await remote.pairWords(read.words, spots);
      switchTo(host);
      return { ok: true, name: host.name };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  });
  ipcMain.handle("ruri:use", (event, id: unknown) => {
    if (!fromWindow(event)) return;
    if (id === null) {
      void useLocal();
      return;
    }
    const host = remote.hosts().find((h) => h.id === id);
    if (host) void useHost(host);
  });
  ipcMain.handle("ruri:forget", (event, id: unknown) => {
    if (!fromWindow(event) || typeof id !== "string") return null;
    const inUse = away?.host.id === id;
    remote.forget(id);
    if (inUse) void useLocal();
    return shellState();
  });
  ipcMain.handle("ruri:retry", (event) => {
    if (fromWindow(event) && away) void goRemote(away.host);
  });
  ipcMain.on("ruri:drag", (event, phase: unknown) => {
    if (fromWindow(event) && ["start", "move", "end", "zoom"].includes(phase as string)) {
      windowDrag(phase as WindowDragPhase);
    }
  });

  const onto = SERVE ? undefined : remote.current();
  if (onto) {
    away = { host: onto, address: "" };
    await goRemote(onto, true);
  } else {
    if (!(await startLocal())) {
      app.quit();
      return;
    }
    if (SERVE) {
      // with nobody at the screen, the way in is printed: sharing on, and
      // an invite for the first device (`ruri --invite` makes more)
      try {
        const { words, expires } = await localInvite(running!.port, token);
        console.log(inviteText(words, expires));
      } catch (err) {
        console.error(`ruri is up, but sharing is not: ${errorMessage(err)}`);
      }
    } else {
      createWindow(localTarget());
      // a fresh build is a stranger to macOS: it asks for its grants again,
      // dialog by dialog, once the window is up (desktop/permissions.ts)
      if (MAC) setTimeout(() => void askAgainIfNewBuild().catch(() => {}), 1500);
    }
  }

  /** The window again, showing what it last showed. */
  const reopen = (): void => {
    if (shown) show(shown);
    else if (running) show(localTarget());
  };

  app.on("second-instance", (_event, argv, _cwd, data) => {
    if (argv.includes("--quit")) {
      app.quit();
      return;
    }
    // asked to serve, it already is
    if (argv.includes("--serve")) return;
    // Opened on a screen while this one serves with none (started at boot,
    // or over SSH): it cannot show a window, so it hands over — started
    // again with that screen, as the ruri the user just opened. The chats
    // pick up where they were, as after any relaunch.
    const screen = data as Partial<typeof screenEnv> | undefined;
    if (HEADLESS && (screen?.DISPLAY || screen?.WAYLAND_DISPLAY)) {
      for (const [name, value] of Object.entries(screen)) if (value) process.env[name] = value;
      app.relaunch({ args: process.argv.slice(1).filter((a) => a !== "--serve") });
      app.quit();
      return;
    }
    const win = appWindow;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else reopen();
  });

  // macOS: closing the window keeps the app (and its warm sessions) alive;
  // the Dock icon reopens it. Cmd+Q actually quits and tears sessions down.
  // Linux has nothing to reopen a windowless app from, so closing the
  // window is the quit there, teardown and all — unless this computer is
  // serving other devices, which are using it whether or not its own
  // window is open. Launching ruri again brings the window back.
  app.on("activate", () => {
    if (!appWindow) reopen();
  });
  app.on("window-all-closed", () => {
    if (MAC) return;
    if (!away && (SERVE || sharingOn())) return;
    app.quit();
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
    stopWatching();
    const teardown = Promise.allSettled([bridge.closeAll(), server?.close()]);
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, QUIT_TIMEOUT_MS).unref?.());
    void Promise.race([teardown, deadline]).then(() => app.quit());
  });
  // a signal to stop is a quit like Cmd+Q: SIGTERM (a plain `kill`, a
  // supervisor) used to end the process on the spot, and with it whatever
  // the archive had not yet written
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void (server?.close() ?? Promise.resolve()).finally(() => app.quit());
    });
  }
}

// A GUI app has no terminal to die into: what nobody caught is logged and
// the app stays up, since the window and its sessions are worth more than
// a clean exit code.
process.on("unhandledRejection", (err) => warn("desktop", err, "unhandled rejection"));
process.on("uncaughtException", (err) => warn("desktop", err, "uncaught exception"));

void main();
