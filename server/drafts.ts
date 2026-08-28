import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ComposerDraftState, DraftAttachment } from "../shared/protocol.js";

/**
 * Unsent composer prompts, one per channel, held between launches — the text
 * and the attachments clipped to it.
 *
 * Their own file rather than the session archive: Home's archive is wiped
 * every launch by design, and a rewind truncates a session's — neither
 * should cost you a half-written thought. The attachment bytes live in the
 * uploads directory like any other attachment, so a draft only carries the
 * same small metadata a sent prompt does.
 */

function draftsFile(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "drafts.json",
  );
}

const WRITE_DELAY_MS = 400;

export class DraftStore {
  private readonly drafts = new Map<string, ComposerDraftState>();
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(draftsFile(), "utf8")) as Record<string, unknown>;
      for (const [channelId, saved] of Object.entries(raw)) {
        // drafts were text alone before attachments could be parked
        const draft: ComposerDraftState | undefined =
          typeof saved === "string"
            ? { text: saved }
            : saved && typeof saved === "object"
              ? {
                  text: typeof (saved as ComposerDraftState).text === "string"
                    ? (saved as ComposerDraftState).text
                    : "",
                  ...(Array.isArray((saved as ComposerDraftState).attachments)
                    ? { attachments: (saved as ComposerDraftState).attachments }
                    : {}),
                }
              : undefined;
        if (draft && (draft.text.trim() || draft.attachments?.length)) {
          this.drafts.set(channelId, draft);
        }
      }
    } catch {
      // first run, or a file worth starting over from
    }
  }

  /** What a channel is holding, if anything. */
  get(channelId: string): ComposerDraftState | undefined {
    return this.drafts.get(channelId);
  }

  /** Hold a channel's unsent prompt; nothing left to keep drops it. */
  set(channelId: string, text: string, attachments: DraftAttachment[] | undefined): void {
    if (text.trim() || attachments?.length) {
      this.drafts.set(channelId, { text, ...(attachments?.length ? { attachments } : {}) });
    } else if (!this.drafts.delete(channelId)) {
      return;
    }
    this.scheduleWrite();
  }

  /** Every channel's draft, for the snapshot a fresh client gets. */
  all(): Record<string, ComposerDraftState> {
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
