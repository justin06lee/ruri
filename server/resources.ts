/**
 * What ruri's agents are costing this machine, right now.
 *
 * Every chat that has been prompted holds a warm harness process — 150 to
 * 400 MB of `claude`, `codex app-server` or an ACP agent, plus whatever MCP
 * servers that process started (server/sessions.ts says when one closes).
 * Four chats left open is most of a gigabyte, and until now the only way to
 * know that was Activity Monitor and a guess at which `node` belonged to
 * which conversation.
 *
 * So ruri counts them itself. One `ps` gives every process on the machine;
 * the ones descended from this one are ruri's, and each direct child of it
 * is rolled up with everything it started — a harness and its MCP servers
 * are one agent, not six rows.
 *
 * Which chat an agent belongs to is asked two ways. A resumed harness is
 * told on its command line which session to continue, and that id is one
 * the archive recorded, which knows whose it is — free, off the same `ps`.
 * A harness starting a *fresh* conversation has no such id to be told, so
 * it is asked what it was given: ruri puts the chat's id in the harness's
 * own environment when it starts it (server/chats.ts), and a process's
 * environment can be read back. That costs a second `ps`, per process,
 * once in its life.
 *
 * No native binding, for the reason server/terminal.ts uses `expect` rather
 * than a pty binding: nothing to build, rebuild per Electron ABI, or unpack
 * from the asar. And nothing is sampled at all unless a window is looking —
 * a meter nobody reads should not be a process ruri spawns twice a second.
 */
import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentProcess, Resources, ServerMessage } from "../shared/protocol.js";
import { warn } from "./log.js";

/** How often the machine is asked, while anyone is looking. */
const SAMPLE_MS = 2_000;

/** A sample that takes longer than this is abandoned: the answer would be
 *  stale by the time it arrived, and another is due. */
const SAMPLE_TIMEOUT_MS = 4_000;

/** One row of `ps`, as read. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** Resident set size, in bytes. */
  rss: number;
  /** Percent of one core, as `ps` reports it. */
  cpu: number;
  /** How long it has been running, in ms. */
  uptimeMs: number;
  /** Its whole command line. */
  args: string;
}

/** The fields, in the order `ps` is asked for them, with args last so the
 *  spaces in it belong to nobody else. */
const PS_ARGS = ["-Ao", "pid=,ppid=,rss=,pcpu=,etime=", "-o", "args="];

/**
 * `[[dd-]hh:]mm:ss` — what `ps` calls elapsed time — in milliseconds.
 */
export function elapsedMs(etime: string): number {
  const [days, clock] = etime.includes("-") ? etime.split("-") : [undefined, etime];
  const parts = (clock ?? "").split(":").map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  const [seconds = 0, minutes = 0, hours = 0] = parts.reverse();
  return (((Number(days ?? 0) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000;
}

/** Every row of a `ps` run, as numbers. Lines it cannot read are skipped. */
export function parsePs(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    // five fields, then everything else is the command
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:-]+)\s+(.*)$/.exec(line);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      // ps counts in kilobytes
      rss: Number(match[3]) * 1024,
      cpu: Number(match[4]),
      uptimeMs: elapsedMs(match[5]!),
      args: match[6]!,
    });
  }
  return rows;
}

/** A Chromium helper — a renderer, the GPU process, a utility. Those are
 *  ruri's own window, not an agent it started. */
function isAppHelper(args: string): boolean {
  return / --type=/.test(args);
}

const RUNTIMES = new Set(["node", "bun", "deno", "npx", "bunx", "python", "python3", "sh", "bash", "zsh"]);

/**
 * What to call an agent: the program at the front of its command line —
 * or, where that is only a runtime, the script it was pointed at.
 */
export function processName(args: string): string {
  const words = args.split(/\s+/).filter(Boolean);
  const first = path.basename(words[0] ?? "").replace(/\.(js|mjs|cjs|ts)$/, "");
  if (!RUNTIMES.has(first)) return first || "unknown";
  for (const word of words.slice(1)) {
    if (word.startsWith("-")) continue;
    const name = path.basename(word).replace(/\.(js|mjs|cjs|ts)$/, "");
    if (name) return name;
  }
  return first;
}

/** Any session id in a command line — a harness is told which to resume,
 *  and a v4 uuid is not something else's argument. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

/** The chat a command line belongs to, from a session id the archive knows. */
export function channelOf(
  args: string,
  ownerOf: (sessionId: string) => string | undefined,
): string | undefined {
  for (const match of args.matchAll(UUID)) {
    const owner = ownerOf(match[0].toLowerCase());
    if (owner !== undefined) return owner;
  }
  return undefined;
}

/**
 * Every process under `rootPid`, rolled up into the things that started them.
 *
 * A direct child of ruri is one candidate; the processes under it are its
 * MCP servers and whatever it shelled out to, and they are its weight, not
 * rows of their own. Chromium's own helpers never are: they are ruri's
 * window, and go straight into the app's figures.
 *
 * Which of the candidates is an *agent* is not decided here — that takes
 * asking each one which chat it belongs to, which is a second `ps`
 * (see `place`). What comes back is everything, for that to sort out.
 */
export function rollUp(
  rows: ProcessRow[],
  rootPid: number,
  ownerOf: (sessionId: string) => string | undefined,
): { candidates: AgentProcess[]; app: Resources["app"] } {
  const byParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const kin = byParent.get(row.ppid);
    if (kin) kin.push(row);
    else byParent.set(row.ppid, [row]);
  }

  /** A process and everything under it, depth first. */
  const subtree = (pid: number): ProcessRow[] => {
    const out: ProcessRow[] = [];
    const stack = [...(byParent.get(pid) ?? [])];
    while (stack.length > 0) {
      const row = stack.pop()!;
      out.push(row);
      stack.push(...(byParent.get(row.pid) ?? []));
    }
    return out;
  };

  const root = rows.find((row) => row.pid === rootPid);
  const candidates: AgentProcess[] = [];
  const app = { rss: root?.rss ?? 0, cpu: root?.cpu ?? 0, processes: root ? 1 : 0 };

  for (const child of byParent.get(rootPid) ?? []) {
    const family = [child, ...subtree(child.pid)];
    const rss = family.reduce((sum, row) => sum + row.rss, 0);
    const cpu = family.reduce((sum, row) => sum + row.cpu, 0);
    if (isAppHelper(child.args)) {
      app.rss += rss;
      app.cpu += cpu;
      app.processes += family.length;
      continue;
    }
    const channelId = channelOf(child.args, ownerOf);
    candidates.push({
      pid: child.pid,
      name: processName(child.args),
      rss,
      cpu: Math.round(cpu * 10) / 10,
      uptimeMs: child.uptimeMs,
      helpers: family.length - 1,
      ...(channelId !== undefined ? { channelId } : {}),
    });
  }
  app.cpu = Math.round(app.cpu * 10) / 10;
  return { candidates, app };
}

/**
 * The agents, out of the candidates: the ones that belong to a chat.
 *
 * An agent is a conversation running. Everything else under ruri — the
 * probes that ask each installed harness what models it has, the shells
 * behind the terminal tabs, a `git` or an `esbuild` — is machinery, and
 * machinery belongs in ruri's own figure, not in a list of chats. It is
 * still counted; it is just not called something it is not.
 */
export function partition(
  candidates: AgentProcess[],
  app: Resources["app"],
): { agents: AgentProcess[]; app: Resources["app"] } {
  const agents: AgentProcess[] = [];
  const mine = { ...app };
  for (const candidate of candidates) {
    if (candidate.channelId !== undefined) {
      agents.push(candidate);
      continue;
    }
    mine.rss += candidate.rss;
    mine.cpu += candidate.cpu;
    mine.processes += candidate.helpers + 1;
  }
  agents.sort((a, b) => b.rss - a.rss);
  mine.cpu = Math.round(mine.cpu * 10) / 10;
  return { agents, app: mine };
}

/**
 * The chat a process was started for, out of its own environment.
 *
 * `ps -E` prints a process's environment, for processes this user owns.
 * That environment also holds the vault's values (server/secrets.ts), so
 * only the one variable is ever read out of it and the rest is dropped
 * where it stands — never logged, never kept, never passed on.
 */
function channelFromEnv(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "/bin/ps",
      ["-Eww", "-p", String(pid)],
      { maxBuffer: 4 * 1024 * 1024, timeout: SAMPLE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          resolve(undefined);
          return;
        }
        resolve(/(?:^|\s)RURI_CHANNEL=(\S+)/.exec(stdout)?.[1]);
      },
    );
  });
}

/** One `ps` over every process on the machine — and the pid it ran as, so
 *  a reading never reports the taking of itself as an agent. */
function ps(): Promise<{ rows: ProcessRow[]; self: number | undefined }> {
  return new Promise((resolve) => {
    const child = execFile(
      "/bin/ps",
      PS_ARGS,
      { maxBuffer: 8 * 1024 * 1024, timeout: SAMPLE_TIMEOUT_MS },
      (err, stdout) => {
        if (err) {
          warn("resources", err, "ps");
          resolve({ rows: [], self: child.pid });
          return;
        }
        resolve({ rows: parsePs(stdout), self: child.pid });
      },
    );
  });
}

/**
 * The meters, running only while a window has the statistics page up.
 *
 * `watching` is moved by the `view` message, the same way the projects
 * page turns on every chat's board lines: nobody looking, nothing sampled,
 * and the timer is not even armed.
 */
export class ResourceMeters {
  private timer: NodeJS.Timeout | undefined;
  private sampling = false;
  /** The last reading, for a window that has just come to the page. */
  private last: Resources | undefined;
  /** Which chat each process belongs to, once asked. A process's
   *  environment never changes, so this is asked once in its life; the
   *  map is pruned to the processes still running. */
  private readonly placed = new Map<number, string | null>();

  constructor(
    private readonly broadcast: (message: ServerMessage) => void,
    /** Which chat a session id belongs to (the archive's). */
    private readonly ownerOf: (sessionId: string) => string | undefined,
    /** The shells behind the terminal tabs — ruri's machinery, not agents
     *  (server/terminal.ts). */
    private readonly shellPids: () => number[] = () => [],
  ) {}

  /** Whether anyone is looking; arms or disarms the sampler. */
  watch(watching: boolean): void {
    if (watching) {
      if (this.timer !== undefined) return;
      this.timer = setInterval(() => void this.sample(), SAMPLE_MS);
      this.timer.unref?.();
      void this.sample();
    } else {
      if (this.timer !== undefined) clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The last reading, if there is one — what a window is sent on arrival. */
  latest(): Resources | undefined {
    return this.last;
  }

  stop(): void {
    this.watch(false);
  }

  /**
   * Name the chat for every agent whose command line did not say.
   *
   * A fresh conversation's harness has no session id to be told, so it is
   * asked what it was given instead. Once per process: the answer cannot
   * change while it runs, and the map is cut back to what is still there.
   */
  private async place(candidates: AgentProcess[]): Promise<void> {
    const live = new Set(candidates.map((a) => a.pid));
    for (const pid of this.placed.keys()) if (!live.has(pid)) this.placed.delete(pid);
    const shells = new Set(this.shellPids());
    await Promise.all(
      candidates.map(async (candidate) => {
        if (candidate.channelId !== undefined) return;
        // a terminal tab's shell is ruri's, and asking it costs a `ps`
        if (shells.has(candidate.pid)) return;
        if (!this.placed.has(candidate.pid)) {
          this.placed.set(candidate.pid, (await channelFromEnv(candidate.pid)) ?? null);
        }
        const found = this.placed.get(candidate.pid);
        if (found) candidate.channelId = found;
      }),
    );
  }

  /** One reading, out to every window. Two never overlap. */
  private async sample(): Promise<void> {
    if (this.sampling) return;
    this.sampling = true;
    try {
      const { rows } = await ps();
      if (rows.length === 0) return;
      const { candidates, app: bare } = rollUp(rows, process.pid, this.ownerOf);
      await this.place(candidates);
      const { agents, app } = partition(candidates, bare);
      this.last = {
        at: Date.now(),
        agents,
        app,
        host: { totalBytes: os.totalmem(), freeBytes: os.freemem(), cores: os.cpus().length },
      };
      this.broadcast({ type: "resources", resources: this.last });
    } catch (err) {
      warn("resources", err, "sample");
    } finally {
      this.sampling = false;
    }
  }
}
