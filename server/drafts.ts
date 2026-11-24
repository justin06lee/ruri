import * as fs from "node:fs";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import type { ComposerDraftState, DraftAttachment } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";

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
  return configPath("drafts.json");
}

const WRITE_DELAY_MS = 400;

export class DraftStore {
  private readonly drafts = new Map<string, ComposerDraftState>();
  /** Where it lives, fixed when it is made: a write a moment after a
   *  change goes where the store was read from, whatever the config
   *  folder is by then (a test that set its own and put it back). */
  private readonly file = draftsFile();
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Record<string, unknown>;
      for (const [channelId, saved] of Object.entries(raw)) {
        // drafts were text alone before attachments could be parked
        const draft: ComposerDraftState | undefined =
          typeof saved === "string"
            ? { text: saved }
            : saved && typeof saved === "object"
              ? {
                  text:
                    typeof (saved as ComposerDraftState).text === "string"
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
    } catch (err) {
      if (!isMissing(err)) warn("drafts", err, "new DraftStore");
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
        writeJsonAtomic(this.file, this.all(), 2);
      } catch (err) {
        warn("drafts", err, "scheduleWrite");
        // persistence is best-effort; in-memory state stays correct
      }
    }, WRITE_DELAY_MS);
  }
}

/* ── the box's files, the same on every device ───────────────────── */

/** Whether two lists hold the same files, numbered and marked the same —
 *  in any order: each window keeps its own, and telling one of another's
 *  order would have the two correct each other for ever. */
export function sameFiles(a: readonly DraftAttachment[], b: readonly DraftAttachment[]): boolean {
  if (a.length !== b.length) return false;
  const read = (att: DraftAttachment) => JSON.stringify([att.n, att.regions ?? []]);
  const held = new Map(a.map((att) => [att.id, read(att)]));
  return b.every((att) => held.get(att.id) === read(att));
}

/** How long a file one device added is safe from a list that leaves it
 *  out: long enough for the news of it to reach every window. */
const FRESH_MS = 3_000;

/**
 * Files added to a box a moment ago, and by whom. A window saves its box
 * whole, so a save already on its way when another device (the phone,
 * another window) added a file says nothing of that file — which reads as
 * the file taken out. For a few seconds after a file is added, only the
 * one who added it — or one whose own list has since had it, and so has
 * heard — can take it out by leaving it off its list.
 */
export class FreshFiles {
  private readonly added = new Map<string, { at: number; knows: Set<unknown> }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A file was added, by `by` (a window's socket, or anything that names
   *  who: the phone has no socket). */
  note(id: string, by: unknown): void {
    const at = this.now();
    for (const [old, entry] of this.added) if (at - entry.at > FRESH_MS) this.added.delete(old);
    this.added.set(id, { at, knows: new Set([by]) });
  }

  /** `next`, with whatever of `held` it leaves out only because `by`
   *  cannot have heard of it yet. */
  keep(held: readonly DraftAttachment[], next: DraftAttachment[], by: unknown): DraftAttachment[] {
    const at = this.now();
    const listed = new Set(next.map((att) => att.id));
    // whoever lists a file has heard of it
    for (const id of listed) this.added.get(id)?.knows.add(by);
    const unheard = held.filter((att) => {
      if (listed.has(att.id)) return false;
      const entry = this.added.get(att.id);
      return entry !== undefined && !entry.knows.has(by) && at - entry.at <= FRESH_MS;
    });
    return unheard.length ? [...next, ...unheard] : next;
  }
}

/** The one list of fresh files: the window's handler and the phone's
 *  routes both write a chat's box. */
export const freshFiles = new FreshFiles();
