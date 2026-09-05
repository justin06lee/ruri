import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { detectProviders } from "@justin06lee/yagami";
import type { HarnessInfo } from "../shared/protocol.js";

/**
 * The harnesses keep themselves current.
 *
 * Every coding CLI ruri can drive — claude, codex, opencode, gemini, goose,
 * whatever yagami detects — is a thing on this machine that goes stale, and
 * a stale one is what you are running until you remember to update it. So
 * ruri checks on the hour, and updates whatever is behind, the way it was
 * installed: its own updater when it has one (claude, opencode), npm or
 * bun for a global package, brew for a formula. Anything installed some
 * other way is reported and left alone.
 *
 * Nothing is ever pulled out from under a running turn: a harness with a
 * session mid-turn is skipped this round. After an update the warm sessions
 * on that harness are retired as each goes idle, so the next prompt runs
 * the new binary (the conversation resumes; only the warm process goes).
 */

export type Channel = HarnessInfo["channel"];

/** Where a binary came from, read off its real path — pure, so it can be
 *  checked without touching a package manager. */
export function channelOf(id: string, realPath: string): { channel: Channel; pkg?: string } {
  const p = realPath.replace(/\\/g, "/");
  if (id === "claude" || /\/\.local\/share\/claude\//.test(p)) return { channel: "self" };
  if (id === "opencode" && /\/\.opencode\//.test(p)) return { channel: "self" };
  const mod = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
  if (mod) {
    return { channel: /\/\.bun\//.test(p) ? "bun" : "npm", pkg: mod[1]! };
  }
  const cellar = /\/Cellar\/([^/]+)\//.exec(p);
  if (cellar) return { channel: "brew", pkg: cellar[1]! };
  return { channel: "other" };
}

const SEMVER = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, env: { ...process.env, CI: "1", NO_COLOR: "1" }, maxBuffer: 4 * 1024 * 1024 },
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
    const res = await fetch(`https://registry.npmjs.org/${pkg}/latest`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } catch {
    return undefined;
  }
}

function whichOnPath(bin: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  const home = os.homedir();
  for (const dir of [path.join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"]) {
    const candidate = path.join(dir, bin);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** The known harnesses on this machine, by binary. */
function installedHarnesses(): Array<{ id: string; label: string; bin: string; path: string }> {
  const out: Array<{ id: string; label: string; bin: string; path: string }> = [];
  const claude = whichOnPath("claude");
  if (claude) out.push({ id: "claude", label: "Claude Code", bin: "claude", path: claude });
  let detected: ReturnType<typeof detectProviders> = [];
  try {
    detected = detectProviders();
  } catch {
    // no providers is fine
  }
  for (const p of detected) {
    if (!p.installed) continue;
    const resolved = p.path ?? whichOnPath(p.id);
    if (!resolved) continue;
    out.push({ id: p.id, label: p.label, bin: path.basename(resolved), path: resolved });
  }
  return out;
}

export interface UpdaterHooks {
  /** Whether a session on this harness is mid-turn right now. */
  busy(harnessId: string): boolean;
  /** Retire the harness's warm sessions as each goes idle. */
  retire(harnessId: string): void;
  onChange(list: HarnessInfo[]): void;
}

const HOUR = 60 * 60_000;
const FIRST_CHECK_MS = 90_000;

export class HarnessUpdater {
  private readonly info = new Map<string, HarnessInfo>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly hooks: UpdaterHooks) {}

  list(): HarnessInfo[] {
    return [...this.info.values()];
  }

  /** On the hour, and a moment after boot. */
  start(): void {
    this.timer = setInterval(() => void this.check(), HOUR);
    setTimeout(() => void this.check(), FIRST_CHECK_MS).unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private publish(): void {
    this.hooks.onChange(this.list());
  }

  /** One round over every installed harness; a round already running is
   *  left to finish (a manual check while one runs simply waits). */
  async check(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const h of installedHarnesses()) {
        let real = h.path;
        try {
          real = fs.realpathSync(h.path);
        } catch {
          // a dangling link — the version call below will say so
        }
        const { channel, pkg } = channelOf(h.id, real);
        const prior = this.info.get(h.id);
        const current = (await versionOf(h.path)) ?? prior?.version;
        const entry: HarnessInfo = {
          ...(prior ?? {}),
          id: h.id,
          label: h.label,
          path: h.path,
          channel,
          ...(pkg ? { pkg } : {}),
          ...(current ? { version: current } : {}),
          checkedAt: Date.now(),
          note: "",
        };
        this.info.set(h.id, entry);
        this.publish();
        await this.update(entry, h.bin);
        this.publish();
      }
    } finally {
      this.running = false;
      this.publish();
    }
  }

  private async update(entry: HarnessInfo, bin: string): Promise<void> {
    if (entry.channel === "other") {
      entry.note = "installed some other way — left alone";
      return;
    }
    if (this.hooks.busy(entry.id)) {
      entry.note = "a session is mid-turn — next hour";
      return;
    }
    let attempted = false;
    if (entry.channel === "self") {
      const args = entry.id === "claude" ? ["update"] : ["upgrade"];
      const { ok, out } = await run(entry.path, args, 5 * 60_000);
      attempted = true;
      if (!ok) {
        entry.note = `its own updater failed: ${firstLine(out)}`;
        return;
      }
    } else if (entry.channel === "npm" || entry.channel === "bun") {
      const latest = await registryLatest(entry.pkg!);
      if (!latest) {
        entry.note = "could not reach the registry";
        return;
      }
      entry.latest = latest;
      if (entry.version === latest) {
        entry.note = "current";
        return;
      }
      const cmd = entry.channel === "bun" ? ["bun", ["add", "-g", `${entry.pkg}@latest`]] as const : ["npm", ["install", "-g", `${entry.pkg}@latest`]] as const;
      const { ok, out } = await run(cmd[0], [...cmd[1]], 10 * 60_000);
      attempted = true;
      if (!ok) {
        entry.note = `${cmd[0]} failed: ${firstLine(out)}`;
        return;
      }
    } else if (entry.channel === "brew") {
      const outdated = await run("brew", ["outdated", "--quiet", entry.pkg!], 2 * 60_000);
      if (!outdated.out.trim()) {
        entry.note = "current";
        return;
      }
      const { ok, out } = await run("brew", ["upgrade", entry.pkg!], 15 * 60_000);
      attempted = true;
      if (!ok) {
        entry.note = `brew failed: ${firstLine(out)}`;
        return;
      }
    }
    if (!attempted) return;
    const after = (await versionOf(entry.path)) ?? entry.version;
    if (after && after !== entry.version) {
      entry.from = entry.version ?? "";
      entry.version = after;
      entry.updatedAt = Date.now();
      entry.note = "";
      this.hooks.retire(entry.id);
    } else {
      entry.note = "current";
    }
    void bin;
  }
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 160);
}
