import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { app, desktopCapturer, shell, systemPreferences } from "electron";
import type { PermissionId, PermissionState, TccRow } from "../shared/protocol.js";

/**
 * What macOS has let ruri do, and the asking for it.
 *
 * Every grant — Accessibility, Screen Recording, the folders, the volumes —
 * is tied to the app's code signature. An ad-hoc-signed app is re-signed by
 * every build, so a grant made to last week's ruri is silently void for
 * this week's while the switch in System Settings still reads "on". That
 * is the shape of every "it worked yesterday" permission bug, and it is
 * invisible unless something shows the grants as macOS actually holds them.
 *
 * So: each permission ruri uses, with its state as read (not guessed), a
 * way to ask for it by hand, and — since ruri has Full Disk Access — the
 * privacy database's own rows for ruri and the CLIs its sessions run, so a
 * denial can be seen for what it is. `make update` resets the lot
 * (tccutil, in the Makefile) and the next launch asks again.
 */

const HOME = os.homedir();
const TCC_DB = path.join(HOME, "Library", "Application Support", "com.apple.TCC", "TCC.db");

/** System Settings, opened to the pane. */
const PANES: Record<PermissionId, string> = {
  accessibility: "Privacy_Accessibility",
  screen: "Privacy_ScreenCapture",
  automation: "Privacy_Automation",
  fullDisk: "Privacy_AllFiles",
  desktop: "Privacy_FilesAndFolders",
  documents: "Privacy_FilesAndFolders",
  downloads: "Privacy_FilesAndFolders",
  removable: "Privacy_FilesAndFolders",
  network: "Privacy_FilesAndFolders",
};

/** The privacy database's name for each. */
const SERVICES: Record<PermissionId, string> = {
  accessibility: "kTCCServiceAccessibility",
  screen: "kTCCServiceScreenCapture",
  automation: "kTCCServiceAppleEvents",
  fullDisk: "kTCCServiceSystemPolicyAllFiles",
  desktop: "kTCCServiceSystemPolicyDesktopFolder",
  documents: "kTCCServiceSystemPolicyDocumentsFolder",
  downloads: "kTCCServiceSystemPolicyDownloadsFolder",
  removable: "kTCCServiceSystemPolicyRemovableVolumes",
  network: "kTCCServiceSystemPolicyNetworkVolumes",
};

/** The privacy database's names, back into words. */
export const SERVICE_NAMES: Record<string, string> = {
  kTCCServiceAccessibility: "Accessibility",
  kTCCServiceScreenCapture: "Screen Recording",
  kTCCServiceAppleEvents: "Automation",
  kTCCServiceSystemPolicyAllFiles: "Full Disk Access",
  kTCCServiceSystemPolicyDesktopFolder: "Desktop folder",
  kTCCServiceSystemPolicyDocumentsFolder: "Documents folder",
  kTCCServiceSystemPolicyDownloadsFolder: "Downloads folder",
  kTCCServiceSystemPolicyRemovableVolumes: "Removable volumes",
  kTCCServiceSystemPolicyNetworkVolumes: "Network volumes",
  kTCCServiceListenEvent: "Input Monitoring",
  kTCCServiceCamera: "Camera",
  kTCCServiceMicrophone: "Microphone",
  kTCCServiceDeveloperTool: "Developer Tools",
};

const ABOUT: Array<{ id: PermissionId; name: string; why: string }> = [
  { id: "accessibility", name: "Accessibility", why: "driving native apps in the bridge — clicks, typing, the UI tree" },
  { id: "screen", name: "Screen Recording", why: "photographing apps and windows a session is looking at" },
  { id: "automation", name: "Automation", why: "AppleScript to System Events, which the bridge and app_ui use" },
  { id: "fullDisk", name: "Full Disk Access", why: "sessions reading and writing anywhere without a prompt per folder" },
  { id: "desktop", name: "Desktop folder", why: "projects and files that live on the Desktop" },
  { id: "documents", name: "Documents folder", why: "projects and files under Documents" },
  { id: "downloads", name: "Downloads folder", why: "files a session picks up from Downloads" },
  { id: "removable", name: "Removable volumes", why: "projects on an external drive — git in a checkout there fails without this" },
  { id: "network", name: "Network volumes", why: "projects on a network share" },
];

function run(cmd: string, args: string[], timeoutMs = 8_000): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, encoding: "utf8" }, (error, out, err) => {
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === "number"
        ? ((error as { code: number }).code)
        : error ? 1 : 0;
      resolve({ code, out: String(out ?? ""), err: String(err ?? "") });
    });
  });
}

/** Whether ruri can read the privacy database at all — which is itself the
 *  Full Disk Access check: nothing else opens that file. */
function fullDisk(): PermissionState["status"] {
  try {
    fs.accessSync(TCC_DB, fs.constants.R_OK);
    return "granted";
  } catch {
    return "denied";
  }
}

/**
 * The database's rows for the clients that matter here: ruri itself, the
 * harness CLIs its sessions run, and the shell those sessions' commands go
 * through (each is its own client, keyed by path — a new version of the
 * CLI is a stranger to macOS until it asks again).
 */
export async function tccRows(): Promise<TccRow[]> {
  if (fullDisk() !== "granted") return [];
  const shellPath = process.env["SHELL"] ?? "";
  const sql =
    "select service, client, client_type, auth_value, last_modified from access " +
    "where client like '%ruri%' or client like '%claude%' or client like '%codex%' " +
    "or client like '%anthropic%' or client like '%openai%' " +
    (shellPath ? `or client = '${shellPath.replaceAll("'", "''")}' ` : "") +
    "order by last_modified desc limit 80";
  const { code, out } = await run("/usr/bin/sqlite3", ["-json", "-readonly", TCC_DB, sql]);
  if (code !== 0 || !out.trim()) return [];
  try {
    const rows = JSON.parse(out) as Array<{
      service: string;
      client: string;
      client_type: number;
      auth_value: number;
      last_modified: number;
    }>;
    return rows.map((row) => ({
      service: SERVICE_NAMES[row.service] ?? row.service.replace(/^kTCCService/, ""),
      client: row.client,
      allowed: row.auth_value === 2,
      at: row.last_modified * 1000,
    }));
  } catch {
    return [];
  }
}

/** ruri's own row for a service, as the database has it — or nothing. */
async function recorded(id: PermissionId): Promise<boolean | undefined> {
  if (fullDisk() !== "granted") return undefined;
  const sql = `select auth_value from access where service = '${SERVICES[id]}' and client = '${BUNDLE_ID}' limit 1`;
  const { code, out } = await run("/usr/bin/sqlite3", ["-readonly", TCC_DB, sql]);
  if (code !== 0) return undefined;
  const value = out.trim();
  if (!value) return undefined;
  return value === "2";
}

const BUNDLE_ID = "com.justin06lee.ruri";

/** A folder or a volume, as reachable as macOS lets it be. Touching one
 *  that has not been asked about IS the asking — so this is only ever
 *  called to ask, never to look. */
function probeDir(dir: string): PermissionState["status"] {
  try {
    fs.readdirSync(dir);
    return "granted";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") return "denied";
    return "unknown";
  }
}

/** Every mounted volume that is not the boot volume. */
function externalVolumes(): string[] {
  try {
    return fs
      .readdirSync("/Volumes")
      // mounted disk images are not drives anyone keeps a project on
      .filter((name) => !name.startsWith("dmg."))
      .map((name) => path.join("/Volumes", name))
      .filter((p) => {
        try {
          return fs.realpathSync(p) !== "/";
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

async function automation(ask: boolean): Promise<PermissionState["status"]> {
  // System Events answers only a process macOS lets script it; the first
  // ask puts up the dialog, a refused one comes back as -1743
  const { code, err } = await run("/usr/bin/osascript", ["-e", 'tell application "System Events" to get name of first process'], ask ? 60_000 : 4_000);
  void ask;
  if (code === 0) return "granted";
  if (err.includes("-1743") || /not (permitted|allowed)/i.test(err)) return "denied";
  return "unknown";
}

async function stateOf(id: PermissionId, ask: boolean): Promise<PermissionState> {
  const about = ABOUT.find((a) => a.id === id)!;
  let status: PermissionState["status"] = "unknown";
  let detail: string | undefined;
  switch (id) {
    case "accessibility": {
      status = systemPreferences.isTrustedAccessibilityClient(ask) ? "granted" : "denied";
      break;
    }
    case "screen": {
      const media = systemPreferences.getMediaAccessStatus("screen");
      status = media === "granted" ? "granted" : media === "not-determined" ? "unasked" : media === "unknown" ? "unknown" : "denied";
      if (ask && status !== "granted") {
        // the first look through the capturer is what puts the dialog up
        try {
          await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } });
        } catch {
          // denied: nothing to see, and the pane opens below
        }
        const again = systemPreferences.getMediaAccessStatus("screen");
        status = again === "granted" ? "granted" : again === "not-determined" ? "unasked" : "denied";
      }
      break;
    }
    case "automation": {
      // looking must not ask: the probe itself is the dialog, so a look
      // reads the database's row and only an ask runs the script
      if (ask) status = await automation(true);
      else {
        const row = await recorded(id);
        status = row === undefined ? "unasked" : row ? "granted" : "denied";
      }
      break;
    }
    case "fullDisk": {
      status = fullDisk();
      break;
    }
    case "desktop":
    case "documents":
    case "downloads": {
      const dir = path.join(HOME, id === "desktop" ? "Desktop" : id === "documents" ? "Documents" : "Downloads");
      if (ask) status = probeDir(dir);
      else {
        const row = await recorded(id);
        status = row === undefined ? "unasked" : row ? "granted" : "denied";
      }
      break;
    }
    case "removable":
    case "network": {
      if (ask && id === "removable") {
        const volumes = externalVolumes();
        if (volumes.length === 0) {
          status = "unknown";
          detail = "no external volume is mounted to ask about";
        } else {
          const results = volumes.map((v) => [v, probeDir(v)] as const);
          status = results.every(([, s]) => s === "granted") ? "granted" : results.some(([, s]) => s === "denied") ? "denied" : "unknown";
          detail = results.map(([v, s]) => `${path.basename(v)}: ${s}`).join(" · ");
        }
      } else {
        const row = await recorded(id);
        status = row === undefined ? "unasked" : row ? "granted" : "denied";
        if (id === "removable") {
          const volumes = externalVolumes();
          if (volumes.length) detail = `mounted: ${volumes.map((v) => path.basename(v)).join(", ")}`;
        }
      }
      break;
    }
  }
  // the ask that macOS will not put up a dialog for — or one it already
  // refused — is answered by opening the pane where the switch is
  if (ask && status !== "granted" && !(status === "unasked" && (id === "removable" || id === "network"))) {
    void shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${PANES[id]}`);
  }
  return { id, name: about.name, why: about.why, status, ...(detail ? { detail } : {}) };
}

export interface PermissionHost {
  check(): Promise<PermissionState[]>;
  request(id?: PermissionId): Promise<PermissionState[]>;
  rows(): Promise<TccRow[]>;
}

export const permissions: PermissionHost = {
  async check() {
    return Promise.all(ABOUT.map((a) => stateOf(a.id, false)));
  },
  async request(id) {
    if (id) {
      await stateOf(id, true);
      return this.check();
    }
    // one at a time: macOS shows one dialog at a time, and each waits
    for (const a of ABOUT) await stateOf(a.id, true);
    return this.check();
  },
  rows: tccRows,
};

/**
 * A new build is a stranger to macOS (see the top of this file), so the
 * first launch of one asks for everything again — which is the second half
 * of what `make update` does when it resets the grants. Dev runs and test
 * harnesses are not builds and are left alone.
 */
export async function askAgainIfNewBuild(): Promise<void> {
  if (!app.isPackaged) return;
  const marker = path.join(app.getPath("userData"), "asked-permissions-for");
  let last = "";
  try {
    last = fs.readFileSync(marker, "utf8").trim();
  } catch {
    // never asked
  }
  const version = app.getVersion();
  if (last === version) return;
  try {
    fs.writeFileSync(marker, version);
  } catch {
    // then it asks again next launch too; no harm
  }
  await permissions.request();
}
