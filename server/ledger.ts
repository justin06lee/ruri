import * as fs from "node:fs";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import type { ProjectStats, Totals } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";

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
  return configPath("ledger.json");
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
export function dayOf(ts: number): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

const WRITE_DELAY_MS = 800;

export class LedgerStore {
  /** project id → day → totals */
  private readonly days = new Map<string, Map<string, Totals>>();
  /** Where it lives, fixed when it is made: a write a moment after a
   *  change goes where the store was read from, whatever the config
   *  folder is by then (a test that set its own and put it back). */
  private readonly file = ledgerFile();
  private timer: NodeJS.Timeout | null = null;
  /** What this process recorded itself, by project and day: right from
   *  the start, so a rebuild of the dollars before it leaves these be. */
  private readonly fresh = new Map<string, Map<string, Totals>>();

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<
        string,
        Record<string, Partial<Totals>>
      >;
      for (const [projectId, days] of Object.entries(raw)) {
        if (!days || typeof days !== "object") continue;
        const map = new Map<string, Totals>();
        for (const [day, totals] of Object.entries(days)) map.set(day, add(ZERO, totals));
        this.days.set(projectId, map);
      }
    } catch (err) {
      if (!isMissing(err)) warn("ledger", err, "new LedgerStore");
      // nothing spent yet
    }
  }

  private save(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        const out: Record<string, Record<string, Totals>> = {};
        for (const [projectId, days] of this.days) out[projectId] = Object.fromEntries(days);
        writeJsonAtomic(this.file, out, 1);
      } catch (err) {
        warn("ledger", err, "save");
        // best-effort; the in-memory sums stay right
      }
    }, WRITE_DELAY_MS);
  }

  /** Nothing recorded yet, ever: a new install, or a test's own folder. */
  get empty(): boolean {
    return this.days.size === 0;
  }

  /** A turn finished on one of this project's sessions. */
  record(projectId: string, spent: Partial<Totals>, ts = Date.now()): void {
    const days = this.days.get(projectId) ?? new Map<string, Totals>();
    const day = dayOf(ts);
    days.set(day, add(days.get(day) ?? ZERO, { ...spent, turns: spent.turns ?? 1 }));
    this.days.set(projectId, days);
    const fresh = this.fresh.get(projectId) ?? new Map<string, Totals>();
    fresh.set(day, add(fresh.get(day) ?? ZERO, { ...spent, turns: spent.turns ?? 1 }));
    this.fresh.set(projectId, fresh);
    this.save();
  }

  /**
   * Puts right the dollars recorded before this process started, when every
   * turn's cost was the CLI's running total (turnCost.ts). Each day takes
   * what its transcripts say it cost (`rebuilt`, from ledgerRebuild.ts),
   * plus what this process recorded itself. A day whose transcripts are
   * gone is estimated from its tokens, at what a token cost the project on
   * the days that still have them (or across all projects when it has none).
   */
  rebuildCosts(rebuilt: Map<string, Map<string, number>>): void {
    const freshOf = (projectId: string, day: string) => this.fresh.get(projectId)?.get(day) ?? ZERO;
    const rates = new Map<string, number>();
    let allCost = 0;
    let allTokens = 0;
    for (const [projectId, days] of this.days) {
      let cost = 0;
      let tokens = 0;
      for (const [day, totals] of days) {
        const known = rebuilt.get(projectId)?.get(day);
        if (known === undefined) continue;
        cost += known;
        tokens += totals.tokens - freshOf(projectId, day).tokens;
      }
      if (tokens > 0) rates.set(projectId, cost / tokens);
      allCost += cost;
      allTokens += tokens;
    }
    const overall = allTokens > 0 ? allCost / allTokens : undefined;
    for (const [projectId, costs] of rebuilt) {
      const days = this.days.get(projectId) ?? new Map<string, Totals>();
      for (const day of costs.keys()) if (!days.has(day)) days.set(day, ZERO);
      this.days.set(projectId, days);
    }
    for (const [projectId, days] of this.days) {
      const rate = rates.get(projectId) ?? overall;
      for (const [day, totals] of days) {
        const fresh = freshOf(projectId, day);
        const before = rebuilt.get(projectId)?.get(day) ?? (rate === undefined ? undefined : (totals.tokens - fresh.tokens) * rate);
        if (before === undefined) continue;
        days.set(day, { ...totals, costUsd: before + fresh.costUsd });
      }
    }
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
      writeJsonAtomic(this.file, out, 1);
    } catch (err) {
      warn("ledger", err, "flush");
      // best-effort
    }
  }
}
