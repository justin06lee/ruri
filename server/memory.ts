/**
 * A project's working memory read in from its chats — every finished turn
 * of every chat that hasn't been folded yet (server/memoryQueue.ts).
 *
 * The memory usually takes each turn in as it finishes. That is no help
 * to a project that already has months of chats in it: none of what they
 * found out is in the memory until somebody runs into it again. This is
 * the other door, which the page's "Read the chats" opens and a project
 * with history and no memory opens by itself: the chats' turns, oldest
 * first, through the same folds as a turn just finished — chunked, read
 * with what each changed, and applied as changes through the log, so
 * nothing already in the memory is written over.
 */
import type { ServerContext } from "./context.js";
import { backfillFolds } from "./memoryQueue.js";
import { smallModelEnabled } from "./smallmodel.js";

function recallNote(ctx: ServerContext, projectId: string, busy: boolean, note?: string): void {
  ctx.clients.broadcast({ type: "recall", projectId, busy, ...(note ? { note } : {}) });
}

/** Fold every turn of the project's chats not yet in its memory. */
export function rebuildMemory(ctx: ServerContext, projectId: string): void {
  if (!ctx.store.get(projectId) || !smallModelEnabled()) return;
  const queued = backfillFolds(ctx, projectId);
  if (queued === 0) {
    const waiting = ctx.folds.queue(projectId).pending.length;
    recallNote(
      ctx,
      projectId,
      waiting > 0,
      waiting > 0 ? `${waiting} exchanges waiting to be folded in…` : "every exchange is already folded in",
    );
  }
}
