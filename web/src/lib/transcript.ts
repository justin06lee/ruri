/** Merging a transcript the server sent into the one on screen (store.ts). */
import type { TranscriptEvent } from "../../../shared/protocol";

/**
 * A transcript sent again, keeping every event that did not change as the
 * very object already on screen — so a chat that catches up after a while
 * away re-renders only what moved, and not at all when nothing did.
 */
export function reuse(held: TranscriptEvent[] | undefined, next: TranscriptEvent[]): TranscriptEvent[] {
  if (!held || held.length === 0) return next;
  const byId = new Map(held.map((event) => [event.id, event]));
  let same = held.length === next.length;
  const out = next.map((event, i) => {
    const prev = byId.get(event.id);
    const kept = prev && JSON.stringify(prev) === JSON.stringify(event) ? prev : event;
    if (kept !== held[i]) same = false;
    return kept;
  });
  return same ? held : out;
}

/** A newer tail laid over the end of a whole chat held from before: what
 *  it has, replaced; what is new, added. Anything in between arrives when
 *  the chat is opened. */
export function overlay(held: TranscriptEvent[], tail: TranscriptEvent[]): TranscriptEvent[] {
  const fresh = new Map(tail.map((event) => [event.id, event]));
  const out = held.map((event) => fresh.get(event.id) ?? event);
  const have = new Set(held.map((event) => event.id));
  for (const event of tail) if (!have.has(event.id)) out.push(event);
  return out;
}
