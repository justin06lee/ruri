import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "./log.js";
import { lastSaid, quote, refused, sshArgs, sshEnv, sshProgram, type SshLogin } from "./ssh.js";

/**
 * Setting ghostly up from the Passwords page: a vault on one of the
 * user's devices (`ghostly-server install --tailscale`, here or over SSH),
 * its signups closed once the owner has made their account, and ghostly
 * itself installed on this machine — each one a short script, run by
 * `sh -s` here or on the far side of an SSH sign-in (server/ssh.ts).
 *
 * The scripts install what ghostly's own README says to: its installer,
 * from ghostly's repository. What only a person can do — Docker on the
 * device, HTTPS switched on for the tailnet, the owner's own account in
 * the vault — is said in ghostly-server's own words when it is missing.
 *
 * A script says how it is getting on in lines the page shows as they
 * come: GHOSTLY-STEP <what>, then GHOSTLY-URL <address> or GHOSTLY-DONE,
 * or GHOSTLY-ERROR <why>. Anything else it prints is shown as it is.
 */

const INSTALLER = "https://raw.githubusercontent.com/justin06lee/ghostly/master/install.sh";

/** Docker pulls Vaultwarden's image on a first install: minutes, not hours. */
const SCRIPT_MS = 20 * 60_000;

/** Where a script runs: this machine, or another one signed in to over SSH. */
export type Where = { local: true } | { local: false; login: SshLogin };

/** How a script came out. */
export interface Outcome {
  /** It finished what it set out to do. */
  done: boolean;
  /** The vault's address, from a server setup. */
  url?: string;
  error?: string;
  /** SSH turned the key away: a password would let it go on. */
  needsPassword?: boolean;
}

/** What every script starts with: one stream of output, and the folders a
 *  login shell would add to PATH (an SSH command gets a bare one) — after
 *  what it already has, so the PATH it was given is the one that wins. */
function preamble(): string {
  return `exec 2>&1
PATH="$PATH:$HOME/.local/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.docker/bin:$HOME/.orbstack/bin:/Applications/Docker.app/Contents/Resources/bin"
HOST=$(hostname 2>/dev/null || uname -n)
INSTALLER=${quote(INSTALLER)}
step() { printf 'GHOSTLY-STEP %s\\n' "$*"; }
fail() { printf 'GHOSTLY-ERROR %s\\n' "$*"; exit 0; }
`;
}

/** A vault on this device, served inside the tailnet. A device that has
 *  ghostly-server already (stopped, or for itself only) is installed again
 *  in Tailscale mode, which keeps its data. */
export function serverScript(): string {
  return `${preamble()}
command -v curl >/dev/null 2>&1 || fail "curl isn't installed on $HOST."
command -v bash >/dev/null 2>&1 || fail "bash isn't installed on $HOST."
command -v docker >/dev/null 2>&1 || fail "ghostly's vault runs in Docker, which isn't installed on $HOST. Install it there (OrbStack or Docker Desktop on a Mac), then try again."
if command -v ghostly-server >/dev/null 2>&1; then
  step "ghostly-server is on $HOST already: serving it on your tailnet"
  ghostly-server install --tailscale </dev/null || fail "ghostly-server stopped on $HOST (what it said is above)."
else
  step "Getting ghostly's installer on $HOST"
  SCRIPT=$(curl -fsSL "$INSTALLER") || fail "Couldn't download ghostly's installer on $HOST."
  step "Setting the vault up on $HOST. A first one pulls Vaultwarden's image, which takes a minute or two"
  printf '%s\\n' "$SCRIPT" | bash -s -- server --tailscale || fail "Setting the vault up on $HOST stopped (what it said is above)."
fi
URL=$(ghostly-server url 2>/dev/null </dev/null) || fail "The vault on $HOST did not say its address."
printf 'GHOSTLY-URL %s\\n' "$URL"
`;
}

/** Signups closed: from now on only addresses invited to an organization
 *  can make an account — the agent's, made after the owner's, included. */
export function signupsScript(): string {
  return `${preamble()}
command -v ghostly-server >/dev/null 2>&1 || fail "ghostly-server isn't on $HOST."
step "Closing signups on $HOST"
ghostly-server signups off </dev/null || fail "ghostly-server couldn't close signups on $HOST (what it said is above)."
printf 'GHOSTLY-DONE\\n'
`;
}

/** ghostly itself, the agent's side, on this machine. It runs on bun. */
export function agentScript(): string {
  return `${preamble()}
command -v curl >/dev/null 2>&1 || fail "curl isn't installed on $HOST."
command -v bun >/dev/null 2>&1 || fail "ghostly runs on bun, which isn't installed here: https://bun.sh"
step "Getting ghostly's installer"
SCRIPT=$(curl -fsSL "$INSTALLER") || fail "Couldn't download ghostly's installer."
step "Installing ghostly"
printf '%s\\n' "$SCRIPT" | bash -s -- agent || fail "Installing ghostly stopped (what it said is above)."
printf 'GHOSTLY-DONE\\n'
`;
}

/**
 * Run a script, here or over SSH, in a process group of its own so a
 * timeout stops everything it started. `onLine` hears each line it says,
 * as it says it. `env` is added to a script run here (a test's own PATH
 * and HOME).
 */
export function runScript(
  where: Where,
  script: string,
  onLine: (line: string) => void,
  options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<Outcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = where.local
        ? spawn("/bin/sh", ["-s"], {
            env: { ...process.env, ...options.env },
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          })
        : spawn(sshProgram(), sshArgs(where.login), {
            env: sshEnv(where.login),
            stdio: ["pipe", "pipe", "pipe"],
            detached: true,
          });
    } catch (err) {
      resolve({ done: false, error: errorMessage(err) });
      return;
    }
    let pending = "";
    let stderr = "";
    let said = false;
    let url: string | undefined;
    let error: string | undefined;
    let done = false;
    let timedOut = false;
    const hear = (raw: string) => {
      // a terminal's colours, should anything print them anyway
      // eslint-disable-next-line no-control-regex
      const line = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
      if (!line.trim()) return;
      said = true;
      if (line.startsWith("GHOSTLY-STEP ")) onLine(line.slice(13));
      else if (line.startsWith("GHOSTLY-URL ")) url = line.slice(12).trim();
      else if (line.startsWith("GHOSTLY-ERROR ")) error = line.slice(14);
      else if (line === "GHOSTLY-DONE") done = true;
      else onLine(line);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      lines.forEach(hear);
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-8_000)));
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }, options.timeoutMs ?? SCRIPT_MS);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        done: false,
        error: where.local
          ? errorMessage(err)
          : `Couldn't run ssh here: ${err.message}. Is OpenSSH installed?`,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (pending) hear(pending);
      if (error) return resolve({ done: false, error });
      if (url) return resolve({ done: true, url });
      if (done) return resolve({ done: true });
      if (timedOut) return resolve({ done: false, error: "It took too long, and was stopped." });
      if (!where.local && refused(stderr)) {
        const { user, address, password } = where.login;
        return resolve({
          done: false,
          needsPassword: true,
          error: password
            ? `${user}@${address} didn't take that password.`
            : `${address} wants a password for ${user}.`,
        });
      }
      const last = lastSaid(stderr);
      resolve({
        done: false,
        error: last
          ? where.local
            ? last
            : `ssh: ${last}`
          : `It stopped (exit ${code ?? "?"})${said ? "" : " before it said anything"}.`,
      });
    });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(script);
  });
}

/** Where ghostly keeps the password it made for this machine's agent. */
export function agentPasswordFile(): string {
  return path.join(
    process.env["GHOSTLY_HOME"] || path.join(os.homedir(), ".ghostly"),
    "agent",
    "master-password",
  );
}

/** One run of a clipboard tool: its exit code and what it printed. */
function tool(argv: string[], input?: string): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    child.on("error", () => resolve({ code: null, out: "" }));
    child.on("close", (code) => resolve({ code, out }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}

/** macOS: written through NSPasteboard and marked concealed, which is how
 *  clipboard managers know to keep it out of their history. */
const CONCEALED_COPY = `
ObjC.import("AppKit");
const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
const text = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
const board = $.NSPasteboard.generalPasteboard;
board.clearContents;
board.setStringForType(text, "public.utf8-plain-text");
board.setStringForType("", "org.nspasteboard.ConcealedType");
`;

function tools(): { copy: string[]; paste: string[]; clear: string[] } | null {
  if (process.platform === "darwin") return { copy: ["pbcopy"], paste: ["pbpaste"], clear: ["pbcopy"] };
  if (process.env["WAYLAND_DISPLAY"])
    return { copy: ["wl-copy"], paste: ["wl-paste", "--no-newline"], clear: ["wl-copy", "--clear"] };
  if (process.env["DISPLAY"]) {
    const clip = ["xclip", "-selection", "clipboard"];
    return { copy: clip, paste: [...clip, "-o"], clear: clip };
  }
  return null;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Put a value on this machine's clipboard, and take it off again after
 * `seconds` — only if it is still what the clipboard holds by then, so
 * whatever the user copied since is left alone. Throws when there is no
 * clipboard to put it on.
 */
export async function copyForAWhile(value: string, seconds = 30): Promise<void> {
  const use = tools();
  if (!use) throw new Error("this machine has no clipboard ruri can reach");
  const concealed =
    process.platform === "darwin"
      ? await tool(["osascript", "-l", "JavaScript", "-e", CONCEALED_COPY], value)
      : null;
  if (concealed?.code !== 0) {
    const plain = await tool(use.copy, value);
    if (plain.code !== 0) throw new Error("couldn't put it on the clipboard");
  }
  const hash = digest(value);
  setTimeout(() => {
    void tool(use.paste).then((now) => {
      if (now.code === 0 && digest(now.out) === hash) void tool(use.clear);
    });
  }, seconds * 1000).unref();
}
