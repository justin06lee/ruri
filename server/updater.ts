import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { detectProviders, findExecutable } from "@justin06lee/yagami";
import type { HarnessInfo } from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/**
 * The harnesses keep themselves current.
 *
 * Every coding CLI ruri can drive — claude, codex, opencode, gemini,
 * goose, whatever yagami finds — is a binary on this machine that goes
 * stale, and a stale one is what every chat runs until somebody remembers
 * to update it. So ruri looks on the hour: what each one is, what the
 * newest is, and — for the ones left to update themselves, which is all
 * of them unless you say otherwise — brings the ones behind up to date,
 * the way each was installed: its own updater when it has one (`claude
 * update`, `opencode upgrade`), bun or npm for a global package, brew for
 * a formula. Anything installed some other way is reported, not touched.
 *
 * Nothing is replaced under a running turn: a harness with a chat
 * mid-turn waits for the next round. After an update the warm sessions on
 * it are retired as each goes idle, so the next prompt runs the new
 * binary (the conversation resumes; only the process is new).
 *
 * What it found, and which harnesses you would rather update by hand, are
 * kept in ~/.config/ruri/harnesses.json — the Settings page shows the last
 * round the moment it opens, not a minute after launch.
 */

export type Channel = HarnessInfo["channel"];

/** The npm package each self-updating harness is published as — where
 *  the newest version is read without running anything. */
const PUBLISHED: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  opencode: "opencode-ai",
};

/** Where a binary came from, read off its real path — pure, so it can be
 *  checked without touching a package manager. */
export function channelOf(realPath: string): { channel: Channel; pkg?: string } {
  const p = realPath.replace(/\\/g, "/");
  if (/\/\.local\/share\/claude\//.test(p)) return { channel: "self", pkg: PUBLISHED["claude"]! };
  if (/\/\.opencode\/bin\//.test(p)) return { channel: "self", pkg: PUBLISHED["opencode"]! };
  const mod = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
  if (mod) return { channel: /\/\.bun\//.test(p) ? "bun" : "npm", pkg: mod[1]! };
  const cellar = /\/Cellar\/([^/]+)\//.exec(p);
  if (cellar) return { channel: "brew", pkg: cellar[1]! };
  return { channel: "other" };
}

const SEMVER = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/**
 * A version read off where the binary lives, when the path says it —
 * claude's versions/<v>, a package's own package.json, brew's Cellar —
 * so an hourly look spawns nothing for most harnesses.
 */
export function versionFromPath(channel: Channel, realPath: string, pkg?: string): string | undefined {
  const p = realPath.replace(/\\/g, "/");
  const claude = /\/\.local\/share\/claude\/versions\/([^/]+)$/.exec(p);
  if (claude) return SEMVER.exec(claude[1]!)?.[1];
  if ((channel === "npm" || channel === "bun") && pkg) {
    const root = p.slice(0, p.indexOf(`/node_modules/${pkg}/`) + `/node_modules/${pkg}`.length);
    try {
      const version = (
        JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as { version?: unknown }
      ).version;
      return typeof version === "string" ? version : undefined;
    } catch {
      return undefined;
    }
  }
  if (channel === "brew" && pkg) return SEMVER.exec(/\/Cellar\/[^/]+\/([^/]+)\//.exec(p)?.[1] ?? "")?.[1];
  return undefined;
}

/** Whether `a` is an older version than `b`, by their numbers — a
 *  pre-release counts as older than its release. */
export function older(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = "", pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return x.pre !== undefined && y.pre === undefined;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        env: { ...process.env, CI: "1", NO_COLOR: "1", HOMEBREW_NO_ENV_HINTS: "1" },
        maxBuffer: 4 * 1024 * 1024,
      },
      (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout}\n${stderr}`.trim() }),
    );
  });
}

/** `<bin> --version`, reduced to the first version-looking thing in it. */
async function versionOf(bin: string): Promise<string | undefined> {
  const { out } = await run(bin, ["--version"], 20_000);
  return SEMVER.exec(out)?.[1];
}

async function registryLatest(pkg: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/** The newest version of a formula brew knows of — from its local tap
 *  data, which `brew upgrade` refreshes before it does anything. */
async function brewLatest(brew: string, formula: string): Promise<string | undefined> {
  const { ok, out } = await run(brew, ["info", "--json=v2", formula], 60_000);
  if (!ok) return undefined;
  try {
    const body = JSON.parse(out.slice(out.indexOf("{"))) as {
      formulae?: Array<{ versions?: { stable?: string } }>;
    };
    return body.formulae?.[0]?.versions?.stable;
  } catch {
    return undefined;
  }
}

/** The known harnesses on this machine, by binary. */
function installedHarnesses(): Array<{ id: string; label: string; path: string }> {
  const out: Array<{ id: string; label: string; path: string }> = [];
  let detected: ReturnType<typeof detectProviders> = [];
  try {
    detected = detectProviders();
  } catch {
    // none is fine
  }
  const claude = findExecutable("claude");
  if (claude && !detected.some((p) => p.id === "claude" && p.installed)) {
    out.push({ id: "claude", label: "Claude Code", path: claude });
  }
  for (const p of detected) {
    if (!p.installed || !p.path) continue;
    out.push({ id: p.id, label: p.label, path: p.path });
  }
  return out;
}

/** The command that brings a harness up to date, the way it was installed. */
function updateCommand(entry: HarnessInfo, real: string): { cmd: string; args: string[] } | undefined {
  switch (entry.channel) {
    case "self":
      return { cmd: entry.path, args: entry.id === "opencode" ? ["upgrade"] : ["update"] };
    case "bun": {
      const bun = findExecutable("bun");
      return bun ? { cmd: bun, args: ["add", "-g", `${entry.pkg}@latest`] } : undefined;
    }
    case "npm": {
      // the npm of the prefix the package lives under, so a Homebrew node's
      // globals are updated by that node's npm and not another one's
      const at = real.indexOf("/lib/node_modules/");
      const beside = at > 0 ? path.join(real.slice(0, at), "bin", "npm") : "";
      const npm = beside && fs.existsSync(beside) ? beside : findExecutable("npm");
      return npm ? { cmd: npm, args: ["install", "-g", `${entry.pkg}@latest`] } : undefined;
    }
    case "brew": {
      const brew = findExecutable("brew");
      return brew ? { cmd: brew, args: ["upgrade", entry.pkg!] } : undefined;
    }
    default:
      return undefined;
  }
}

export interface UpdaterHooks {
  /** Whether a chat on this harness is mid-turn right now. */
  busy(harnessId: string): boolean;
  /** Retire the harness's warm sessions as each goes idle. */
  retire(harnessId: string): void;
  /** The list moved; `checking` while a round is still going. */
  onChange(list: HarnessInfo[], checking: boolean): void;
}

interface Saved {
  /** Harnesses the user updates by hand: they are looked at, not touched. */
  manual?: string[];
  /** What the last round found, shown until the next one says otherwise. */
  last?: HarnessInfo[];
}

const HOUR = 60 * 60_000;
const FIRST_CHECK_MS = 90_000;

export class HarnessUpdater {
  private readonly info = new Map<string, HarnessInfo>();
  private readonly manual = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly hooks: UpdaterHooks) {
    try {
      const saved = JSON.parse(fs.readFileSync(this.file(), "utf8")) as Saved;
      for (const id of saved.manual ?? []) this.manual.add(id);
      // a round cut off by a quit is not still running
      for (const h of saved.last ?? []) this.info.set(h.id, { ...h, updating: false });
    } catch (err) {
      if (!isMissing(err)) warn("updater", err, "load");
    }
  }

  private file(): string {
    return configPath("harnesses.json");
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file(), { manual: [...this.manual], last: this.list() } satisfies Saved);
    } catch (err) {
      warn("updater", err, "save");
    }
  }

  list(): HarnessInfo[] {
    return [...this.info.values()].map((h) => ({ ...h, auto: !this.manual.has(h.id) }));
  }

  /** On the hour, and a minute and a half after launch. */
  start(): void {
    this.timer = setInterval(() => void this.check(), HOUR);
    this.timer.unref();
    this.first = setTimeout(() => void this.check(), FIRST_CHECK_MS);
    this.first.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    this.timer = this.first = null;
  }

  /** Leave a harness to update itself, or to you. */
  setAuto(id: string, auto: boolean): void {
    if (auto) this.manual.delete(id);
    else this.manual.add(id);
    this.publish();
  }

  /** Whether a round is going right now. */
  checking(): boolean {
    return this.running !== null;
  }

  private publish(): void {
    this.save();
    this.hooks.onChange(this.list(), this.checking());
  }

  /**
   * One round over every installed harness: what it is, what the newest
   * is, and — when it is behind, left to update itself and not mid-turn —
   * the update. `only` narrows it to one harness updated now, by hand,
   * whether or not it is left to itself. A round already running is
   * waited for, not doubled.
   */
  check(only?: string): Promise<void> {
    if (this.running) return this.running.then(() => (only ? this.check(only) : undefined));
    this.running = this.round(only).finally(() => {
      this.running = null;
      this.publish();
    });
    return this.running;
  }

  private async round(only?: string): Promise<void> {
    const found = installedHarnesses();
    if (!only) {
      // a harness uninstalled since the last round is no longer shown
      for (const id of [...this.info.keys()]) if (!found.some((h) => h.id === id)) this.info.delete(id);
    }
    for (const h of found) {
      if (only && h.id !== only) continue;
      let real = h.path;
      try {
        real = fs.realpathSync(h.path);
      } catch {
        // a dangling link: --version below says what it can
      }
      const { channel, pkg } = channelOf(real);
      const prior = this.info.get(h.id);
      const version = versionFromPath(channel, real, pkg) ?? (await versionOf(h.path)) ?? prior?.version;
      const entry: HarnessInfo = {
        ...(prior?.updatedAt ? { updatedAt: prior.updatedAt, from: prior.from } : {}),
        id: h.id,
        label: h.label,
        path: h.path,
        channel,
        ...(pkg ? { pkg } : {}),
        ...(version ? { version } : {}),
        checkedAt: Date.now(),
      };
      const latest =
        channel === "brew"
          ? await brewLatest(findExecutable("brew") ?? "brew", pkg!)
          : pkg
            ? await registryLatest(pkg)
            : undefined;
      if (latest) entry.latest = latest;
      this.info.set(h.id, entry);
      this.publish();
      await this.bringUp(entry, real, only === h.id);
      this.info.set(h.id, entry);
      this.publish();
    }
  }

  private async bringUp(entry: HarnessInfo, real: string, byHand: boolean): Promise<void> {
    const behind = entry.version && entry.latest ? older(entry.version, entry.latest) : undefined;
    if (behind === false) return;
    if (entry.channel === "other") {
      entry.note = "installed some other way — update it where it came from";
      return;
    }
    if (behind === undefined && !byHand) {
      entry.note = "couldn't tell what the newest is";
      return;
    }
    if (!byHand && this.manual.has(entry.id)) {
      entry.note = "you update this one yourself";
      return;
    }
    if (this.hooks.busy(entry.id)) {
      entry.note = "a chat on it is mid-turn — it updates once that's done";
      return;
    }
    const command = updateCommand(entry, real);
    if (!command) {
      entry.note = `no ${entry.channel} found to update it with`;
      return;
    }
    entry.updating = true;
    this.info.set(entry.id, entry);
    this.publish();
    const { ok, out } = await run(command.cmd, command.args, 15 * 60_000);
    entry.updating = false;
    if (!ok) {
      entry.note = `${path.basename(command.cmd)} failed: ${firstLine(out)}`;
      return;
    }
    let after = entry.version;
    try {
      const now = fs.realpathSync(entry.path);
      after = versionFromPath(entry.channel, now, entry.pkg) ?? (await versionOf(entry.path)) ?? after;
    } catch {
      after = (await versionOf(entry.path)) ?? after;
    }
    if (after && after !== entry.version) {
      entry.from = entry.version ?? "";
      entry.version = after;
      entry.updatedAt = Date.now();
      delete entry.note;
      this.hooks.retire(entry.id);
    } else if (behind) {
      // its own updater said it was current: its channel is behind npm's
      entry.note = "its updater says it's current on its channel";
    }
  }
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160);
}
