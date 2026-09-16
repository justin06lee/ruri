import type { EarlierItem, QueuedPrompt, TranscriptEvent, TurnNote } from "../../../../shared/protocol";

// Stable fallback so selectors never mint a fresh reference per read —
// an unstable snapshot makes useSyncExternalStore loop (React error #185).
export const NO_EVENTS: TranscriptEvent[] = [];
export const NO_SUMMARIES: Record<string, TurnNote> = {};
export const NO_EARLIER: EarlierItem[] = [];
export const NO_QUEUED: QueuedPrompt[] = [];
