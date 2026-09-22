/**
 * Why a turn fell over, when it was the world's doing rather than the
 * conversation's: nothing reached the API (the connection dropped, DNS
 * failed, a firewall turned it away), or the account ran out of usage.
 * Either way a prompt sent behind it would meet the same wall, so the queue
 * holds (server/chats.ts) instead of spending itself against it, and for a
 * dropped connection ruri watches for the line to come back.
 */
import * as net from "node:net";
import { warn } from "./log.js";

export type Blocked = "network" | "limit";

/** Nothing reached the API: the words Claude Code, Codex and Node use for a
 *  connection that never happened, or was cut on the way. */
export const NETWORK =
  /enotfound|eai_again|enetunreach|enetdown|ehostunreach|econnrefused|econnreset|etimedout|epipe|connection ?refused|connection error|socket hang up|fetch failed|network error|can[’']?t reach|cannot reach|unable to connect|could not resolve|getaddrinfo|error sending request|stream disconnected|request timed out/i;

/** The account's usage: a window that resets in hours, or credit to buy.
 *  Not "limit reached" alone — a context or turn limit says that too, and
 *  waiting is no answer to those. */
const LIMIT =
  /usage limit|rate limit|hit your (?:usage )?limit|(?:hour|weekly|daily|monthly|session) limit|limit (?:will )?resets?|limiting requests|quota|too many requests|credit balance|out of (?:credits|tokens)|billing/i;

/** What a failed turn was up against, if it was the world. `status` is the
 *  HTTP status when the harness names one (Claude does). */
export function blockedBy(text: string | undefined, status?: number | null): Blocked | undefined {
  if (status === 429) return "limit";
  if (!text) return undefined;
  if (LIMIT.test(text)) return "limit";
  // any other status means the API answered: the connection was fine
  if (typeof status === "number") return undefined;
  return NETWORK.test(text) ? "network" : undefined;
}

/** When a limit lifts, from the words that report it — Claude Code once
 *  wrote it as `usage limit reached|<seconds>`. */
export function limitResetsAt(text: string | undefined): number | undefined {
  const at = text?.match(/limit reached\|(\d{10})\b/i)?.[1];
  return at ? Number(at) * 1000 : undefined;
}

/** Where the harnesses' API is, for the probe: `ANTHROPIC_BASE_URL` points
 *  it elsewhere, as it does the CLI. */
function apiHost(): { host: string; port: number } {
  try {
    const url = new URL(process.env["ANTHROPIC_BASE_URL"] || "https://api.anthropic.com");
    return { host: url.hostname, port: Number(url.port) || (url.protocol === "http:" ? 80 : 443) };
  } catch {
    return { host: "api.anthropic.com", port: 443 };
  }
}

/** Whether the API can be reached from here: a TCP handshake with its host,
 *  and nothing sent. */
export function reachable(timeoutMs = 5_000): Promise<boolean> {
  const { host, port } = apiHost();
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Waits on the connection for whoever needs it back: a probe every few
 * seconds while anyone is waiting and none otherwise, and everyone told at
 * once when it answers.
 */
export class ConnectionWatch {
  private readonly waiting = new Map<string, () => void>();
  private timer: NodeJS.Timeout | undefined;
  private probing = false;

  constructor(
    private readonly probe: () => Promise<boolean> = () => reachable(),
    private readonly everyMs = 10_000,
  ) {}

  /** `then` runs once the API answers again. A second wait under the same
   *  key replaces the first. */
  whenBack(key: string, then: () => void): void {
    this.waiting.set(key, then);
    // the first look is soon: the line may already be back
    this.schedule(1_000);
  }

  cancel(key: string): void {
    this.waiting.delete(key);
    if (this.waiting.size === 0 && this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule(ms: number): void {
    if (this.timer || this.probing) return;
    this.timer = setTimeout(() => void this.look(), ms);
    this.timer.unref();
  }

  private async look(): Promise<void> {
    this.timer = undefined;
    this.probing = true;
    const back = await this.probe().catch(() => false);
    this.probing = false;
    if (back) {
      const all = [...this.waiting.values()];
      this.waiting.clear();
      for (const then of all) {
        try {
          then();
        } catch (err) {
          warn("server", err, "connection back");
        }
      }
    }
    if (this.waiting.size > 0) this.schedule(this.everyMs);
  }
}
