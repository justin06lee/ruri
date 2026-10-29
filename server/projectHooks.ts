/**
 * Project hooks: telling something outside ruri when a project's team is
 * done (`project.idle`) or waiting on someone (`project.blocked`), so a
 * meta-agent — midna, first — can pick the project up without the user
 * having to watch it.
 *
 * Deciding when a project is idle or blocked is the chat runs' (they call
 * projectBusy and fireProjectEvent). Everything after that is here: what
 * the event says, and getting it to every hook that wants it — a command
 * run with the event on its stdin, a URL it is POSTed to — retried with
 * backoff when that fails, and never in the way of the project: a hook is
 * started and left to run, and nothing ruri does waits on it.
 *
 * The hooks are the user's, global and per project, kept here in their own
 * file rather than in the window's preferences or on the project record:
 * both of those go out whole to every window, and a webhook's bearer token
 * must not. Windows see whether there is one, never what it is.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  leadOf,
  type AskQuestions,
  type HookDelivery,
  type HooksView,
  type HookTargetView,
  type PermissionRequest,
  type Project,
  type ProjectEventKind,
  type ProjectEventPayload,
  type TalkAsk,
  type TranscriptEvent,
} from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import type { ServerContext } from "./context.js";
import { errorCode, errorMessage, isMissing, warn } from "./log.js";

/** The global hook when the user has set none and midna is on this machine:
 *  the title reaches it through the environment, so a project's name is
 *  never parsed by the shell. */
export const MIDNA_COMMAND = 'midna event --source ruri --title "$RURI_EVENT_TITLE" --json -';

/** How long a command may run before it is stopped, and a webhook may take
 *  to answer. */
const COMMAND_TIMEOUT_MS = 30_000;
const WEBHOOK_TIMEOUT_MS = 15_000;
/** The waits between the first tries, then one every RETRY_TAIL_MS until
 *  GIVE_UP_MS after the event: midna down for an update or a reboot still
 *  hears it after, and midna drops a repeat it already has ("already
 *  heard"). RURI_HOOK_RETRY_MS="200,400" sets every wait for a test, with
 *  no tail. */
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 600_000];
const RETRY_TAIL_MS = 15 * 60_000;
const GIVE_UP_MS = 6 * 60 * 60_000;
/** How soon after a launch a delivery the last run left unfinished goes. */
const RESUME_MS = 5_000;
/** Deliveries kept for the page. */
const KEEP_DELIVERIES = 50;
/** About this much of a chat's last reply goes in `lastSummary`. */
const SUMMARY_CHARS = 600;
/** The most a payload may be, as JSON: midna takes 64 KB of it. */
const MAX_PAYLOAD_BYTES = 60 * 1024;
/** How long a look for midna is believed. */
const MIDNA_TTL_MS = 60_000;

/** One place events go, as kept. */
interface StoredTarget {
  command?: string;
  url?: string;
  token?: string;
  /** False turns these hooks off and keeps them for later. */
  enabled?: boolean;
}

interface StoredProject extends StoredTarget {
  /** False keeps the global hooks off this project. */
  useGlobal?: boolean;
}

interface StoredHooks {
  /** Unset is the default: midna's command when midna is here. */
  global?: StoredTarget;
  projects?: Record<string, StoredProject>;
}

/** One hook an event is going to. */
export interface HookTarget {
  scope: HookDelivery["scope"];
  target: HookDelivery["target"];
  /** The command, or the URL. */
  to: string;
  token?: string;
}

/** How one try went. `retry` false means trying again won't help. */
export interface Attempt {
  ok: boolean;
  result: string;
  retry: boolean;
}

/** What the hooks reach the world through — real by default, faked in tests. */
export interface HookIo {
  runCommand(
    command: string,
    input: string,
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
  ): Promise<Attempt>;
  post(url: string, body: string, token: string | undefined, timeoutMs: number): Promise<Attempt>;
  findMidna(): string | null;
  now(): number;
  later(fn: () => void, ms: number): { cancel(): void };
}

/** A change to the hooks, as hooks_set carries it. */
export interface HookChange {
  projectId?: string;
  command?: string;
  url?: string;
  token?: string;
  enabled?: boolean;
  useGlobal?: boolean;
  reset?: boolean;
}

/* ── the world ─────────────────────────────────────────────────────── */

function clip(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Where midna is on this machine, if it is. A GUI app's PATH misses
 * ~/.local/bin, where midna installs itself, so that is looked in too.
 * RURI_MIDNA names one to use instead (a file called midna), or "" for
 * none — what tests set, so they never reach the real one.
 */
export function findMidna(): string | null {
  return findCommand("midna", "RURI_MIDNA");
}

/** Where a command is on this machine: `forced` names an environment
 *  variable that overrides the look (a file to use, or "" for none), then
 *  PATH and the usual install folders a GUI app's PATH misses. */
export function findCommand(name: string, forced: string): string | null {
  const given = process.env[forced];
  if (given !== undefined) return given && isExecutable(given) ? given : null;
  const dirs = [
    ...(process.env["PATH"] ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (isExecutable(file)) return file;
  }
  return null;
}

/** Run a command by /bin/sh with `input` on its stdin, in a process group
 *  of its own so a timeout stops everything it started. */
function runCommand(
  command: string,
  input: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<Attempt> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (attempt: Attempt): void => {
      if (settled) return;
      settled = true;
      resolve(attempt);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/bin/sh", ["-c", command], {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
    } catch (err) {
      settle({ ok: false, retry: true, result: errorMessage(err) });
      return;
    }
    let said = "";
    let printed = "";
    const keep = (chunk: Buffer): void => {
      said = (said + chunk.toString("utf8")).slice(-4_000);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      printed = (printed + chunk.toString("utf8")).slice(-8_000);
      keep(chunk);
    });
    child.stderr?.on("data", keep);
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, name);
      } catch {
        child.kill(name);
      }
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      setTimeout(() => signal("SIGKILL"), 2_000).unref();
    }, options.timeoutMs);
    timer.unref();
    child.on("error", (err) => {
      clearTimeout(timer);
      settle({ ok: false, retry: true, result: errorMessage(err) });
    });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      if (timedOut) {
        settle({
          ok: false,
          retry: true,
          result: `timed out after ${Math.round(options.timeoutMs / 1000)}s`,
        });
      } else if (code === 0) {
        const receipt = receiptSays(lastJson(printed));
        settle({ ok: true, retry: false, result: receipt ? `exit 0 · ${receipt}` : "exit 0" });
      } else {
        const what = code === null ? `killed by ${killedBy ?? "a signal"}` : `exit ${code}`;
        // a command that answers in JSON, the way `midna event --json`
        // does, says what went wrong there — and whether it could pass
        const answer = lastJson(printed);
        if (answer?.["ok"] === false && typeof answer["error"] === "string") {
          settle({ ok: false, retry: refusalPasses(answer), result: `${what}: ${clip(answer["error"])}` });
          return;
        }
        const tail = clip(said);
        // 126 and 127: the shell could not run it, and won't next time
        settle({ ok: false, retry: code !== 126 && code !== 127, result: tail ? `${what}: ${tail}` : what });
      }
    });
    // a command that never reads its stdin closes it on us
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

async function post(
  url: string,
  body: string,
  token: string | undefined,
  timeoutMs: number,
): Promise<Attempt> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "ruri",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text().catch(() => "");
    const answer = lastJson(text);
    if (response.ok) {
      const receipt = receiptSays(answer);
      return { ok: true, retry: false, result: `HTTP ${response.status}${receipt ? ` · ${receipt}` : ""}` };
    }
    // a refusal stands until someone changes something (400, 401, 413…);
    // the rest may pass
    const retry = response.status >= 500 || response.status === 408 || response.status === 429;
    const said = clip(typeof answer?.["error"] === "string" ? answer["error"] : text);
    return { ok: false, retry, result: `HTTP ${response.status}${said ? `: ${said}` : ""}` };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      return { ok: false, retry: true, result: `timed out after ${Math.round(timeoutMs / 1000)}s` };
    }
    const code = errorCode(err);
    return { ok: false, retry: true, result: code ? `${errorMessage(err)} (${code})` : errorMessage(err) };
  }
}

/** The last line of `text` that is a JSON object, parsed. */
function lastJson(text: string): Record<string, unknown> | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line?.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        return parsed as Record<string, unknown>;
    } catch {
      // not this one
    }
  }
  return undefined;
}

/** A receipt — midna's EventReceipt — in a few words: "queued, event 7". */
function receiptSays(answer: Record<string, unknown> | undefined): string | undefined {
  const status = answer?.["status"];
  if (typeof status !== "string") return undefined;
  const id = answer?.["eventId"];
  return typeof id === "number" || typeof id === "string" ? `${status}, event ${id}` : status;
}

/**
 * Whether a refusal a command printed as {"ok":false,"error":…} could
 * pass if tried again. midna's CLI says "can't reach midna" when it
 * couldn't get there, and "midna: …" with midna's own words when midna
 * answered: a device not paired (401), data over 64 KB (413), a field it
 * won't take (400, zod's issues) stand until something changes; anything
 * else it says (a 500's message) may pass. A `status` beside the error,
 * should the CLI ever print one, decides it outright.
 */
export function refusalPasses(answer: Record<string, unknown>): boolean {
  const status = answer["status"];
  if (typeof status === "number") return status >= 500 || status === 408 || status === 429;
  const error = typeof answer["error"] === "string" ? answer["error"] : "";
  if (/^usage:|not JSON|^no such file/i.test(error)) return false;
  if (/^midna: (unauthorized|an event's data can be at most|\s*[[{])/i.test(error)) return false;
  return true;
}

/** A webhook that is midna's own API — POST /v1/inbound — takes the event
 *  in its envelope: who it's from, a title, the id it is deduplicated by,
 *  and the event itself as `data`. Any other URL gets the event as it is. */
function isMidnaInbound(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "").endsWith("/v1/inbound");
  } catch {
    return false;
  }
}

/** What a webhook is sent. */
export function webhookBody(url: string, payload: ProjectEventPayload): string {
  if (!isMidnaInbound(url)) return JSON.stringify(payload);
  return JSON.stringify({
    source: "ruri",
    title: eventTitle(payload.kind, payload.project.name),
    id: payload.id,
    data: payload,
  });
}

/** How long to wait before the next try, after `attempts` of them, for a
 *  delivery made at `since` — or undefined: given up. */
function retryWait(attempts: number, since: number, now: number): number | undefined {
  const forced = process.env["RURI_HOOK_RETRY_MS"];
  const delays = forced
    ?.split(",")
    .map((part) => Number(part.trim()))
    .filter((ms) => Number.isFinite(ms) && ms >= 0);
  if (delays?.length) return delays[attempts - 1];
  const wait = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_TAIL_MS;
  return now + wait - since <= GIVE_UP_MS ? wait : undefined;
}

/** A delivery not yet through, as kept on disk so a relaunch goes on with
 *  it: where it goes (a webhook's token with it — the file is 0600, as
 *  hooks.json is), the event, and where a command runs. */
interface Unsent {
  target: HookTarget;
  payload: ProjectEventPayload;
  cwd: string;
  /** When the delivery was made: it is given up GIVE_UP_MS after. */
  since: number;
}

export const realIo: HookIo = {
  runCommand,
  post,
  findMidna,
  now: () => Date.now(),
  later: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return { cancel: () => clearTimeout(timer) };
  },
};

/* ── the hooks and their deliveries ────────────────────────────────── */

/** How a target looks to a window: everything but the token. */
function targetView(target: StoredTarget | undefined): HookTargetView {
  return {
    command: target?.command ?? "",
    url: target?.url ?? "",
    hasToken: !!target?.token,
    enabled: target?.enabled !== false,
  };
}

/** A URL a webhook can go to, or why not. */
function badUrl(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return undefined;
  } catch {
    // said below
  }
  return `Not a webhook URL: ${url} (it needs http:// or https://)`;
}

/** A field as a change carries it: left out keeps it, "" clears it. */
function patched<T extends StoredTarget>(target: T, change: HookChange): T {
  const next: T = { ...target };
  for (const key of ["command", "url", "token"] as const) {
    const value = change[key];
    if (value === undefined) continue;
    const trimmed = value.trim();
    if (trimmed) next[key] = trimmed;
    else delete next[key];
  }
  if (change.enabled !== undefined) next.enabled = change.enabled;
  // on is what unset means
  if (next.enabled !== false) delete next.enabled;
  return next;
}

export class HookCenter {
  private stored: StoredHooks = {};
  private deliveries: HookDelivery[] = [];
  /** Each delivery's retry waiting to go, by delivery id. */
  private readonly waiting = new Map<string, { cancel(): void }>();
  /** The ledger's total for a project when its team went busy. */
  private readonly baselines = new Map<string, { busySince: number; costUsd: number }>();
  private midna: { at: number; path: string | null } | undefined;
  private saveLog: { cancel(): void } | undefined;
  private closed = false;
  /** The deliveries not through yet, by delivery id. */
  private readonly unsent = new Map<string, Unsent>();
  private readonly outbox: string;

  constructor(
    private readonly io: HookIo,
    private readonly changed: () => void,
    private readonly files: { config: string; log: string; outbox?: string } = {
      config: configPath("hooks.json"),
      log: configPath("hook-deliveries.json"),
    },
  ) {
    this.outbox = files.outbox ?? path.join(path.dirname(files.log), "hook-outbox.json");
    try {
      const raw = JSON.parse(fs.readFileSync(this.outbox, "utf8")) as Record<string, Unsent>;
      for (const [id, unsent] of Object.entries(raw ?? {})) {
        if (unsent?.target?.to && unsent.payload?.id && typeof unsent.since === "number")
          this.unsent.set(id, unsent);
      }
    } catch (err) {
      if (!isMissing(err)) warn("hooks", err, "load outbox");
    }
    try {
      const raw = JSON.parse(fs.readFileSync(files.config, "utf8")) as StoredHooks;
      if (raw && typeof raw === "object") this.stored = raw;
    } catch (err) {
      if (!isMissing(err)) warn("hooks", err, "load");
    }
    try {
      const raw = JSON.parse(fs.readFileSync(files.log, "utf8")) as HookDelivery[];
      if (Array.isArray(raw)) {
        // a delivery still going when ruri last closed goes on now, from
        // the outbox — one with nothing there to send went no further
        this.deliveries = raw.slice(0, KEEP_DELIVERIES).map((delivery) => {
          if (delivery.state !== "pending" && delivery.state !== "retrying") return delivery;
          const unsent = this.unsent.get(delivery.id);
          if (!unsent || this.io.now() - unsent.since > GIVE_UP_MS) {
            this.unsent.delete(delivery.id);
            return { ...delivery, state: "failed", result: "ruri closed before it went", nextAt: undefined };
          }
          const resumed: HookDelivery = { ...delivery, state: "retrying", nextAt: this.io.now() + RESUME_MS };
          this.waiting.set(
            resumed.id,
            this.io.later(
              () =>
                void this.attempt(
                  resumed,
                  unsent.target,
                  JSON.stringify(unsent.payload),
                  unsent.payload,
                  unsent.cwd,
                ),
              RESUME_MS,
            ),
          );
          return resumed;
        });
      }
    } catch (err) {
      if (!isMissing(err)) warn("hooks", err, "load deliveries");
    }
    // what the outbox holds that no delivery is waiting on is done with
    const waiting = new Set(this.waiting.keys());
    for (const id of [...this.unsent.keys()]) if (!waiting.has(id)) this.unsent.delete(id);
    this.writeOutbox();
  }

  /** midna, looked for at most once a minute. */
  midnaPath(): string | null {
    const now = this.io.now();
    if (!this.midna || now - this.midna.at > MIDNA_TTL_MS)
      this.midna = { at: now, path: this.io.findMidna() };
    return this.midna.path;
  }

  /** The global hooks as they apply: the user's, else midna's command. */
  private globalTarget(): StoredTarget {
    if (this.stored.global) return this.stored.global;
    return this.midnaPath() ? { command: MIDNA_COMMAND } : {};
  }

  view(projectIds?: ReadonlySet<string>): HooksView {
    const custom = this.stored.global !== undefined;
    const projects: HooksView["projects"] = {};
    for (const [id, own] of Object.entries(this.stored.projects ?? {})) {
      if (projectIds && !projectIds.has(id)) continue;
      projects[id] = { ...targetView(own), useGlobal: own.useGlobal !== false };
    }
    return {
      midna: this.midnaPath(),
      midnaCommand: MIDNA_COMMAND,
      global: { ...targetView(this.globalTarget()), custom },
      projects,
      deliveries: this.deliveries.map((delivery) => ({ ...delivery })),
    };
  }

  /** Change the hooks; the reason when the change was refused. */
  set(change: HookChange): string | undefined {
    const refused = change.url !== undefined ? badUrl(change.url.trim()) : undefined;
    if (refused) return refused;
    if (change.projectId === undefined) {
      if (change.reset) delete this.stored.global;
      // the first change to the default starts from what it was showing
      else this.stored.global = patched(this.globalTarget(), change);
    } else {
      const projects = (this.stored.projects ??= {});
      if (change.reset) delete projects[change.projectId];
      else {
        const own = patched<StoredProject>(projects[change.projectId] ?? {}, change);
        if (change.useGlobal !== undefined) own.useGlobal = change.useGlobal;
        if (own.useGlobal !== false) delete own.useGlobal;
        // nothing of its own left (on or off, no hook is no hook): the
        // project is back to the global hooks
        if (!own.command && !own.url && !own.token && own.useGlobal !== false)
          delete projects[change.projectId];
        else projects[change.projectId] = own;
      }
    }
    this.save();
    this.changed();
    return undefined;
  }

  /** Every hook a project's events go to — or, with none named, the
   *  global ones. The same command or URL twice goes once. */
  targets(projectId?: string): HookTarget[] {
    const own = projectId === undefined ? undefined : this.stored.projects?.[projectId];
    const from: Array<[HookTarget["scope"], StoredTarget]> = [];
    const global = this.globalTarget();
    if (own?.useGlobal !== false && global.enabled !== false) from.push(["global", global]);
    if (own && own.enabled !== false) from.push(["project", own]);
    const out: HookTarget[] = [];
    const seen = new Set<string>();
    for (const [scope, target] of from) {
      if (target.command && !seen.has(`command ${target.command}`)) {
        seen.add(`command ${target.command}`);
        out.push({ scope, target: "command", to: target.command });
      }
      if (target.url && !seen.has(`webhook ${target.url}`)) {
        seen.add(`webhook ${target.url}`);
        out.push({
          scope,
          target: "webhook",
          to: target.url,
          ...(target.token ? { token: target.token } : {}),
        });
      }
    }
    return out;
  }

  /** Why a project's events — or, with none named, the global hooks' —
   *  go nowhere, in words: none set, or set and switched off. */
  nowhere(projectId?: string, name = "This project"): string {
    const global = this.globalTarget();
    const globalOff = !!(global.command || global.url) && global.enabled === false;
    if (projectId === undefined) {
      return globalOff
        ? "The global hooks are switched off: turn them on to send a test."
        : "There are no global hooks to send it to: add a command or a webhook first.";
    }
    const own = this.stored.projects?.[projectId];
    const why = [
      own?.useGlobal === false
        ? "the global hooks are kept off it"
        : globalOff
          ? "the global hooks are switched off"
          : "there are no global hooks",
      own && (own.command || own.url) && own.enabled === false
        ? "its own are switched off"
        : "it has none of its own",
    ];
    return `${name}'s events go nowhere: ${why.join(", and ")}.`;
  }

  /** The team went busy: what it spends from here is the next event's. */
  noteBusy(projectId: string, busySince: number, ledgerCostUsd: number): void {
    if (this.baselines.get(projectId)?.busySince === busySince) return;
    this.baselines.set(projectId, { busySince, costUsd: ledgerCostUsd });
  }

  /** The ledger's total when the busy period that began at `busySince`
   *  did, if this server saw it begin. */
  baseline(projectId: string, busySince: number): number | undefined {
    const base = this.baselines.get(projectId);
    return base?.busySince === busySince ? base.costUsd : undefined;
  }

  /** When the project's latest busy period this server saw began. */
  busySince(projectId: string): number | undefined {
    return this.baselines.get(projectId)?.busySince;
  }

  /** Hand an event to each target, and keep at it until each has it. */
  deliver(payload: ProjectEventPayload, targets: HookTarget[], cwd: string): HookDelivery[] {
    const body = JSON.stringify(payload);
    const made: HookDelivery[] = [];
    for (const target of targets) {
      const delivery: HookDelivery = {
        id: randomUUID(),
        eventId: payload.id,
        kind: payload.kind,
        projectId: payload.project.id,
        projectName: payload.project.name,
        scope: target.scope,
        target: target.target,
        to: target.to,
        at: Date.parse(payload.at) || this.io.now(),
        state: "pending",
        attempts: 0,
      };
      made.push(delivery);
      this.deliveries.unshift(delivery);
      this.unsent.set(delivery.id, { target, payload, cwd, since: this.io.now() });
    }
    if (made.length) {
      this.writeOutbox();
      this.logChanged();
    }
    made.forEach((delivery, i) => {
      const target = targets[i];
      if (target) void this.attempt(delivery, target, body, payload, cwd);
    });
    return made;
  }

  private async attempt(
    delivery: HookDelivery,
    target: HookTarget,
    body: string,
    payload: ProjectEventPayload,
    cwd: string,
  ): Promise<void> {
    if (this.closed) return;
    this.waiting.delete(delivery.id);
    let attempt: Attempt;
    try {
      attempt =
        target.target === "command"
          ? await this.io.runCommand(this.runnable(target.to), `${body}\n`, {
              cwd,
              env: this.commandEnv(payload),
              timeoutMs: COMMAND_TIMEOUT_MS,
            })
          : await this.io.post(target.to, webhookBody(target.to, payload), target.token, WEBHOOK_TIMEOUT_MS);
    } catch (err) {
      attempt = { ok: false, retry: true, result: errorMessage(err) };
    }
    if (this.closed) return;
    delivery.attempts += 1;
    delivery.result = attempt.result;
    delivery.doneAt = this.io.now();
    const wait = retryWait(delivery.attempts, this.unsent.get(delivery.id)?.since ?? delivery.at, this.io.now());
    if (attempt.ok) {
      delivery.state = "ok";
      delete delivery.nextAt;
    } else if (attempt.retry && wait !== undefined) {
      delivery.state = "retrying";
      delivery.nextAt = this.io.now() + wait;
      this.waiting.set(
        delivery.id,
        this.io.later(() => void this.attempt(delivery, target, body, payload, cwd), wait),
      );
    } else {
      delivery.state = "failed";
      delete delivery.nextAt;
    }
    if (delivery.state !== "retrying" && this.unsent.delete(delivery.id)) this.writeOutbox();
    if (!attempt.ok) {
      const next =
        delivery.state === "retrying" ? `; trying again in ${Math.round(wait! / 1000)}s` : "; giving up";
      warn(
        "hooks",
        attempt.result,
        `${payload.kind} for ${payload.project.name} to ${target.target} ${clip(target.to, 80)} (try ${delivery.attempts}${next})`,
      );
    }
    this.logChanged();
  }

  /** The command line to run. midna's own command runs the midna that was
   *  found, by its path: by name it could be another one further down the
   *  PATH — the real one, under a test that pointed RURI_MIDNA at a stub. */
  private runnable(command: string): string {
    const midna = this.midnaPath();
    if (command !== MIDNA_COMMAND || !midna) return command;
    return `'${midna.replaceAll("'", `'\\''`)}'${MIDNA_COMMAND.slice("midna".length)}`;
  }

  /** What a command is run with: ruri's own environment, midna where the
   *  shell will find it, and the event in a few variables for a command
   *  line to use — never spliced into the command itself. */
  private commandEnv(payload: ProjectEventPayload): NodeJS.ProcessEnv {
    const midna = this.midnaPath();
    const dirs = [
      ...(midna ? [path.dirname(midna)] : []),
      ...(process.env["PATH"] ?? "/usr/bin:/bin").split(path.delimiter),
      path.join(os.homedir(), ".local", "bin"),
    ];
    return {
      ...process.env,
      PATH: [...new Set(dirs.filter(Boolean))].join(path.delimiter),
      RURI_EVENT_ID: payload.id,
      RURI_EVENT_KIND: payload.kind,
      RURI_EVENT_TITLE: eventTitle(payload.kind, payload.project.name),
      RURI_PROJECT_ID: payload.project.id,
      RURI_PROJECT_NAME: payload.project.name,
      RURI_PROJECT_PATH: payload.project.path,
    };
  }

  private logChanged(): void {
    // the oldest go — but never one still on its way
    while (this.deliveries.length > KEEP_DELIVERIES) {
      const at = this.deliveries.findLastIndex((d) => d.state === "ok" || d.state === "failed");
      if (at < 0) break;
      this.deliveries.splice(at, 1);
    }
    this.changed();
    if (this.saveLog) return;
    this.saveLog = this.io.later(() => {
      this.saveLog = undefined;
      this.writeLog();
    }, 500);
  }

  private writeLog(): void {
    try {
      writeJsonAtomic(this.files.log, this.deliveries, 1);
    } catch (err) {
      warn("hooks", err, "save deliveries");
    }
  }

  private writeOutbox(): void {
    try {
      if (this.unsent.size === 0) fs.rmSync(this.outbox, { force: true });
      else writeJsonAtomic(this.outbox, Object.fromEntries(this.unsent), 0, 0o600);
    } catch (err) {
      warn("hooks", err, "save outbox");
    }
  }

  private save(): void {
    try {
      // a webhook's token is in here
      writeJsonAtomic(this.files.config, this.stored, 2, 0o600);
    } catch (err) {
      warn("hooks", err, "save");
    }
  }

  /** Stop retrying, and write what went. */
  close(): void {
    this.closed = true;
    for (const wait of this.waiting.values()) wait.cancel();
    this.waiting.clear();
    this.saveLog?.cancel();
    this.saveLog = undefined;
    this.writeLog();
  }
}

/* ── the payload ───────────────────────────────────────────────────── */

/** What a command's RURI_EVENT_TITLE says — midna's title for it. */
export function eventTitle(kind: ProjectEventKind, project: string): string {
  if (kind === "project.idle") return `${project} is idle`;
  if (kind === "project.blocked") return `${project} is blocked`;
  return `${project}: test event from ruri`;
}

/** Trimmed to about `max` characters, at a word where there is one. */
export function trimSummary(text: string, max = SUMMARY_CHARS): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  if (max <= 0) return "";
  let cut = clean.slice(0, max);
  // never half of a character that takes two code units (emoji, 𝄞)
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const space = cut.search(/\s\S*$/);
  return `${(space > max * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What a card in front of the user is asking, in a line. */
function cardSays(request: PermissionRequest): string | undefined {
  if (request.kind === "component") return undefined;
  if (request.kind === "question") {
    const questions = (request.input as Partial<AskQuestions> | undefined)?.questions ?? [];
    const asked = questions.map((q) => q.question).filter(Boolean);
    return `Asks: ${asked.join(" / ") || "a question"}`;
  }
  if (request.kind === "message") {
    const ask = request.input as Partial<TalkAsk> | undefined;
    return `Waiting on approval to message ${ask?.project ?? "another agent"}${ask?.title ? ` (${ask.title})` : ""}`;
  }
  const input = request.input as Record<string, unknown> | undefined;
  const detail =
    typeof input?.["command"] === "string"
      ? input["command"]
      : typeof input?.["file_path"] === "string"
        ? input["file_path"]
        : input
          ? JSON.stringify(input)
          : "";
  return `Waiting on approval: ${request.toolName}${detail ? ` ${clip(detail, 300)}` : ""}`;
}

/** The chat's last word: the card it waits at, else its last reply. */
export function lastSummary(
  ctx: ServerContext,
  sessionId: string,
  events: TranscriptEvent[],
  why?: BlockedWhy,
): string {
  const card = [...ctx.permissions.values()]
    .filter((request) => request.projectId === sessionId)
    .sort((a, b) => b.ts - a.ts)
    .map(cardSays)
    .find((said) => said !== undefined);
  if (card) return trimSummary(card);
  if (why?.reason === "error" && why.text) return trimSummary(`Stopped on an error: ${why.text}`);
  const reply = events.findLast((event) => event.kind === "assistant");
  if (reply?.kind === "assistant" && reply.text.trim()) return trimSummary(reply.text);
  if (why?.text)
    return trimSummary(why.reason === "card" ? `Waiting on approval: ${why.text}` : `Asks: ${why.text}`);
  return "";
}

/** Why a blocked chat is waiting, as the chat runs saw it. */
export interface BlockedWhy {
  reason?: "question" | "card" | "error";
  /** The question, or what the card asks about, or the error. */
  text?: string;
}

/** A chat's events, back to `since` if the live part doesn't reach it. */
function eventsSince(ctx: ServerContext, sessionId: string, since: number): TranscriptEvent[] {
  const live = ctx.archive.events(sessionId);
  const first = live[0];
  if (first && first.ts <= since) return live;
  return ctx.archive.hasHistory(sessionId) ? ctx.archive.allEvents(sessionId) : live;
}

function cents(usd: number): number {
  return Math.max(0, Math.round(usd * 10_000) / 10_000);
}

/** What the project's chats spent since `busySince`: the ledger's growth
 *  since the team went busy — rewinds and compactions don't take spend out
 *  of it — or, when this server didn't see it go busy, its chats' turns. */
function spentSince(ctx: ServerContext, project: Project, busySince: number): number {
  const base = hooksOf(ctx).baseline(project.id, busySince);
  if (base !== undefined) return cents(ctx.ledger.stats(project.id).total.costUsd - base);
  let sum = 0;
  for (const session of project.sessions) {
    for (const event of eventsSince(ctx, session.id, busySince)) {
      if (event.kind === "result" && event.ts >= busySince) sum += event.costUsd ?? 0;
    }
  }
  return cents(sum);
}

/**
 * An event about a project. Its chats are the ones that did something
 * since `busySince` and the lead always — every chat, with no `busySince`
 * (a test) — and `chatId`'s first.
 */
export function buildPayload(
  ctx: ServerContext,
  kind: ProjectEventKind,
  project: Project,
  options: { busySince?: number; chatId?: string; why?: BlockedWhy; costUsd: number; at?: number },
): ProjectEventPayload {
  const leadId = leadOf(project)?.id;
  const chats: ProjectEventPayload["chats"] = [];
  for (const session of project.sessions) {
    const role = session.id === leadId ? "lead" : session.liaison ? "liaison" : "teammate";
    const events =
      options.busySince === undefined
        ? ctx.archive.events(session.id)
        : eventsSince(ctx, session.id, options.busySince);
    const worked = options.busySince === undefined || events.some((event) => event.ts >= options.busySince!);
    if (role !== "lead" && session.id !== options.chatId && !worked) continue;
    const row = {
      id: session.id,
      name: session.title ?? (role === "lead" ? "Lead" : role === "liaison" ? "Liaison" : "Teammate"),
      role,
      lastSummary: lastSummary(
        ctx,
        session.id,
        events,
        session.id === options.chatId ? options.why : undefined,
      ),
    } as const;
    if (session.id === options.chatId) chats.unshift(row);
    else chats.push(row);
  }
  return fitPayload({
    id: randomUUID(),
    source: "ruri",
    kind,
    project: { id: project.id, name: project.name, path: project.path },
    chats,
    costUsd: options.costUsd,
    at: new Date(options.at ?? Date.now()).toISOString(),
  });
}

/**
 * The payload, kept under midna's cap on an event's data (64 KB of JSON,
 * MAX_EVENT_DATA_BYTES; over it, midna answers 413 and the event is lost)
 * with room to spare. A team's chats fit many times over at 600 characters
 * each; a very big team, or replies in a script that takes three or four
 * bytes a character, has its summaries cut shorter — the first chat's (the
 * one waiting, or the lead) last — and only then its last chats left out.
 */
export function fitPayload(payload: ProjectEventPayload, max = MAX_PAYLOAD_BYTES): ProjectEventPayload {
  const fits = (p: ProjectEventPayload): boolean => Buffer.byteLength(JSON.stringify(p)) <= max;
  if (fits(payload)) return payload;
  const cut = (first: number, rest: number, chats = payload.chats): ProjectEventPayload => ({
    ...payload,
    chats: chats.map((chat, i) => ({
      ...chat,
      lastSummary: trimSummary(chat.lastSummary, i === 0 ? first : rest),
    })),
  });
  for (const [first, rest] of [
    [SUMMARY_CHARS, 300],
    [SUMMARY_CHARS, 120],
    [SUMMARY_CHARS, 0],
    [200, 0],
    [0, 0],
  ] as const) {
    const fitted = cut(first, rest);
    if (fits(fitted)) return fitted;
  }
  let fitted = cut(0, 0);
  while (fitted.chats.length > 1 && !fits(fitted)) fitted = { ...fitted, chats: fitted.chats.slice(0, -1) };
  return fitted;
}

/* ── for the rest of the server ────────────────────────────────────── */

const centers = new WeakMap<ServerContext, HookCenter>();

/** The server's hooks, made the first time they are wanted. */
export function hooksOf(ctx: ServerContext): HookCenter {
  let center = centers.get(ctx);
  if (!center) {
    center = new HookCenter(realIo, () => {
      ctx.clients.broadcast({ type: "hooks", hooks: hooksView(ctx) });
    });
    centers.set(ctx, center);
  }
  return center;
}

/** For a test: the hooks this server should use instead. */
export function useHooks(ctx: ServerContext, center: HookCenter): void {
  centers.set(ctx, center);
}

/** The hooks as a window sees them. */
export function hooksView(ctx: ServerContext): HooksView {
  return hooksOf(ctx).view(new Set(ctx.store.list().map((project) => project.id)));
}

/** Where a project's commands run: its folder, while it is there. */
function workDir(project: Project): string {
  try {
    if (fs.statSync(project.path).isDirectory()) return project.path;
  } catch {
    // gone: home will do
  }
  return os.homedir();
}

/**
 * A project's team just went busy (idle → busy: a busy period begins).
 * Called again with the same `busySince` — busy again inside the idle
 * debounce — it changes nothing.
 */
export function projectBusy(ctx: ServerContext, projectId: string, busySince: number): void {
  if (!ctx.store.get(projectId)) return;
  hooksOf(ctx).noteBusy(projectId, busySince, ctx.ledger.stats(projectId).total.costUsd);
}

/** What the chat runs hand fireProjectEvent: their ProjectEvent
 *  (server/projectWatch.ts) fits it as it is. */
export interface ProjectEventInput {
  kind: "project.idle" | "project.blocked";
  projectId: string;
  /** When the busy period began (epoch ms). */
  busySince?: number;
  /** The chat waiting on someone, for project.blocked: first in `chats`. */
  chatId?: string;
  reason?: BlockedWhy["reason"];
  text?: string;
  /** When it happened (epoch ms); now, without. */
  at?: number;
}

/**
 * A project went idle, or one of its chats is waiting on someone: tell its
 * hooks. Returns at once; never throws. The payload is built a moment
 * later, so a turn's spend recorded in the same breath as its end is in it.
 */
export function fireProjectEvent(ctx: ServerContext, event: ProjectEventInput): void {
  setImmediate(() => {
    try {
      const project = ctx.store.get(event.projectId);
      if (!project) return;
      const center = hooksOf(ctx);
      const targets = center.targets(project.id);
      if (!targets.length) return;
      const at = event.at ?? Date.now();
      // a blocked event should carry when its period began; one that
      // doesn't takes the last this server saw, or names only who is waiting
      const busySince = event.busySince ?? center.busySince(project.id);
      const payload = buildPayload(ctx, event.kind, project, {
        busySince: busySince ?? at,
        costUsd: busySince === undefined ? 0 : spentSince(ctx, project, busySince),
        at,
        ...(event.chatId ? { chatId: event.chatId } : {}),
        ...(event.reason || event.text ? { why: { reason: event.reason, text: event.text } } : {}),
      });
      center.deliver(payload, targets, workDir(project));
    } catch (err) {
      warn("hooks", err, `${event.kind} for ${event.projectId}`);
    }
  });
}

/**
 * The "send test event" button: a `project.test` event, shaped like any
 * other, to every hook a project's events go to — or with none named, to
 * the global hooks, about the first project open. Why it could not, if it
 * could not.
 */
export function sendTestEvent(ctx: ServerContext, projectId?: string): string | undefined {
  const center = hooksOf(ctx);
  const named =
    projectId === undefined
      ? undefined
      : (ctx.store.get(projectId) ?? ctx.store.findSession(projectId)?.project);
  if (projectId !== undefined && !named) return "That project isn't open.";
  const targets = center.targets(named?.id);
  if (!targets.length) return center.nowhere(named?.id, named?.name);
  const project = named ??
    ctx.store.list().find((p) => !p.hidden) ??
    ctx.store.list()[0] ?? { id: "test", name: "ruri", path: os.homedir(), sessions: [] };
  const payload = buildPayload(ctx, "project.test", project, { costUsd: 0 });
  center.deliver(payload, targets, workDir(project));
  return undefined;
}
