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

/** The newest entry in a directory, by name — Codex's tree is date-ordered
 *  (sessions/YYYY/MM/DD), so the last name is the latest. */
function newestChild(dir: string, filter?: (name: string) => boolean): string | undefined {
  try {
    const names = fs
      .readdirSync(dir)
      .filter((name) => !name.startsWith(".") && (filter?.(name) ?? true))
      .sort();
    return names[names.length - 1];
  } catch {
    return undefined;
  }
}

/** The rollout Codex wrote most recently, wherever it is in the date tree. */
function newestRollout(): string | undefined {
  let dir = path.join(codexHome(), "sessions");
  for (let depth = 0; depth < 3; depth++) {
    const next = newestChild(dir, (name) => /^\d+$/.test(name));
    if (!next) return undefined;
    dir = path.join(dir, next);
  }
  const file = newestChild(dir, (name) => name.endsWith(".jsonl"));
  return file ? path.join(dir, file) : undefined;
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

/** Read the last token_count line out of a rollout's tail. */
function lastTokenCount(file: string): TokenCount | undefined {
  let text: string;
  try {
    text = tail(file, 256 * 1024);
  } catch {
    return undefined;
  }
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"token_count"')) continue;
    try {
      const entry = JSON.parse(line) as { payload?: TokenCount } & TokenCount;
      const payload = entry.payload ?? entry;
      if (payload.rate_limits || payload.info) return payload;
    } catch {
      // a half-written last line is normal — keep walking back
    }
  }
  return undefined;
}

/**
 * Codex's limit windows and last context reading. `session` names a specific
 * rollout (a channel's own session id, which is in the filename); without it
 * the newest rollout on disk answers, which is what the account-wide windows
 * want.
 */
export function readCodexCounts(session?: string): CodexCounts | null {
  const file = session ? rolloutFor(session) : newestRollout();
  if (!file) return null;
  const entry = lastTokenCount(file);
  if (!entry) return null;
  const limits: UsageLimits = {};
  const primary = entry.rate_limits?.primary?.used_percent;
  const secondary = entry.rate_limits?.secondary?.used_percent;
  if (typeof primary === "number") limits.fiveHour = primary;
  if (typeof secondary === "number") limits.weekly = secondary;
  const tokens = entry.info?.total_token_usage?.total_tokens;
  const window = entry.info?.model_context_window;
  return {
    limits,
    ...(typeof tokens === "number" ? { tokens } : {}),
    ...(typeof window === "number" ? { window } : {}),
  };
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
