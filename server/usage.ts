import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageLimits } from "../shared/protocol.js";

/**
 * The usage gauges' account side: each harness's own limit windows, keyed by
 * provider id so the dragons flanking the composer read the account the
 * active session actually spends from.
 *
 * Claude's come from the same endpoint Claude Code's own /usage uses,
 * authenticated with the user's existing Claude Code sign-in. Codex writes
 * its windows into every session rollout on disk, so its come from there —
 * no second sign-in, no network. Everything here is best-effort: an
 * unreadable source just leaves that harness's gauges empty.
 */

function parseToken(raw: string): string | null {
  try {
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return data.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

/** The Claude Code OAuth access token: keychain on macOS (the freshest copy —
 *  the CLI refreshes it there), ~/.claude/.credentials.json as the fallback. */
async function accessToken(): Promise<string | null> {
  if (process.platform === "darwin") {
    const raw = await new Promise<string>((resolve) => {
      execFile(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        (err, stdout) => resolve(err ? "" : stdout),
      );
    });
    const token = parseToken(raw);
    if (token) return token;
  }
  try {
    return parseToken(fs.readFileSync(path.join(os.homedir(), ".claude", ".credentials.json"), "utf8"));
  } catch {
    return null;
  }
}

/** Fetch the account's limit windows; null when unavailable. */
export async function fetchUsageLimits(): Promise<UsageLimits | null> {
  const token = await accessToken();
  if (!token) return null;
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      five_hour?: { utilization?: number | null } | null;
      seven_day?: { utilization?: number | null } | null;
      /** The modern shape: one entry per window, the scoped one self-naming. */
      limits?: Array<{
        kind?: string;
        percent?: number | null;
        scope?: { model?: { display_name?: string | null } | null } | null;
      }> | null;
    };
    const limits: UsageLimits = {};
    // the legacy top-level fields first, so an endpoint that drops `limits`
    // still lights the gauges
    if (typeof data.five_hour?.utilization === "number") limits.fiveHour = data.five_hour.utilization;
    if (typeof data.seven_day?.utilization === "number") limits.weekly = data.seven_day.utilization;
    for (const entry of data.limits ?? []) {
      if (typeof entry.percent !== "number") continue;
      if (entry.kind === "session") limits.fiveHour = entry.percent;
      else if (entry.kind === "weekly_all") limits.weekly = entry.percent;
      else if (entry.kind === "weekly_scoped") {
        const label = entry.scope?.model?.display_name;
        if (label) limits.scoped = { label, percent: entry.percent };
      }
    }
    return limits;
  } catch {
    return null;
  }
}

/* ── Codex ────────────────────────────────────────────────────────── */

function codexHome(): string {
  return process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
}

/** The tail of a file, which is where a rollout's latest counts live. */
function tail(file: string, bytes: number): string {
  const handle = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(handle).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(handle, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    fs.closeSync(handle);
  }
}

/** The last token_count entry in a rollout: rate limits, context, window. */
export interface CodexCounts {
  limits: UsageLimits;
  /** Tokens in the window after the session's last turn. */
  tokens?: number;
  /** The model's context window, as Codex itself reports it. */
  window?: number;
}

interface TokenCount {
  info?: {
    total_token_usage?: { total_tokens?: number };
    model_context_window?: number;
  };
  rate_limits?: {
    primary?: { used_percent?: number } | null;
    secondary?: { used_percent?: number } | null;
  };
}

/** Every token_count entry in a rollout's tail, newest first. */
function tokenCounts(file: string): TokenCount[] {
  let text: string;
  try {
    text = tail(file, 64 * 1024);
  } catch {
    return [];
  }
  const entries: TokenCount[] = [];
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"token_count"')) continue;
    try {
      const entry = JSON.parse(line) as { payload?: TokenCount } & TokenCount;
      const payload = entry.payload ?? entry;
      if (payload.rate_limits || payload.info) entries.push(payload);
    } catch {
      // a half-written last line is normal — keep walking back
    }
  }
  return entries;
}

/**
 * Codex's limit windows and last context reading. `session` names a specific
 * rollout (a channel's own session id, which is in the filename); without it
 * the recent rollouts answer, newest first, which is what the account-wide
 * windows want.
 *
 * Entries are walked back rather than read off the end: a turn that hits a
 * different limit bucket writes null percentages, and the last real reading
 * is the one worth showing — an empty dragon should mean "no source", not
 * "the newest line happened to be blank".
 */
export function readCodexCounts(session?: string): CodexCounts | null {
  const files = session ? [rolloutFor(session)] : recentRollouts(ROLLOUT_SCAN);
  const limits: UsageLimits = {};
  let tokens: number | undefined;
  let window: number | undefined;
  let found = false;
  for (const file of files) {
    if (!file) continue;
    for (const entry of tokenCounts(file)) {
      found = true;
      const primary = entry.rate_limits?.primary?.used_percent;
      const secondary = entry.rate_limits?.secondary?.used_percent;
      if (limits.fiveHour === undefined && typeof primary === "number") limits.fiveHour = primary;
      if (limits.weekly === undefined && typeof secondary === "number") limits.weekly = secondary;
      if (tokens === undefined && typeof entry.info?.total_token_usage?.total_tokens === "number") {
        tokens = entry.info.total_token_usage.total_tokens;
      }
      if (window === undefined && typeof entry.info?.model_context_window === "number") {
        window = entry.info.model_context_window;
      }
      if (limits.fiveHour !== undefined && limits.weekly !== undefined && tokens !== undefined) break;
    }
    // a named session answers for itself alone — its own file or nothing
    if (session || (limits.fiveHour !== undefined && limits.weekly !== undefined)) break;
  }
  if (!found) return null;
  return {
    limits,
    ...(tokens !== undefined ? { tokens } : {}),
    ...(window !== undefined ? { window } : {}),
  };
}

/** How many recent rollouts to walk back through for a live reading. A run
 *  that hits the limit writes nothing but nulls, and a burst of those is
 *  exactly when the gauges matter — so the scan reaches past them. */
const ROLLOUT_SCAN = 24;

/** The newest day directories under sessions/YYYY/MM/DD, newest first. */
function recentDays(limit: number): string[] {
  const root = path.join(codexHome(), "sessions");
  let dirs = [root];
  for (let depth = 0; depth < 3; depth++) {
    const next: string[] = [];
    for (const dir of dirs) {
      for (const name of childrenDesc(dir, (n) => /^\d+$/.test(n))) {
        next.push(path.join(dir, name));
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }
    if (next.length === 0) return [];
    dirs = next;
  }
  return dirs.slice(0, limit);
}

/** A directory's matching children, newest name first. */
function childrenDesc(dir: string, filter: (name: string) => boolean): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith(".") && filter(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/** The most recently written rollouts, newest first, across recent days. */
function recentRollouts(count: number): string[] {
  const files: string[] = [];
  for (const dir of recentDays(3)) {
    for (const name of childrenDesc(dir, (n) => n.endsWith(".jsonl"))) {
      files.push(path.join(dir, name));
      if (files.length >= count) return files;
    }
  }
  return files;
}

/** The rollout file for one session id — its name carries the uuid. */
function rolloutFor(session: string): string | undefined {
  const root = path.join(codexHome(), "sessions");
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.includes(session) && entry.name.endsWith(".jsonl")) return full;
    }
  }
  return undefined;
}

/** Every harness's windows, keyed by provider id, for the usage gauges. */
export async function fetchAllUsageLimits(): Promise<Record<string, UsageLimits>> {
  const limits: Record<string, UsageLimits> = {};
  const claude = await fetchUsageLimits();
  if (claude) limits["claude"] = claude;
  const codex = readCodexCounts();
  if (codex && (codex.limits.fiveHour !== undefined || codex.limits.weekly !== undefined)) {
    limits["codex"] = codex.limits;
  }
  return limits;
}
