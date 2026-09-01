import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectStats, Totals } from "../shared/protocol.js";

/**
 * What each project has cost, by the day.
 *
 * Every finished turn reports what it spent — tokens, dollars at API
 * prices, wall time — and the transcript keeps that on its result line.
 * But transcripts are truncated by rewinds, wiped by compaction's forgetful
 * cousins, and Home's is thrown away on every launch, so the transcript is
 * no place to add anything up. This is: one bucket per project per day,
 * added to as results land, kept under the config dir and never pruned —
 * a year of days for a busy project is a few kilobytes.
 */

function ledgerFile(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "ledger.json",
  );
}

const ZERO: Totals = { tokens: 0, costUsd: 0, turns: 0, ms: 0 };

function add(a: Totals, b: Partial<Totals>): Totals {
  return {
    tokens: a.tokens + (b.tokens ?? 0),
    costUsd: a.costUsd + (b.costUsd ?? 0),
    turns: a.turns + (b.turns ?? 0),
    ms: a.ms + (b.ms ?? 0),
  };
}

/** Local calendar day, the way a person would draw the line. */
function dayOf(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

const WRITE_DELAY_MS = 800;

export class LedgerStore {
  /** project id → day → totals */
  private readonly days = new Map<string, Map<string, Totals>>();
  private timer: NodeJS.Timeout | null = null;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(ledgerFile(), "utf8")) as Record<string, Record<string, Partial<Totals>>>;
      for (const [projectId, days] of Object.entries(raw)) {
        if (!days || typeof days !== "object") continue;
        const map = new Map<string, Totals>();
        for (const [day, totals] of Object.entries(days)) map.set(day, add(ZERO, totals));
        this.days.set(projectId, map);
      }
    } catch {
      // nothing spent yet
    }
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        fs.mkdirSync(path.dirname(ledgerFile()), { recursive: true });
        const out: Record<string, Record<string, Totals>> = {};
        for (const [projectId, days] of this.days) out[projectId] = Object.fromEntries(days);
        fs.writeFileSync(ledgerFile(), JSON.stringify(out, null, 1));
      } catch {
        // best-effort; the in-memory sums stay right
      }
    }, WRITE_DELAY_MS);
  }

  /** A turn finished on one of this project's sessions. */
  record(projectId: string, spent: Partial<Totals>, ts = Date.now()): void {
    const days = this.days.get(projectId) ?? new Map<string, Totals>();
    const day = dayOf(ts);
    days.set(day, add(days.get(day) ?? ZERO, { ...spent, turns: spent.turns ?? 1 }));
    this.days.set(projectId, days);
    this.save();
  }

  stats(projectId: string, now = Date.now()): ProjectStats {
    const days = this.days.get(projectId);
    const today = dayOf(now);
    const weekAgo = dayOf(now - 6 * 86_400_000);
    let total = ZERO;
    let todayTotals = ZERO;
    let week = ZERO;
    for (const [day, totals] of days ?? []) {
      total = add(total, totals);
      if (day === today) todayTotals = add(todayTotals, totals);
      if (day >= weekAgo) week = add(week, totals);
    }
    return { total, today: todayTotals, week };
  }

  all(projectIds: Iterable<string>): Record<string, ProjectStats> {
    const now = Date.now();
    return Object.fromEntries([...projectIds].map((id) => [id, this.stats(id, now)]));
  }

  removeProject(projectId: string): void {
    if (this.days.delete(projectId)) this.save();
  }

  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      const out: Record<string, Record<string, Totals>> = {};
      for (const [projectId, days] of this.days) out[projectId] = Object.fromEntries(days);
      fs.writeFileSync(ledgerFile(), JSON.stringify(out, null, 1));
    } catch {
      // best-effort
    }
  }
}
