import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { UsageLimits } from "../shared/protocol.js";

/**
 * The usage gauges' account side: the 5-hour and 7-day limit windows, read
 * from the same endpoint Claude Code's own /usage uses, authenticated with
 * the user's existing Claude Code sign-in (never any other credentials).
 * Everything here is best-effort — no token or a failed fetch just means
 * the gauges stay empty.
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
