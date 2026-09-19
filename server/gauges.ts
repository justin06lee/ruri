/**
 * The usage gauges: each harness's own limit windows (5h / weekly), read
 * on a slow poll and nudged after every turn, keyed by provider id so the
 * dragons show the account the active session spends from. (Per-channel
 * context occupancy is the other gauge — see turns.ts.)
 */
import type { ServerMessage, UsageLimits } from "../shared/protocol.js";
import { fetchAllUsageLimits, loadCachedLimits, saveCachedLimits } from "./usage.js";

/** A usage read that comes back empty is retried on this backoff — quick at
 *  first, since the usual causes clear in seconds, then easing off. */
const USAGE_RETRY_MIN_MS = 5_000;
const USAGE_RETRY_MAX_MS = 120_000;

export class UsageGauges {
  /** The last run's reading opens the gauges on numbers instead of dashes;
   *  the first fetch of this run replaces it moments later. */
  limits: Record<string, UsageLimits> = loadCachedLimits();
  private lastFetch = 0;
  /** How long to wait before trying again after a read comes back empty. */
  private retryIn = USAGE_RETRY_MIN_MS;
  private retry: NodeJS.Timeout | undefined;

  constructor(private readonly broadcast: (message: ServerMessage) => void) {}

  pushUsage = (force = false): void => {
    if (!force && Date.now() - this.lastFetch < 60_000) return;
    this.lastFetch = Date.now();
    void fetchAllUsageLimits().then((limits) => {
      if (Object.keys(limits).length === 0) {
        // Nothing came back: the sign-in token is mid-refresh, the network
        // isn't up yet, the endpoint is having a moment. Any of those clear
        // in seconds, so try again on a short backoff rather than leaving
        // the gauges blank until the next five-minute tick.
        if (this.retry) return;
        this.retry = setTimeout(() => {
          this.retry = undefined;
          this.retryIn = Math.min(this.retryIn * 2, USAGE_RETRY_MAX_MS);
          this.pushUsage(true);
        }, this.retryIn);
        return;
      }
      this.retryIn = USAGE_RETRY_MIN_MS;
      this.limits = limits;
      saveCachedLimits(limits);
      this.broadcast({ type: "usage", limits });
    });
  };

  /** No more reads: the server is closing. */
  stop(): void {
    if (this.retry) clearTimeout(this.retry);
  }
}
