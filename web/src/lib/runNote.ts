import { useEffect, useState } from "react";

/**
 * The last word of something that runs in the background — a sweep, a
 * read of the repo, a read of the chats — and how long it stays up: long
 * enough to read what it did, not long enough to still be there the next
 * time the page is opened and mean nothing.
 */
export const FINAL_NOTE_MS = 25_000;

/**
 * Whether a finished run's last word has been up for `FINAL_NOTE_MS` and
 * should go. `at` is when the run last reported — every report is a new
 * one — so the note is stale only once the timer has run out for the
 * report on screen now; a newer report, or a run under way, is fresh.
 */
export function useNoteStale(at: number | undefined, busy: boolean): boolean {
  const [staleAt, setStaleAt] = useState<number>();
  useEffect(() => {
    if (at === undefined || busy) return;
    const timer = setTimeout(() => setStaleAt(at), FINAL_NOTE_MS);
    return () => clearTimeout(timer);
  }, [at, busy]);
  return !busy && at !== undefined && staleAt === at;
}

/** "just now", "2h ago", "3d ago" — when something was last done. */
export function since(at: number | undefined): string {
  if (!at) return "never";
  const mins = Math.round((Date.now() - at) / 60_000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
