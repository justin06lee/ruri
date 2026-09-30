import { execFile, spawn } from "node:child_process";
import { desktopCapturer } from "electron";
import { sleep } from "../server/cdp.js";
import { projectEnv } from "../server/shots.js";
import type { AppHandle } from "./apps.js";
import { resolveApp } from "./desktopEntries.js";

/**
 * Native apps on a Linux desktop, for the bridge — the Linux half of
 * desktop/apps.ts, which hands over to this file for everything but
 * Electron apps (those are driven over CDP the same on both).
 *
 * The same promise as on macOS: launched and driven without the user
 * noticing. An app is found the way the desktop finds it — its .desktop
 * entry, by id or by name — or run as a command, and started with a
 * startup id whose time is zero, which tells the window manager not to
 * give it the focus (GNOME's mutter then stacks it under the window in
 * use: `open -g`, near enough). Its windows are found on the X server with
 * xdotool, photographed there (a compositing window manager keeps every
 * window's own picture, so one behind others still comes out whole), and
 * its controls are read and driven over the accessibility bus, AT-SPI —
 * through python3's GObject bindings, since nothing else speaks it — which
 * reaches a window that is not in front, as System Events does. AT-SPI is
 * spoken over D-Bus directly (see ATSPI_PRELUDE), so GTK 3 and 4, Qt and
 * Chromium apps all answer the same way.
 *
 * X11 only: on a Wayland session no app may see or photograph another's
 * windows, and the tools say so rather than pretend. GTK apps are on the
 * accessibility bus by default; Qt and Chromium ones only when asked, so
 * they are launched with the environment that asks.
 */

type Launched = Omit<AppHandle, "handle">;

/** How long an app gets to show a window after it is started. */
const OPEN_TIMEOUT_MS = 15_000;
/** How long a close gets to be graceful before it is a signal. */
const QUIT_GRACE_MS = 3_000;
/** UI trees stop here, however deep the app goes — as on macOS. */
const TREE_MAX_ELEMENTS = 400;
const TREE_MAX_CHARS = 24_000;

/* ── shell helpers ──────────────────────────────────────────────── */

function run(cmd: string, args: string[], timeoutMs = 20_000, input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT") reject(new Error(`${cmd} is not installed`));
          else reject(new Error(String(stderr || error.message).trim()));
          return;
        }
        resolve(String(stdout).replace(/\n$/, ""));
      },
    );
    if (input !== undefined) child.stdin?.end(input);
  });
}

function runBuffer(cmd: string, args: string[], timeoutMs = 15_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) reject(new Error(String(stderr || error.message).trim()));
        else resolve(stdout);
      },
    );
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Every native tool starts here: the windows have to be reachable. */
function requireX11(doing: string): void {
  if (
    process.env["XDG_SESSION_TYPE"] === "wayland" ||
    (!process.env["DISPLAY"] && process.env["WAYLAND_DISPLAY"])
  ) {
    throw new Error(
      `${doing} needs an X11 session: this desktop runs Wayland, where one app cannot see, photograph or drive another's windows. Web pages (web_open) and Electron apps (app_launch with a command) still work; for native apps the user can pick "Ubuntu on Xorg" at the login screen.`,
    );
  }
  if (!process.env["DISPLAY"])
    throw new Error(`${doing} needs a display, and ruri has none (DISPLAY is not set).`);
}

/** xdotool, or the sentence that says it is missing. */
async function xdotool(args: string[], timeoutMs = 8_000): Promise<string> {
  try {
    return await run("xdotool", args, timeoutMs);
  } catch (err) {
    if (err instanceof Error && /not installed/.test(err.message)) {
      throw new Error(
        "driving native apps needs xdotool — ask the user to install it (sudo apt install xdotool)",
        {
          cause: err,
        },
      );
    }
    throw err;
  }
}

/** Visible windows by a search (--pid, --class, ...), newest last; [] for none. */
async function search(args: string[]): Promise<number[]> {
  try {
    const out = await xdotool(["search", "--onlyvisible", ...args]);
    return out
      .split("\n")
      .map(Number)
      .filter((id) => Number.isFinite(id) && id > 0);
  } catch (err) {
    // xdotool exits 1 when nothing matches; missing altogether is news
    if (err instanceof Error && err.message.startsWith("driving native apps needs xdotool")) throw err;
    return [];
  }
}

async function windowPid(win: number): Promise<number | undefined> {
  try {
    const pid = Number(await xdotool(["getwindowpid", String(win)]));
    return Number.isFinite(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

async function exists(win: number): Promise<boolean> {
  try {
    await xdotool(["getwindowname", String(win)]);
    return true;
  } catch {
    return false;
  }
}

/** The window in use right now, for putting back afterwards. */
export async function activeWindow(): Promise<number | undefined> {
  try {
    const id = Number(await xdotool(["getactivewindow"], 3_000));
    return Number.isFinite(id) && id > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/** Put a window back in front. Best-effort. */
export async function restoreFocus(win: number | undefined): Promise<void> {
  if (!win) return;
  if ((await activeWindow()) === win) return;
  try {
    await xdotool(["windowactivate", String(win)], 3_000);
  } catch {
    // stays where it is
  }
}

/** Visible windows whose WM_CLASS is one of these. */
async function windowsOfClasses(classes: string[]): Promise<number[]> {
  const found = new Set<number>();
  for (const cls of classes) {
    const escaped = cls.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const id of await search(["--class", `^${escaped}$`])) found.add(id);
  }
  return [...found];
}

/* ── launching ──────────────────────────────────────────────────── */

/** The environment a launched app gets: the project's, plus what puts Qt
 *  and Chromium apps on the accessibility bus, plus a startup id that asks
 *  the window manager not to hand it the focus. */
function launchEnv(): NodeJS.ProcessEnv {
  return {
    ...projectEnv(),
    DESKTOP_STARTUP_ID: `ruri-${process.pid}-${Date.now()}_TIME0`,
    QT_ACCESSIBILITY: "1",
    QT_LINUX_ACCESSIBILITY_ALWAYS_ON: "1",
    ACCESSIBILITY_ENABLED: "1",
    NO_AT_BRIDGE: "0",
  };
}

/** Open an app in the background and find its window. */
export async function launchNative(app: string, files: string[] = []): Promise<Launched> {
  requireX11("launching a native app");
  const target = resolveApp(app, files);
  const before = await activeWindow();
  const already = await windowsOfClasses(target.classes);
  const [cmd, ...args] = target.argv;
  if (!cmd) throw new Error(`"${app}" has no command to run`);
  const child = spawn(cmd, args, { env: launchEnv(), detached: true, stdio: "ignore" });
  let spawnError: Error | undefined;
  child.once("error", (err) => (spawnError = err));
  child.unref();
  const until = Date.now() + OPEN_TIMEOUT_MS;
  let win: number | undefined;
  while (Date.now() < until && !win) {
    await sleep(250);
    if (spawnError) throw new Error(`couldn't start ${target.name}: ${spawnError.message}`);
    if (child.pid) win = (await search(["--pid", String(child.pid)])).at(-1);
    // an app that hands the launch to a copy already running (most GNOME
    // apps do) exits at once; its window is the running copy's
    if (!win) {
      const now = await windowsOfClasses(target.classes);
      win = now.find((id) => !already.includes(id)) ?? (child.exitCode !== null ? now.at(-1) : undefined);
    }
  }
  if (!win) throw new Error(`${target.name} never showed a window`);
  const pid = (await windowPid(win)) ?? child.pid ?? 0;
  // the startup id keeps most apps from taking the focus; for one that
  // takes it anyway, the window that had it gets it back
  await sleep(already.length ? 300 : 1200);
  if (before && (await activeWindow()) === win) await restoreFocus(before);
  return {
    kind: "native",
    pid,
    app: target.name,
    address: target.address,
    preexisting: already.length > 0,
    window: win,
  };
}

/** The app's window as it is now — the one it opened with while that is
 *  still up, else its newest. */
async function windowOf(app: AppHandle): Promise<number> {
  requireX11("reaching a native app");
  if (app.window && (await exists(app.window))) return app.window;
  const win = (await search(["--pid", String(app.pid)])).at(-1);
  if (!win) throw new Error(`${app.app} has no window open`);
  app.window = win;
  return win;
}

export async function windowTitle(app: AppHandle): Promise<string | undefined> {
  try {
    return (await xdotool(["getwindowname", String(await windowOf(app))], 4_000)).trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function activate(app: AppHandle): Promise<void> {
  const win = await windowOf(app);
  await xdotool(["windowactivate", String(win)], 4_000);
}

/* ── quitting ───────────────────────────────────────────────────── */

/** Close its windows the way the close button does (so it can save what
 *  it saves), then insist — never with a signal on an app that was the
 *  user's before this session. */
export async function quit(app: AppHandle, immediate = false): Promise<string> {
  if (!immediate) {
    const windows = await search(["--pid", String(app.pid)]).catch(() => []);
    for (const win of windows) {
      try {
        await run("wmctrl", ["-i", "-c", `0x${win.toString(16)}`], 3_000);
      } catch {
        try {
          await xdotool(["windowclose", String(win)], 3_000);
        } catch {
          // the signal below
        }
      }
    }
    const until = Date.now() + QUIT_GRACE_MS;
    while (Date.now() < until && alive(app.pid)) await sleep(200);
  }
  if (!alive(app.pid)) return "quit";
  if (app.preexisting)
    return "asked to close — it was already running before this session, so it is not being forced";
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

/* ── pictures ───────────────────────────────────────────────────── */

/**
 * A picture of the app's window, wherever it is in the stack: Electron's
 * capturer by the X window id (its sources are named window:<id>:0), and
 * ImageMagick's `import` off the X server when that yields nothing.
 */
export async function captureNative(app: AppHandle): Promise<{ png: Buffer; title: string }> {
  const win = await windowOf(app);
  const title = (await windowTitle(app)) ?? app.app;
  let width = 0;
  let height = 0;
  try {
    const geometry = await xdotool(["getwindowgeometry", "--shell", String(win)]);
    width = Number(/WIDTH=(\d+)/.exec(geometry)?.[1] ?? 0);
    height = Number(/HEIGHT=(\d+)/.exec(geometry)?.[1] ?? 0);
  } catch {
    // the capturer's own size, then
  }
  try {
    const sources = await desktopCapturer.getSources({
      types: ["window"],
      thumbnailSize: { width: width || 1600, height: height || 1200 },
    });
    const source =
      sources.find((s) => s.id === `window:${win}:0`) ??
      sources.find((s) => s.id.startsWith(`window:${win}:`));
    if (source && !source.thumbnail.isEmpty()) return { png: source.thumbnail.toPNG(), title };
  } catch {
    // the X server itself, below
  }
  try {
    const png = await runBuffer("import", ["-window", String(win), "png:-"]);
    if (png.length < 100) throw new Error("empty capture");
    return { png, title };
  } catch (err) {
    throw new Error(
      `couldn't photograph ${app.app}: ${err instanceof Error ? err.message : String(err)} (the X server's copy needs ImageMagick: sudo apt install imagemagick)`,
      { cause: err },
    );
  }
}

/* ── the accessibility bus ──────────────────────────────────────── */

/**
 * The Python every AT-SPI call runs in. `app` is the application whose
 * process is argv[1] (found on the bus by pid, or by the pid of a window
 * it owns); the tree walk and the script helpers below are what the tools
 * offer. Raw, so its backslashes stay Python's.
 *
 * It speaks AT-SPI's D-Bus protocol itself (Gio) rather than through
 * libatspi, whose list of applications leaves GTK 4 apps out on Ubuntu
 * 24.04 (Calculator, Text Editor — most of GNOME); the registry's own list
 * leaves GTK 3 ones out instead. So the app is found as a connection on
 * the accessibility bus with the right pid, and asked directly, every
 * toolkit answers alike.
 */
const ATSPI_PRELUDE = String.raw`
import os, subprocess, sys
from gi.repository import Gio, GLib

PID = int(sys.argv[1])
MAX_N = int(sys.argv[2])
ACC = "org.a11y.atspi.Accessible"
ROOT = "/org/a11y/atspi/accessible/root"
STATE_WORDS = ((4, "checked"), (23, "selected"), (12, "focused"), (10, "expanded"))
SENSITIVE = 24
WINDOW_COORDS = 1
NOISE = ("clipboard.", "selection.", "link.", "menu.popup", "misc.")

def _safe(f, default=""):
    try:
        v = f()
        return default if v is None else v
    except Exception:
        return default

def _call_on(bus, name, path, iface, method, args=None, reply=None, timeout=4000):
    v = bus.call_sync(name, path, iface, method, args, GLib.VariantType(reply) if reply else None,
                      Gio.DBusCallFlags.NONE, timeout, None)
    return v.unpack() if v is not None else None

def _addresses():
    # A display can have an accessibility bus of its own, named on its root
    # window (GTK 3 and libatspi look there first), apart from the session's
    # (GTK 4 asks the session first). On a desktop they are one bus; on a
    # second X server they are not, so both are searched.
    out = []
    xprop = _safe(lambda: subprocess.run(["xprop", "-root", "AT_SPI_BUS"], capture_output=True, text=True, timeout=3).stdout)
    if '"' in xprop:
        out.append(xprop.split('"')[1])
    session = _safe(lambda: Gio.bus_get_sync(Gio.BusType.SESSION, None), None)
    if session is not None:
        addr = _safe(lambda: _call_on(session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None, "(s)", 5000)[0])
        if addr and addr not in out:
            out.append(addr)
    return out

class El:
    def __init__(self, bus, name, path):
        self.bus, self.bus_name, self.path = bus, name, path
        self._ifaces = None
    def __repr__(self):
        return "<" + role(self) + " " + repr(name(self)) + ">"
    def call(self, iface, method, args=None, reply=None, timeout=4000):
        return _call_on(self.bus, self.bus_name, self.path, iface, method, args, reply, timeout)
    def prop(self, iface, key):
        return self.call("org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", (iface, key)), "(v)")[0]
    def ifaces(self):
        if self._ifaces is None:
            self._ifaces = _safe(lambda: self.call(ACC, "GetInterfaces", None, "(as)")[0], [])
        return self._ifaces

def _find_app():
    # Every connection on the bus with the app's pid, not the registry's
    # list of children: GTK 3 apps are missing from that, as GTK 4 ones are
    # from libatspi's. Each toolkit keeps its application at the same root.
    for address in _addresses():
        bus = _safe(lambda: Gio.DBusConnection.new_for_address_sync(
            address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION,
            None, None), None)
        if bus is None:
            continue
        names = _safe(lambda: _call_on(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                       "ListNames", None, "(as)")[0], [])
        for bus_name in names:
            if not bus_name.startswith(":"):
                continue
            pid = _safe(lambda: _call_on(bus, "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
                                         "GetConnectionUnixProcessID", GLib.Variant("(s)", (bus_name,)), "(u)", 2000)[0], None)
            if pid != PID:
                continue
            root = El(bus, bus_name, ROOT)
            if _safe(lambda: root.call(ACC, "GetRoleName", None, "(s)", 2000)[0]) == "application":
                return root
    return None

app = _find_app()
if app is None:
    sys.stderr.write("NOT_ON_BUS\n")
    sys.exit(3)

def role(el):
    return _safe(lambda: el.call(ACC, "GetRoleName", None, "(s)")[0])

def name(el):
    return _safe(lambda: el.prop(ACC, "Name"))

def description(el):
    return _safe(lambda: el.prop(ACC, "Description"))

def children(el):
    kids = _safe(lambda: el.call(ACC, "GetChildren", None, "(a(so))")[0], [])
    return [El(el.bus, n, p) for n, p in kids if p and p != "/org/a11y/atspi/null"]

def text(el):
    ifs = el.ifaces()
    if "org.a11y.atspi.Text" in ifs:
        n = _safe(lambda: el.prop("org.a11y.atspi.Text", "CharacterCount"), 0)
        if n:
            return _safe(lambda: el.call("org.a11y.atspi.Text", "GetText",
                                       GLib.Variant("(ii)", (0, n)), "(s)")[0])
    if "org.a11y.atspi.Value" in ifs:
        v = _safe(lambda: el.prop("org.a11y.atspi.Value", "CurrentValue"), None)
        return "" if v is None else ("%g" % v)
    return ""

def _states(el):
    words = _safe(lambda: el.call(ACC, "GetState", None, "(au)")[0], None)
    if not words:
        return []
    has = lambda bit: len(words) > bit // 32 and bool(words[bit // 32] & (1 << (bit % 32)))
    out = [word for bit, word in STATE_WORDS if has(bit)]
    if role(el) in ("push button", "button", "toggle button", "menu item", "check box", "text", "entry") and not has(SENSITIVE):
        out.append("disabled")
    return out

def _actions(el):
    if "org.a11y.atspi.Action" not in el.ifaces():
        return []
    return [a[0] for a in _safe(lambda: el.call("org.a11y.atspi.Action", "GetActions", None, "(a(sss))")[0], [])]

def windows():
    return children(app)

window = (windows() or [app])[0]

def find_all(name=None, role=None, within=None, limit=2000):
    want = None if name is None else str(name).lower()
    out, queue, seen = [], children(within or window), 0
    while queue and seen < limit:
        el = queue.pop(0)
        seen += 1
        if (role is None or globals()["role"](el) == role) and (want is None or globals()["name"](el).lower() == want):
            out.append(el)
        queue.extend(children(el))
    return out

def find(name=None, role=None, within=None, nth=0):
    found = find_all(name, role, within)
    if len(found) <= nth:
        what = " ".join(x for x in (role and ("a " + role), name and repr(name)) if x) or "anything"
        where = globals()["name"](within or window) or "the window"
        raise LookupError("no " + what + (" (#" + str(nth) + ")" if nth else "") + " in " + where)
    return found[nth]

def click(el):
    names = [a.lower() for a in _actions(el)]
    for want in ("click", "press", "activate", "toggle", "jump", "open"):
        if want in names:
            el.call("org.a11y.atspi.Action", "DoAction", GLib.Variant("(i)", (names.index(want),)), "(b)")
            return el
    if names:
        el.call("org.a11y.atspi.Action", "DoAction", GLib.Variant("(i)", (0,)), "(b)")
        return el
    raise RuntimeError(role(el) + " " + repr(name(el)) + " has no action to click")

def set_text(el, value):
    ok = _safe(lambda: el.call("org.a11y.atspi.EditableText", "SetTextContents",
                             GLib.Variant("(s)", (str(value),)), "(b)")[0], False)
    if not ok:
        raise RuntimeError(role(el) + " " + repr(name(el)) + " would not take the text")
    return el

def menu(*path):
    at = app
    for part in path:
        at = find(name=part, within=at)
    return click(at)

def _line(el, depth):
    r = role(el)
    n = name(el)
    d = description(el)
    v = text(el).replace("\n", " ")
    out = "  " * depth + r
    if n:
        out += ' "' + n + '"'
    if d and d != n:
        out += " (" + d + ")"
    if v and v != n:
        out += " = " + (v[:80] + "..." if len(v) > 80 else v)
    st = _states(el)
    if st:
        out += " [" + ", ".join(st) + "]"
    # GTK 4 gives every label and field its context menu's actions; they
    # say nothing about what the control is for
    acts = [a for a in _actions(el) if a and not a.startswith(NOISE)]
    if acts:
        out += " {" + ", ".join(acts) + "}"
    if "org.a11y.atspi.Component" in el.ifaces():
        ext = _safe(lambda: el.call("org.a11y.atspi.Component", "GetExtents",
                                  GLib.Variant("(u)", (WINDOW_COORDS,)), "((iiii))")[0], None)
        if ext and ext[2] > 0 and ext[3] > 0:
            out += " @%d,%d %dx%d" % ext
    return out

def tree(depth):
    lines, count = [], [0]
    def walk(el, d):
        if count[0] >= MAX_N:
            return
        count[0] += 1
        lines.append(_line(el, d))
        if d < depth:
            for c in children(el):
                walk(c, d + 1)
    for w in windows():
        walk(w, 0)
    return "\n".join(lines) or "(no windows)"
`;

/** The script's own Python, run after the prelude, with what it prints as
 *  the answer. */
const SCRIPT_RUNNER = String.raw`
_src = sys.stdin.read()
exec(compile(_src, "app_ui", "exec"), globals())
`;

const TREE_RUNNER = String.raw`
print(tree(int(sys.argv[3])))
`;

async function atspi(
  app: AppHandle,
  body: string,
  args: string[],
  input: string,
  doing: string,
): Promise<string> {
  const win = await windowOf(app);
  // the process that owns the window is the one on the bus: an app that
  // handed its launch on is the copy that was already running
  const pid = (await windowPid(win)) ?? app.pid;
  try {
    return await run(
      "python3",
      ["-c", ATSPI_PRELUDE + body, String(pid), String(TREE_MAX_ELEMENTS), ...args],
      60_000,
      input,
    );
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (/NOT_ON_BUS/.test(text)) {
      throw new Error(
        `${doing}: ${app.app} is not on the accessibility bus. GTK apps are, and ruri launches Qt and Chromium ones asking for it; an app started before that (or outside ruri) needs a restart from app_launch — or accessibility turned on for the whole desktop (gsettings set org.gnome.desktop.interface toolkit-accessibility true).`,
        { cause: err },
      );
    }
    if (/No module named 'gi'|not installed/.test(text)) {
      throw new Error(
        `${doing} needs python3 with the GObject bindings — ask the user to install them (sudo apt install python3-gi)`,
        { cause: err },
      );
    }
    // a Python error: its last line says what went wrong
    const last = text.split("\n").filter(Boolean).at(-1) ?? text;
    throw new Error(`${doing}: ${last}`, { cause: err });
  }
}

/** Every window's controls, as lines, to a depth. */
export async function uiTree(app: AppHandle, depth = 4): Promise<string> {
  const clamped = String(Math.max(0, Math.min(12, Math.floor(depth))));
  let text = await atspi(app, TREE_RUNNER, [clamped], "", "reading the UI tree");
  if (text.length > TREE_MAX_CHARS)
    text = `${text.slice(0, TREE_MAX_CHARS)}\n… (cut at ${TREE_MAX_CHARS} characters — ask for less depth)`;
  return text;
}

/** Run a Python fragment against the app's accessibility tree. */
export async function uiScript(app: AppHandle, script: string): Promise<string> {
  const out = await atspi(app, SCRIPT_RUNNER, [], script, "the script");
  return out.trim() || "ok";
}
