import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Unsent composer prompts, one per channel, held between launches.
 *
 * Their own file rather than the session archive: Home's archive is wiped
 * every launch by design, and a rewind truncates a session's — neither
 * should cost you a half-written thought. Text only; an attachment is a live
 * browser File that nothing server-side can hold on its behalf.
 */

function draftsFile(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "drafts.json",
  );
}

const WRITE_DELAY_MS = 400;

export class DraftStore {
  private readonly drafts = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(draftsFile(), "utf8")) as Record<string, unknown>;
      for (const [channelId, text] of Object.entries(raw)) {
        if (typeof text === "string" && text.trim()) this.drafts.set(channelId, text);
      }
    } catch {
      // first run, or a file worth starting over from
    }
  }

  /** Hold a channel's unsent prompt; empty text drops it. */
  set(channelId: string, text: string): void {
    if (text.trim()) this.drafts.set(channelId, text);
    else if (!this.drafts.delete(channelId)) return;
    this.scheduleWrite();
  }

  /** Every channel's draft, for the snapshot a fresh client gets. */
  all(): Record<string, string> {
    return Object.fromEntries(this.drafts);
  }

  /** The session is gone — so is anything typed at it. */
  remove(channelId: string): void {
    if (this.drafts.delete(channelId)) this.scheduleWrite();
  }

  private scheduleWrite(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        fs.mkdirSync(path.dirname(draftsFile()), { recursive: true });
        fs.writeFileSync(draftsFile(), JSON.stringify(this.all(), null, 2));
      } catch {
        // persistence is best-effort; in-memory state stays correct
      }
    }, WRITE_DELAY_MS);
  }
}
