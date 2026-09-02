import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app as electronApp, desktopCapturer, screen, systemPreferences } from "electron";
import { CdpSocket, PageDriver, findPageTarget, freePort, sleep } from "../server/cdp.js";
import { projectEnv } from "../server/shots.js";

/**
 * Desktop apps, launched and driven for a session without the user
 * noticing.
 *
 * Two kinds. A dev-built Electron app is started with a debugging port and
 * driven over CDP exactly like a page in the hidden window — the same
 * driver, the same verbs — and photographed by the compositor, which does
 * not care what is in front of it. Anything else is opened with `open -g`
 * (launched, not activated: the user's focus stays where it is), reached
 * through the Accessibility tree by way of System Events, and photographed
 * off the window server by window id, which works for a window that is
 * behind ruri.
 *
 * On hiding: a hidden app (the Cmd+H kind) keeps its Accessibility tree,
 * but the window server has no picture of it and neither does the
 * compositor of an Electron app that has been told it is occluded — so
 * nothing here hides anything. Launched apps stay visible-but-behind:
 * `open -g` puts a native app there to begin with, and an Electron app that
 * activated itself on launch has the app that was in front put back in
 * front. That is the whole of the focus handling, and it means captures
 * always work.
 *
 * Permissions, on first use, for ruri (or for whatever launched it in a dev
 * run): Automation → System Events, for any of the AppleScript; Accessibility,
 * for the UI tree and UI scripting; Screen Recording, for native window
 * pictures. Each of those failing is turned into a sentence that says so.
 */

export interface AppHandle {
  handle: string;
  kind: "electron" | "native";
  pid: number;
  /** The app's name as System Events knows it, or the command's basename. */
  app: string;
  /** What was launched: the app's path, or the command line. */
  address: string;
  /** The app was already running when the session asked for it, so it is
   *  the user's: quitting is polite and never a signal. */
  preexisting: boolean;
  /** Electron only. */
  driver?: PageDriver;
  socket?: CdpSocket;
  child?: ChildProcess;
}

/** How long a command gets to open a page target. */
const ATTACH_TIMEOUT_MS = 30_000;
/** How long an app gets to show up as a process after `open`. */
const OPEN_TIMEOUT_MS = 15_000;
/** How long a quit gets to be graceful before it is a signal. */
const QUIT_GRACE_MS = 3_000;
/** UI trees stop here, however deep the app goes. */
const TREE_MAX_ELEMENTS = 400;
/** And so do the words. */
const TREE_MAX_CHARS = 24_000;

let nextHandle = 0;

/* ── shell helpers ──────────────────────────────────────────────── */

function run(cmd: string, args: string[], timeoutMs = 20_000, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const said = String(stderr || error.message).trim();
        reject(new Error(said.replace(/^\d+:\d+:\s*/, "").replace(/^execution error:\s*/, "")));
        return;
      }
      resolve(String(stdout).replace(/\n$/, ""));
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
  });
}

/** AppleScript, from a file so it can be as long as it needs to be. */
async function applescript(source: string, timeoutMs = 20_000): Promise<string> {
  const file = path.join(os.tmpdir(), `ruri-bridge-${process.pid}-${Date.now()}.applescript`);
  fs.writeFileSync(file, source);
  try {
    return await run("osascript", [file], timeoutMs);
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** JavaScript for Automation, one expression. */
function jxa(source: string, timeoutMs = 10_000): Promise<string> {
  return run("osascript", ["-l", "JavaScript", "-e", source], timeoutMs);
}

/** A string, as an AppleScript literal. */
function asLiteral(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The errors macOS gives when a permission is missing, said plainly. */
function explain(err: unknown, doing: string): Error {
  const text = err instanceof Error ? err.message : String(err);
  if (/not allowed assistive access|-25211|-1719|assistive/i.test(text)) {
    return new Error(
      `${doing} needs Accessibility: macOS has not granted it to ruri. Tell the user to allow ruri under System Settings → Privacy & Security → Accessibility, then try again.`,
    );
  }
  if (/-1743|not authorized to send Apple events/i.test(text)) {
    return new Error(
      `${doing} needs Automation: macOS has not let ruri control System Events. Tell the user to allow it under System Settings → Privacy & Security → Automation (ruri → System Events), then try again.`,
    );
  }
  return new Error(`${doing}: ${text}`);
}

/* ── launching ──────────────────────────────────────────────────── */

/** Where an app named like a person names it actually lives. */
async function resolveApp(app: string): Promise<string> {
  if (app.endsWith(".app") && fs.existsSync(app)) return path.resolve(app);
  if (fs.existsSync(app) && app.includes("/")) return path.resolve(app);
  // mdfind knows every bundle Launch Services does, and needs no permission
  const name = app.replace(/\.app$/, "");
  try {
    const found = (await run("mdfind", [`kMDItemKind == "Application" && kMDItemDisplayName == "${name}"`]))
      .split("\n")
      .filter((line) => line.endsWith(".app"));
    // /System and /Applications before anything in a build folder
    const ranked = found.sort((a, b) => rank(a) - rank(b));
    if (ranked[0]) return ranked[0];
  } catch {
    // fall through
  }
  for (const dir of ["/Applications", "/System/Applications", "/System/Applications/Utilities", path.join(os.homedir(), "Applications")]) {
    const candidate = path.join(dir, `${name}.app`);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no app called "${app}" — give its path`);
}

function rank(appPath: string): number {
  if (appPath.startsWith("/System/Applications/")) return 0;
  if (appPath.startsWith("/Applications/")) return 1;
  if (appPath.startsWith(path.join(os.homedir(), "Applications"))) return 2;
  return 3;
}

/** A bundle's name as System Events will call the process. */
async function bundleName(appPath: string): Promise<string> {
  const plist = path.join(appPath, "Contents", "Info");
  for (const key of ["CFBundleName", "CFBundleDisplayName", "CFBundleExecutable"]) {
    try {
      const value = (await run("defaults", ["read", plist, key])).trim();
      if (value) return value;
    } catch {
      // next key
    }
  }
  return path.basename(appPath, ".app");
}

/** The newest process running out of this bundle, if any. */
async function pidOfBundle(appPath: string): Promise<number | undefined> {
  try {
    const out = await run("pgrep", ["-n", "-f", `^${path.join(appPath, "Contents", "MacOS")}/`]);
    const pid = Number(out.trim().split("\n")[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** The app in front right now, by System Events' name for it. */
async function frontmostName(): Promise<string | undefined> {
  try {
    return await applescript('tell application "System Events" to get name of first process whose frontmost is true', 4_000);
  } catch {
    return undefined;
  }
}

/** Put an app back in front, by name. Best-effort. */
async function bringForward(name: string): Promise<void> {
  try {
    await applescript(`tell application "System Events" to set frontmost of process ${asLiteral(name)} to true`, 4_000);
  } catch {
    // stays where it is
  }
}

/** Open a `.app` in the background. */
export async function launchNative(app: string, files: string[] = []): Promise<AppHandle> {
  const appPath = await resolveApp(app);
  const name = await bundleName(appPath);
  const preexisting = (await pidOfBundle(appPath)) !== undefined;
  // -g: launched, not activated — the user's focus stays where it is
  await run("open", ["-g", "-a", appPath, ...files]);
  const until = Date.now() + OPEN_TIMEOUT_MS;
  let pid: number | undefined;
  while (Date.now() < until) {
    pid = await pidOfBundle(appPath);
    if (pid) break;
    await sleep(250);
  }
  if (!pid) throw new Error(`${name} never came up`);
  // give it a moment to make a window before anyone asks for one
  await sleep(preexisting ? 300 : 1200);
  nextHandle += 1;
  return { handle: `app-${nextHandle}`, kind: "native", pid, app: name, address: appPath, preexisting };
}

/**
 * Run a command that starts an Electron app, with a debugging port added,
 * and attach to its first page. Whoever was in front before is put back
 * there afterwards, since an app's first window tends to take the focus
 * with it.
 */
export async function launchElectron(command: string, args: string[], cwd?: string): Promise<AppHandle> {
  const port = await freePort();
  const before = await frontmostName();
  let child: ChildProcess;
  try {
    child = spawn(command, [...args, `--remote-debugging-port=${port}`], {
      cwd: cwd ?? process.cwd(),
      env: projectEnv(),
      // its own process group, so stopping it stops what it started
      detached: true,
      stdio: "ignore",
    });
  } catch (err) {
    throw new Error(`couldn't start ${command}: ${err instanceof Error ? err.message : String(err)}`);
  }
  child.on("error", () => {
    // surfaces as a missing page target below
  });
  let target;
  try {
    target = await findPageTarget(port, ATTACH_TIMEOUT_MS);
  } catch (err) {
    stop(child);
    throw err;
  }
  const socket = await CdpSocket.connect(target.webSocketDebuggerUrl);
  const driver = new PageDriver(socket);
  await driver.enable();
  // a window that just appeared is very likely in front now; put the
  // user's app back, and ruri itself if that was the one
  await sleep(400);
  const after = await frontmostName();
  if (before && after && after !== before) {
    if (before === electronApp.name || before === "Electron") electronApp.focus({ steal: true });
    else await bringForward(before);
  }
  nextHandle += 1;
  return {
    handle: `app-${nextHandle}`,
    kind: "electron",
    pid: child.pid ?? 0,
    app: path.basename(command),
    address: [command, ...args].join(" "),
    preexisting: false,
    driver,
    socket,
    child,
  };
}

function stop(child: ChildProcess): void {
  const signal = (sig: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch {
      // already gone
    }
  };
  signal("SIGTERM");
  const hard = setTimeout(() => signal("SIGKILL"), QUIT_GRACE_MS);
  hard.unref();
}

/* ── quitting ───────────────────────────────────────────────────── */

/** Ask nicely, then insist. Answers with what it took. */
export async function quit(app: AppHandle, immediate = false): Promise<string> {
  app.driver?.dispose();
  if (app.kind === "electron") {
    try {
      await Promise.race([app.socket?.send("Browser.close"), sleep(1_000)]);
    } catch {
      // the socket may already be gone
    }
    app.socket?.close();
    if (!immediate) await sleep(500);
    if (app.child && (immediate || (app.pid && alive(app.pid)))) stop(app.child);
    return "closed";
  }
  if (!immediate) {
    try {
      // the app's own quit, which saves what it autosaves; a save sheet
      // holds this until the grace runs out
      await applescript(`tell application ${asLiteral(app.app)} to quit`, QUIT_GRACE_MS);
    } catch {
      // not answering — it gets the signal below
    }
    await sleep(300);
  }
  if (!alive(app.pid)) return "quit";
  if (app.preexisting) return "asked to quit — it was already running before this session, so it is not being forced";
  try {
    process.kill(app.pid, "SIGTERM");
  } catch {
    return "quit";
  }
  const hard = setTimeout(() => {
    try {
      process.kill(app.pid, "SIGKILL");
    } catch {
      // gone
    }
  }, QUIT_GRACE_MS);
  hard.unref();
  return "quit (by signal)";
}

/* ── the front of an app, for the user ──────────────────────────── */

export async function activate(app: AppHandle): Promise<void> {
  try {
    await applescript(
      [
        'tell application "System Events"',
        `  set p to first process whose unix id is ${app.pid}`,
        "  set visible of p to true",
        "  set frontmost of p to true",
        "end tell",
      ].join("\n"),
      4_000,
    );
  } catch (err) {
    throw explain(err, "bringing the app forward");
  }
}

/* ── the Accessibility tree ─────────────────────────────────────── */

/** How System Events is told which process: a native app by the name it
 *  was launched under, an Electron one by pid — its process name is
 *  whatever the bundle says, not the command that started it. */
function processRef(app: AppHandle): string {
  return app.kind === "native" ? `process ${asLiteral(app.app)}` : `(first process whose unix id is ${app.pid})`;
}

function requireAccessibility(doing: string): void {
  if (systemPreferences.isTrustedAccessibilityClient(false)) return;
  // the one prompt: macOS puts up its own dialog the first time
  systemPreferences.isTrustedAccessibilityClient(true);
  throw new Error(
    `${doing} needs Accessibility, which macOS has not granted to ruri. Tell the user to allow ruri under System Settings → Privacy & Security → Accessibility, then try again.`,
  );
}

const TREE_SCRIPT = `
property out : ""
property n : 0

on walk(el, depth, maxDepth)
  if n is greater than or equal to ${TREE_MAX_ELEMENTS} then return
  set n to n + 1
  set r to ""
  set nm to ""
  set d to ""
  set v to ""
  set pos to ""
  tell application "System Events"
    try
      set r to role of el
    end try
    try
      set nm to name of el
      if nm is missing value then set nm to ""
    end try
    try
      set d to description of el
      if d is missing value then set d to ""
    end try
    try
      set v to value of el
      if v is missing value then set v to ""
      set v to v as text
    end try
    try
      set p to position of el
      set s to size of el
      set pos to "@" & ((item 1 of p) as integer) & "," & ((item 2 of p) as integer) & " " & ((item 1 of s) as integer) & "x" & ((item 2 of s) as integer)
    end try
  end tell
  set pad to ""
  repeat depth times
    set pad to pad & "  "
  end repeat
  set lineText to pad & r
  if nm is not "" then set lineText to lineText & " \\"" & nm & "\\""
  if d is not "" and d is not nm then set lineText to lineText & " (" & d & ")"
  if v is not "" then
    if (count v) > 80 then set v to (text 1 thru 80 of v) & "..."
    set lineText to lineText & " = " & v
  end if
  if pos is not "" then set lineText to lineText & " " & pos
  set out to out & lineText & linefeed
  if depth < maxDepth then
    set kids to {}
    tell application "System Events"
      try
        set kids to UI elements of el
      end try
    end tell
    repeat with k in kids
      my walk(k, depth + 1, maxDepth)
    end repeat
  end if
end walk

set out to ""
set n to 0
tell application "System Events"
  set wins to windows of __APP__
end tell
if (count wins) is 0 then return "(no windows)"
repeat with w in wins
  my walk(w, 0, __DEPTH__)
end repeat
return out
`;

/** The front window's controls, as lines, to a depth. */
export async function uiTree(app: AppHandle, depth = 4): Promise<string> {
  requireAccessibility("reading the UI tree");
  let text: string;
  try {
    text = await applescript(
      TREE_SCRIPT.replace("__APP__", processRef(app)).replace("__DEPTH__", String(Math.max(0, Math.min(12, Math.floor(depth))))),
      60_000,
    );
  } catch (err) {
    throw explain(err, "reading the UI tree");
  }
  if (text.length > TREE_MAX_CHARS) text = `${text.slice(0, TREE_MAX_CHARS)}\n… (cut at ${TREE_MAX_CHARS} characters — ask for less depth)`;
  return text;
}

/** Run a fragment inside `tell process`. */
export async function uiScript(app: AppHandle, script: string): Promise<string> {
  requireAccessibility("UI scripting");
  const source = [
    'tell application "System Events"',
    `  tell ${processRef(app)}`,
    ...script.split("\n").map((line) => `    ${line}`),
    "  end tell",
    "end tell",
  ].join("\n");
  try {
    const out = await applescript(source, 60_000);
    return out.trim() || "ok";
  } catch (err) {
    throw explain(err, "the script");
  }
}

/** The front window's title, when Accessibility lets us ask. */
export async function windowTitle(app: AppHandle): Promise<string | undefined> {
  try {
    const title = await applescript(
      `tell application "System Events" to get name of window 1 of ${processRef(app)}`,
      4_000,
    );
    return title.trim() || undefined;
  } catch {
    return undefined;
  }
}

/* ── pictures of native windows ─────────────────────────────────── */

interface WindowInfo {
  id: number;
  name: string;
  bounds: { X: number; Y: number; Width: number; Height: number };
}

/** The app's on-screen windows, from the window server — no permission
 *  needed for ids and bounds (names come only with Screen Recording). */
async function windowsOf(pid: number): Promise<WindowInfo[]> {
  const out = await jxa(
    `ObjC.import("CoreGraphics");` +
      `const ref = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0);` +
      `const arr = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];` +
      `JSON.stringify(arr.filter(w => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0)` +
      `.map(w => ({ id: w.kCGWindowNumber, name: w.kCGWindowName || "", bounds: w.kCGWindowBounds })))`,
  );
  try {
    return JSON.parse(out) as WindowInfo[];
  } catch {
    return [];
  }
}

function requireScreenRecording(): void {
  const status = systemPreferences.getMediaAccessStatus("screen");
  if (status === "granted" || status === "not-determined" || status === "unknown") return;
  throw new Error(
    "photographing an app needs Screen Recording, which macOS has not granted to ruri. Tell the user to allow ruri under System Settings → Privacy & Security → Screen Recording and relaunch it, then try again.",
  );
}

/**
 * A picture of the app's front window, wherever it is in the stack.
 *
 * Two ways, tried in order. Electron's desktopCapturer lists windows by
 * the same id the window server uses, and its thumbnail is the window's
 * own contents at whatever size is asked for — so the id from
 * CGWindowList picks the source exactly, no title matching. When that
 * yields nothing (the permission just granted and not yet in effect, a
 * window the capturer won't list), `screencapture -l` takes the same
 * window by id straight off the window server.
 */
export async function captureNative(app: AppHandle): Promise<{ png: Buffer; title: string }> {
  requireScreenRecording();
  const windows = (await windowsOf(app.pid)).filter((w) => w.bounds.Width >= 8 && w.bounds.Height >= 8);
  const win = windows[0];
  if (!win) throw new Error(`${app.app} has no window on screen to photograph`);
  const title = win.name || (await windowTitle(app)) || app.app;
  const scale = screen.getDisplayNearestPoint({ x: win.bounds.X, y: win.bounds.Y }).scaleFactor || 1;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: Math.round(win.bounds.Width * scale), height: Math.round(win.bounds.Height * scale) },
    });
    const source = sources.find((s) => s.id === `window:${win.id}:0`) ?? sources.find((s) => s.id.startsWith(`window:${win.id}:`));
    if (source && !source.thumbnail.isEmpty()) return { png: source.thumbnail.toPNG(), title };
  } catch {
    // fall through to the window server
  }
  const file = path.join(os.tmpdir(), `ruri-bridge-${process.pid}-${Date.now()}.png`);
  try {
    await run("screencapture", ["-l", String(win.id), "-x", "-o", "-t", "png", file], 15_000);
    const png = fs.readFileSync(file);
    if (png.length < 100) throw new Error("empty capture");
    return { png, title };
  } catch (err) {
    throw new Error(
      `couldn't photograph ${app.app}: ${err instanceof Error ? err.message : String(err)}. If macOS just asked about Screen Recording, tell the user to allow ruri and relaunch it.`,
    );
  } finally {
    fs.rmSync(file, { force: true });
  }
}
