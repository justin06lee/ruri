import { spawn } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { errorMessage } from "./log.js";
import { findCommand } from "./projectHooks.js";

/**
 * ghostly, from ruri's side: the one file that runs its command.
 *
 * ghostly is a password vault an agent can use without being handed the
 * keys to everything: a Vaultwarden server the owner runs, an account of
 * the agent's own on it, and a collection the owner shares into. The
 * owner sets and takes away what is shared from any Bitwarden app; the
 * `ghostly` command on this machine is how the agent's side reads it.
 *
 * ruri is that agent's side. It asks ghostly what is shared, reads each
 * value into its own memory (server/secrets.ts — never onto its disk),
 * and from there on a secret is used exactly as one ruri kept itself:
 * a {{handle}} the hook fills in, an environment variable the harness is
 * handed, a value redacted on its way into a transcript.
 *
 * Three things hold for every call made here:
 *  - a secret never rides a command line, where `ps` would show it: it
 *    goes in on stdin, and comes back on stdout;
 *  - one command at a time. Each is a run of Bitwarden's own CLI
 *    underneath, which keeps one session file, and two at once can lock
 *    each other out;
 *  - every one has a limit, so a vault that does not answer costs a wait
 *    and a line on the page, never a server that hangs.
 */

/** What ghostly says about one item — never a secret. */
export interface GhostlyItem {
  id: string;
  name: string;
  /** "login", "note", "card", "identity", "ssh-key", or "other". */
  type: string;
  username: string | null;
  /** The fields that hold a value and can be asked for by name. */
  fields: string[];
  /** The shared collections it is in — none for one in the agent's own vault. */
  collections: string[];
  /** Marked "master password re-prompt" by the owner: ghostly lists it and
   *  will not hand its secrets to an agent. */
  humanOnly: boolean;
}

/** `ghostly status`: who this machine's agent is, and whether its vault answers. */
export interface GhostlyStatus {
  server: string;
  email: string;
  ok: boolean;
  problem?: string;
  collections: string[];
}

/** ghostly said no. `hint` is its own next thing to try. */
export class GhostlyError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    /** ghostly's exit code: 1 a failure, 2 a command it did not understand,
     *  3 an enrollment waiting on the owner. */
    readonly code = 1,
  ) {
    super(message);
    this.name = "GhostlyError";
  }

  /** `ghostly init` has not been run on this machine. */
  get unenrolled(): boolean {
    return /no agent enrolled/i.test(this.message);
  }

  /** The message and the hint, as one line for a person. */
  get said(): string {
    return this.hint ? `${this.message} — ${this.hint}` : this.message;
  }
}

/** How long one command may take. A status is several runs of bw and a sync. */
const TIMEOUT_MS = 45_000;
const STATUS_TIMEOUT_MS = 90_000;

/**
 * Where ghostly is on this machine, if it is. RURI_GHOSTLY names one to
 * use instead (a file to run), or "" for none — what tests and scripts
 * set, so they never reach a real vault.
 */
export function findGhostly(): string | null {
  return findCommand("ghostly", "RURI_GHOSTLY");
}

/** ghostly starts with `#!/usr/bin/env bun`, and runs bw on Node when it
 *  finds one: both are looked for on the PATH, which a GUI app's lacks. */
function ghostlyEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const dirs = [
    ...(process.env["PATH"] ?? "/usr/bin:/bin").split(path.delimiter),
    path.join(home, ".bun", "bin"),
    path.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  return {
    ...process.env,
    PATH: [...new Set(dirs.filter(Boolean))].join(path.delimiter),
    NO_COLOR: "1",
  };
}

/** What ghostly printed when it failed: "ghostly: <message>", then a hint line. */
function failure(stderr: string, code: number): GhostlyError {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const at = lines.findIndex((line) => line.startsWith("ghostly:"));
  if (at === -1) {
    return new GhostlyError(
      lines.at(-1) ?? `ghostly stopped with code ${code} and said nothing`,
      undefined,
      code,
    );
  }
  const message = lines[at]!.slice("ghostly:".length).trim();
  return new GhostlyError(message || `ghostly stopped with code ${code}`, lines[at + 1], code);
}

export class Ghostly {
  /** The run in flight, which the next one waits on. */
  private last: Promise<unknown> = Promise.resolve();

  /** `limits` shortens the waits — a test's, which has no minute to spend. */
  constructor(private readonly limits: { timeoutMs?: number; statusTimeoutMs?: number } = {}) {}

  /** Where the command is, looked for each time: installing ghostly while
   *  ruri runs is found on the next look, with no restart. */
  where(): string | null {
    return findGhostly();
  }

  /** One run of ghostly, after whichever came before: what it printed. */
  private run(args: string[], options: { stdin?: string; timeoutMs?: number } = {}): Promise<string> {
    const next = this.last.then(
      () => this.spawn(args, options),
      () => this.spawn(args, options),
    );
    this.last = next.catch(() => undefined);
    return next;
  }

  private spawn(args: string[], options: { stdin?: string; timeoutMs?: number }): Promise<string> {
    return new Promise((resolve, reject) => {
      const file = this.where();
      if (!file) {
        reject(new GhostlyError("ghostly is not installed on this machine"));
        return;
      }
      const limit = options.timeoutMs ?? this.limits.timeoutMs ?? TIMEOUT_MS;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, { env: ghostlyEnv(), stdio: ["pipe", "pipe", "pipe"] });
      } catch (err) {
        reject(new GhostlyError(errorMessage(err)));
        return;
      }
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
      child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-8_000)));
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      }, limit);
      timer.unref();
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new GhostlyError(errorMessage(err)));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new GhostlyError(`ghostly did not answer in ${Math.round(limit / 1000)}s`));
        } else if (code === 0) {
          resolve(stdout);
        } else {
          reject(failure(stderr, code ?? 1));
        }
      });
      // a command that never reads its stdin closes it early: not an error
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.stdin ?? "");
    });
  }

  /** Who this machine's agent is and whether its vault answers. Throws
   *  when there is no agent here at all (GhostlyError.unenrolled). */
  async status(): Promise<GhostlyStatus> {
    const printed = await this.run(["status", "--json"], {
      timeoutMs: this.limits.statusTimeoutMs ?? STATUS_TIMEOUT_MS,
    });
    const raw = parse(printed) as Partial<GhostlyStatus> | null;
    if (!raw || typeof raw.server !== "string" || typeof raw.email !== "string") {
      throw new GhostlyError("ghostly's status was not something ruri could read");
    }
    return {
      server: raw.server,
      email: raw.email,
      ok: raw.ok === true,
      ...(typeof raw.problem === "string" && raw.problem ? { problem: raw.problem } : {}),
      collections: strings(raw.collections),
    };
  }

  /** Everything shared with the agent, without a single secret. */
  async list(): Promise<GhostlyItem[]> {
    const raw = parse(await this.run(["list", "--json"]));
    if (!Array.isArray(raw)) throw new GhostlyError("ghostly's list was not something ruri could read");
    const items: GhostlyItem[] = [];
    for (const entry of raw as Partial<GhostlyItem>[]) {
      if (!entry || typeof entry.id !== "string" || typeof entry.name !== "string") continue;
      items.push({
        id: entry.id,
        name: entry.name,
        type: typeof entry.type === "string" ? entry.type : "other",
        username: typeof entry.username === "string" && entry.username ? entry.username : null,
        fields: strings(entry.fields),
        collections: strings(entry.collections),
        humanOnly: entry.humanOnly === true,
      });
    }
    return items;
  }

  /** One item's password. ghostly writes this down as a read, in its own
   *  log and the owner's. */
  async read(id: string): Promise<string> {
    const printed = await this.run(["get", "--field", "password", "--", id]);
    // ghostly ends what it prints with one newline that is not the value's
    return printed.endsWith("\n") ? printed.slice(0, -1) : printed;
  }

  /**
   * Store a login, or replace one's password. The secret goes in on stdin;
   * with `generate`, ghostly makes one and nothing is sent at all. `update`
   * is ghostly's own guard: without it, a name already taken is refused.
   */
  async put(
    name: string,
    options: { username?: string; update?: boolean; generate?: boolean; collection?: string },
    secret?: string,
  ): Promise<void> {
    const args = ["put"];
    // "=", so a value that begins with a dash is still the value
    if (options.username !== undefined) args.push(`--username=${options.username}`);
    if (options.collection) args.push(`--collection=${options.collection}`);
    if (options.update) args.push("--update");
    if (options.generate) args.push("--generate");
    else if (!secret) throw new GhostlyError("there is no value to store");
    args.push("--", name);
    await this.run(args, options.generate ? {} : { stdin: secret });
  }

  /** Move one to the vault's trash, where the owner can bring it back. */
  async remove(id: string): Promise<void> {
    await this.run(["rm", "--", id]);
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
