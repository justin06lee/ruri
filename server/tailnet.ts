import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The tailnet, as this machine's Tailscale sees it: one read of
 * `tailscale status --json`. Tailscale is how ruri finds the user's other
 * computers — Settings → Devices (desktop/peers.ts) and the Passwords
 * page's look for a ghostly vault (server/vaultFinder.ts) both start here.
 *
 * Never throws: no Tailscale, or one that is off, is an answer too.
 */

/** One device on the tailnet. */
export interface TailnetDevice {
  /** What the tailnet calls it: "midna", "Justin's Mac mini". */
  name: string;
  /** Its MagicDNS name, without the dot at the end: "midna.tail1234.ts.net".
   *  Empty when the tailnet has MagicDNS off. */
  host: string;
  /** Its tailnet IPv4 addresses. */
  addresses: string[];
  /** "macOS", "linux", "iOS"…, as Tailscale says. */
  os?: string;
  online: boolean;
  /** The machine ruri runs on. */
  self: boolean;
  /** Tailscale SSH is on there: signing in needs no key or password. */
  ssh: boolean;
  /** Shared in from someone else's tailnet, rather than one of the user's own. */
  shared: boolean;
}

export interface Tailnet {
  /** "none": no Tailscale on this machine. "off": installed, not connected. */
  state: "none" | "off" | "connected";
  /** The tailnet's own domain, when connected: "tail1234.ts.net". */
  name?: string;
  /** This machine first, then the rest by name. */
  devices: TailnetDevice[];
}

/** A Mac app started from the Finder has no Homebrew on its PATH, and the
 *  Tailscale app keeps its command line inside its bundle. */
const PLACES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/usr/sbin/tailscale",
];
const STATUS_MS = 5_000;

interface RawDevice {
  HostName?: string;
  DNSName?: string;
  OS?: string;
  Online?: boolean;
  TailscaleIPs?: string[];
  sshHostKeys?: string[] | null;
}

/** The parts of `tailscale status --json` read here. */
interface RawStatus {
  BackendState?: string;
  MagicDNSSuffix?: string;
  CurrentTailnet?: { MagicDNSSuffix?: string } | null;
  Self?: RawDevice | null;
  Peer?: Record<string, RawDevice> | null;
}

function executable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Every tailscale command here. RURI_TAILSCALE names the one to use
 *  instead — a test's stand-in — or "" for none, which is what tests set. */
function commands(): string[] {
  const given = process.env["RURI_TAILSCALE"];
  if (given !== undefined) return given && executable(given) ? [given] : [];
  const onPath = (process.env["PATH"] ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "tailscale"));
  return [...new Set([...onPath, ...PLACES])].filter(executable);
}

function ask(command: string): Promise<RawStatus | undefined> {
  return new Promise((resolve) => {
    // a client a version apart from the daemon warns on stderr; stdout is still the answer
    execFile(
      command,
      ["status", "--json"],
      { timeout: STATUS_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error && !stdout) return resolve(undefined);
        try {
          const parsed = JSON.parse(stdout) as RawStatus;
          resolve(parsed && typeof parsed === "object" ? parsed : undefined);
        } catch {
          resolve(undefined);
        }
      },
    );
  });
}

function device(raw: RawDevice, self: boolean, suffix: string): TailnetDevice | null {
  const host = (raw.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  // a phone calls itself "localhost": its tailnet name says which it is
  const label = host.split(".")[0] ?? "";
  const name = (raw.HostName && raw.HostName !== "localhost" ? raw.HostName : label) || raw.HostName || "";
  if (!name) return null;
  return {
    name,
    host,
    addresses: (raw.TailscaleIPs ?? []).filter((ip) => !ip.includes(":")),
    ...(raw.OS ? { os: raw.OS } : {}),
    // Tailscale reports this machine as offline to itself now and then
    online: self || raw.Online === true,
    self,
    ssh: Array.isArray(raw.sshHostKeys) && raw.sshHostKeys.length > 0,
    shared: suffix !== "" && host !== "" && !host.endsWith(`.${suffix}`),
  };
}

/** What Tailscale says about the tailnet this machine is on. */
export async function readTailnet(): Promise<Tailnet> {
  const found = commands();
  if (found.length === 0) return { state: "none", devices: [] };
  let said: RawStatus | undefined;
  // more than one can be installed, and not every one reaches the running daemon
  for (const command of found) {
    const answer = await ask(command);
    if (answer?.BackendState === "Running") {
      said = answer;
      break;
    }
  }
  if (!said) return { state: "off", devices: [] };
  const suffix = (said.CurrentTailnet?.MagicDNSSuffix || said.MagicDNSSuffix || "").toLowerCase();
  const me = said.Self ? device(said.Self, true, suffix) : null;
  const others = Object.values(said.Peer ?? {})
    .map((raw) => device(raw, false, suffix))
    .filter((d): d is TailnetDevice => d !== null)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    state: "connected",
    ...(suffix ? { name: suffix } : {}),
    devices: [...(me ? [me] : []), ...others],
  };
}
