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
 * So ruri counts them itself. One `ps` gives every process on the machine
 * (on Linux, /proc does — see ProcReader for why); the ones descended from
 * this one are ruri's, and each direct child of it is rolled up with
 * everything it started — a harness and its MCP servers are one agent, not
 * six rows.
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
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentProcess, Resources, ServerMessage } from "../shared/protocol.js";
import { warn } from "./log.js";

/** The machine's size, which does not change while it runs — `os.cpus()`
 *  reads every core's details to be counted, so it is counted once. */
const CORES = os.cpus().length;
const TOTAL_BYTES = os.totalmem();

/** How often the machine is asked, while anyone is looking. */
const SAMPLE_MS = 2_000;

/** A sample that takes longer than this is abandoned: the answer would be
 *  stale by the time it arrived, and another is due. */
const SAMPLE_TIMEOUT_MS = 4_000;

/** One process, as read. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  /** The memory it holds, in bytes — its proportional share on Linux,
   *  its resident size on macOS. */
  memory: number;
  /** Percent of one core, over the last little while. */
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
      memory: Number(match[3]) * 1024,
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
  const app = { memory: root?.memory ?? 0, cpu: root?.cpu ?? 0, processes: root ? 1 : 0 };

  for (const child of byParent.get(rootPid) ?? []) {
    const family = [child, ...subtree(child.pid)];
    const memory = family.reduce((sum, row) => sum + row.memory, 0);
    const cpu = family.reduce((sum, row) => sum + row.cpu, 0);
    if (isAppHelper(child.args)) {
      app.memory += memory;
      app.cpu += cpu;
      app.processes += family.length;
      continue;
    }
    const channelId = channelOf(child.args, ownerOf);
    candidates.push({
      pid: child.pid,
      name: processName(child.args),
      memory,
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
    mine.memory += candidate.memory;
    mine.cpu += candidate.cpu;
    mine.processes += candidate.helpers + 1;
  }
  agents.sort((a, b) => b.memory - a.memory);
  mine.cpu = Math.round(mine.cpu * 10) / 10;
  return { agents, app: mine };
}

/**
 * The chat a process was started for, out of its own environment.
 *
 * `ps -E` prints a process's environment, for processes this user owns
 * (Linux's ps has no -E; there it is /proc/<pid>/environ, the same thing).
 * That environment also holds the vault's values (server/secrets.ts), so
 * only the one variable is ever read out of it and the rest is dropped
 * where it stands — never logged, never kept, never passed on.
 */
function channelFromEnv(pid: number): Promise<string | undefined> {
  if (process.platform === "linux") {
    return fs.promises.readFile(`/proc/${pid}/environ`, "utf8").then(
      (env) => /(?:^|\0)RURI_CHANNEL=([^\0]+)/.exec(env)?.[1],
      () => undefined,
    );
  }
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

/** Clock ticks per second in /proc's counts. That is USER_HZ, which the
 *  kernel's ABI fixes at 100 whatever HZ it was built with. */
const USER_HZ = 100;

/** How long the reader looks before its first answer: a CPU figure is the
 *  difference between two readings, and the first has nothing before it. */
const BASELINE_MS = 500;

/** How long a process's memory is trusted. Reading it walks every mapping
 *  the process has — 5 ms of the kernel's time for the window's, 7 for a
 *  harness — so it is taken now and then, off the main thread, rather than
 *  every reading. Memory moves slowly; CPU is what is read every time. */
const MEMORY_MS = 10_000;

/** What /proc/<pid>/stat says that a reading needs. */
export interface ProcStat {
  ppid: number;
  /** CPU time it has spent, user and system, in ticks. */
  ticks: number;
  /** When it started, in ticks after boot. */
  start: number;
}

/** A process as the last reading left it. */
interface Seen extends ProcStat {
  args: string;
  memory: number;
  /** When `memory` was read (epoch ms); 0 for never. */
  memoryAt: number;
}

/** The fields of a /proc/<pid>/stat line this needs, or nothing for one it
 *  cannot read. The command's name sits in parentheses and may hold spaces
 *  and parentheses of its own, so everything is counted from the last ")". */
export function parseStat(line: string): ProcStat | undefined {
  const close = line.lastIndexOf(")");
  if (close < 0) return undefined;
  // field 3 (the state) first: ppid is field 4, utime 14, stime 15, and
  // the start, in ticks after boot, 22
  const fields = line.slice(close + 2).split(" ");
  const ppid = Number(fields[1]);
  const ticks = Number(fields[11]) + Number(fields[12]);
  const start = Number(fields[19]);
  if (!Number.isFinite(ppid) || !Number.isFinite(ticks) || !Number.isFinite(start)) return undefined;
  return { ppid, ticks, start };
}

const statBuffer = Buffer.alloc(1024);

/** One process's stat, read straight off a file descriptor: a whole scan
 *  of the machine through readFileSync costs four times as much. */
function readStat(pid: number): ProcStat | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(`/proc/${pid}/stat`, "r");
    const length = fs.readSync(fd, statBuffer, 0, statBuffer.length, 0);
    return parseStat(statBuffer.toString("latin1", 0, length));
  } catch {
    // gone between the listing and the read
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** A process's proportional share of memory, in bytes: each page it shares
 *  counted as a fraction, so the shares of every process add up to what is
 *  really held. */
async function readMemory(pid: number): Promise<number | undefined> {
  try {
    const kb = /^Pss:\s+(\d+) kB/m.exec(
      await fs.promises.readFile(`/proc/${pid}/smaps_rollup`, "latin1"),
    )?.[1];
    return kb === undefined ? undefined : Number(kb) * 1024;
  } catch {
    return undefined;
  }
}

/** Seconds since boot — the clock /proc's start times are on. */
function uptime(): number {
  return Number(fs.readFileSync("/proc/uptime", "latin1").split(" ")[0]);
}

/**
 * ruri's processes on Linux, out of /proc — because `ps` there answers
 * different questions from the ones this page asks.
 *
 * Its %CPU is a process's CPU time over its whole life, not what it is
 * doing now (macOS's is an average over the last minute, which is what
 * the page means). A window that had just launched read 379% for minutes
 * after it had gone quiet. And its RSS counts every page a process can
 * see, so Chromium's helpers — forked from one zygote and sharing most of
 * themselves — were each counted whole: 922 MB for what was 312. Here CPU
 * is the ticks each process spent between two readings, and memory its
 * proportional share, which adds up to the truth.
 *
 * It is also cheaper. Forking this 40-thread process to run `ps` every two
 * seconds cost more than anything the page measured. A reading here lists
 * /proc and reads the stat of ruri's own processes and of any pid it has
 * not met before; a pid that is not ruri's never becomes ruri's (an orphan
 * is handed to init, not to us), so it is read once and then skipped until
 * it is gone.
 */
export class ProcReader {
  /** Pids known not to be ruri's. */
  private readonly outside = new Set<number>();
  /** Each of ruri's processes at the last reading. `start` tells a pid the
   *  kernel has handed to someone new from the process that had it. */
  private last = new Map<number, Seen>();
  /** When the last reading was taken, in seconds since boot. */
  private lastAt: number | undefined;
  /** Moved by `reset`, so a reading in flight across one is dropped. */
  private generation = 0;

  /** Forget everything: the next reading takes its own baseline. A figure
   *  measured across the hour nobody was looking is not "now". */
  reset(): void {
    this.generation += 1;
    this.outside.clear();
    this.last = new Map();
    this.lastAt = undefined;
  }

  /** ruri's processes now — `rootPid` and everything under it — with CPU
   *  since the last reading. Empty if a reset overtook it. */
  async read(rootPid: number): Promise<ProcessRow[]> {
    const generation = this.generation;
    if (this.lastAt === undefined) {
      const { at, tree } = this.scan(rootPid);
      for (const [pid, stat] of tree) this.last.set(pid, { ...stat, args: "", memory: 0, memoryAt: 0 });
      this.lastAt = at;
      await new Promise((resolve) => setTimeout(resolve, BASELINE_MS));
      if (generation !== this.generation) return [];
    }
    const since = this.lastAt;
    const { at, tree } = this.scan(rootPid);
    const now = Date.now();
    const next = new Map<number, Seen>();
    const rows = await Promise.all(
      [...tree].map(async ([pid, stat]): Promise<ProcessRow> => {
        const was = this.last.get(pid);
        const same = was?.start === stat.start ? was : undefined;
        // one that was not here last time has started since, so all the
        // time it has spent was spent in this interval
        const spent = (stat.ticks - (same?.ticks ?? 0)) / USER_HZ;
        const kept = same && same.memoryAt > 0 && now - same.memoryAt < MEMORY_MS ? same : undefined;
        const memory = kept ? kept.memory : ((await readMemory(pid)) ?? same?.memory ?? 0);
        const args = same?.args || readArgs(pid);
        next.set(pid, { ...stat, args, memory, memoryAt: kept ? kept.memoryAt : now });
        return {
          pid,
          ppid: stat.ppid,
          memory,
          cpu: at > since ? (spent / (at - since)) * 100 : 0,
          uptimeMs: Math.max(0, (at - stat.start / USER_HZ) * 1_000),
          args,
        };
      }),
    );
    if (generation !== this.generation) return [];
    this.last = next;
    this.lastAt = at;
    return rows;
  }

  /** Every process of ruri's that is running, by its stat. */
  private scan(rootPid: number): { at: number; tree: Map<number, ProcStat> } {
    const at = uptime();
    const listed = new Set<number>();
    const read = new Map<number, ProcStat>();
    for (const name of fs.readdirSync("/proc")) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      listed.add(pid);
      if (this.outside.has(pid)) continue;
      const stat = readStat(pid);
      if (stat) read.set(pid, stat);
    }
    // a pid that has gone may come back as anyone's
    for (const pid of this.outside) if (!listed.has(pid)) this.outside.delete(pid);
    const byParent = new Map<number, number[]>();
    for (const [pid, stat] of read) {
      const kin = byParent.get(stat.ppid);
      if (kin) kin.push(pid);
      else byParent.set(stat.ppid, [pid]);
    }
    const tree = new Map<number, ProcStat>();
    const stack = [rootPid];
    while (stack.length > 0) {
      const pid = stack.pop()!;
      const stat = read.get(pid);
      if (!stat || tree.has(pid)) continue;
      tree.set(pid, stat);
      stack.push(...(byParent.get(pid) ?? []));
    }
    for (const pid of read.keys()) if (!tree.has(pid)) this.outside.add(pid);
    return { at, tree };
  }
}

/** A process's command line, as `ps` would print it. */
function readArgs(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0+$/, "").replace(/\0/g, " ");
  } catch {
    return "";
  }
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
  /** Linux reads /proc rather than running `ps` (ProcReader says why). */
  private readonly proc = process.platform === "linux" ? new ProcReader() : undefined;

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
      this.proc?.reset();
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
      const rows = this.proc ? await this.proc.read(process.pid) : (await ps()).rows;
      if (rows.length === 0 || this.timer === undefined) return;
      const { candidates, app: bare } = rollUp(rows, process.pid, this.ownerOf);
      await this.place(candidates);
      const { agents, app } = partition(candidates, bare);
      this.last = {
        at: Date.now(),
        agents,
        app,
        host: { totalBytes: TOTAL_BYTES, freeBytes: os.freemem(), cores: CORES },
      };
      this.broadcast({ type: "resources", resources: this.last });
    } catch (err) {
      warn("resources", err, "sample");
    } finally {
      this.sampling = false;
    }
  }
}
