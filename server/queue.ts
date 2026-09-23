/**
 * The app-side prompt queue: everything waiting for the running turn to
 * finish. Visible entries are user prompts sent while busy (shown and
 * editable in the UI); silent entries are split sub-prompts riding under
 * the original prompt the user already sees.
 */
import type {
  Attachment,
  AttachmentUpload,
  LetterFrom,
  QueueHold,
  QueuedPrompt,
  ServerMessage,
} from "../shared/protocol.js";
import { seatName } from "./talk.js";

export interface QueueEntry {
  id: string;
  text: string;
  uploads: AttachmentUpload[];
  silent: boolean;
  /** Stored attachment meta, for displaying visible entries. */
  attachments?: Attachment[];
  /** A scissors send waiting its turn: split when it reaches the front,
   *  not before, so the commands queued ahead of it have already run. */
  split?: boolean;
  /** Being rewritten in the composer. It keeps its place in the queue's
   *  list (at the end, so the UI shows it under the ones still in line)
   *  but nothing sends it until the rewrite comes back. */
  editing?: boolean;
  /** The prompts that were ahead of it when the rewrite began: when it
   *  steps back in, it goes behind whichever of these are still waiting,
   *  and to the front if none are. */
  editAfter?: string[];
  /** Two prompts folded into this one, kept as they were so the fold can
   *  be taken back: `into` is the one it was dropped on, whose place and id
   *  this took, and `from` the one carried there, which goes back behind
   *  whichever of `fromAfter` are still waiting (to the front if none). */
  combined?: { into: QueueEntry; from: QueueEntry; fromAfter: string[] };
  /** A message from another agent (server/talk.ts), not the user's. */
  from?: LetterFrom;
}

export class SendQueues {
  /** Each channel's queue, in the order it goes out. */
  readonly entries = new Map<string, QueueEntry[]>();
  /**
   * Channels whose queue is standing by, and why. Stopping a turn is a
   * change of mind about *that answer*, not about the prompts waiting
   * behind it — so the queue survives the stop and simply stops moving.
   * A turn that fell to a dropped connection or a usage limit holds it
   * too: every prompt behind it would meet the same wall, one after
   * another. It moves again when the next prompt goes out (it follows that
   * turn, the way it would have followed the one that ended) or when the
   * queue is sent on by hand.
   */
  readonly held = new Map<string, QueueHold>();
  // Bumped on interrupt so an in-flight split resolution knows to stand down.
  readonly epochs = new Map<string, number>();
  /** Channels whose running turn a prompt has stopped to cut in: the held
   *  queue goes — that prompt at its head — the moment the turn is over. */
  readonly cutIn = new Set<string>();

  constructor(private readonly broadcast: (message: ServerMessage) => void) {}

  visibleQueue(channelId: string): QueuedPrompt[] {
    return (this.entries.get(channelId) ?? [])
      .filter((entry) => !entry.silent)
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
        ...(entry.editing ? { editing: true as const } : {}),
        ...(entry.from ? { from: seatName(entry.from.project, entry.from.title) } : {}),
      }));
  }

  /** What is actually in line to go out — not the one being rewritten. */
  pending(channelId: string): number {
    return (this.entries.get(channelId) ?? []).filter((entry) => !entry.editing).length;
  }

  /**
   * A prompt that left the line for a rewrite steps back in — as `entries`
   * (the rewrite may have brought commands of its own, which go ahead of it)
   * — behind whichever prompts that were ahead of it are still waiting, and
   * at the front when none are. The front is behind a split's silent
   * remainder, which is the running answer's own and not a place in line.
   */
  placeBack(channelId: string, entry: QueueEntry, entries: QueueEntry[]): void {
    const queue = (this.entries.get(channelId) ?? []).filter((e) => e !== entry);
    const anchors = new Set(entry.editAfter ?? []);
    let after = -1;
    queue.forEach((e, i) => {
      if (anchors.has(e.id)) after = i;
    });
    if (after >= 0) queue.splice(after + 1, 0, ...entries);
    else {
      const front = queue.findIndex((e) => !e.silent);
      queue.splice(front === -1 ? queue.length : front, 0, ...entries);
    }
    if (queue.length > 0) this.entries.set(channelId, queue);
    else {
      this.entries.delete(channelId);
      this.held.delete(channelId);
    }
  }

  broadcastQueue(channelId: string): void {
    this.broadcast({
      type: "queued",
      projectId: channelId,
      items: this.visibleQueue(channelId),
      ...(this.held.has(channelId) ? { held: this.held.get(channelId) } : {}),
    });
  }

  /** Everything queued stops where it is. Nothing is thrown away. */
  holdQueue(channelId: string, hold: QueueHold = { by: "stop" }): void {
    const queue = this.entries.get(channelId) ?? [];
    // A split's silent sub-prompts are the stopped answer's own remainder,
    // not prompts the user is waiting on — stopping means stopping them.
    // A turn the connection or the limit cut short is no change of mind:
    // the rest of that prompt is still wanted, and waits in the open with
    // the others, where it can be seen and sent.
    const kept =
      hold.by === "stop"
        ? queue.filter((entry) => !entry.silent)
        : queue.map((entry) => (entry.silent ? { ...entry, silent: false } : entry));
    if (kept.length > 0) {
      this.entries.set(channelId, kept);
      this.held.set(channelId, hold);
    } else {
      this.entries.delete(channelId);
      this.held.delete(channelId);
    }
    this.broadcastQueue(channelId);
  }

  /** A queue held for the connection hears that it is back. It still
   *  waits for the user: they are the one who knows whether what is
   *  queued still stands. */
  connectionBack(channelId: string): void {
    if (this.held.get(channelId)?.by !== "network") return;
    this.held.set(channelId, { by: "network", back: true });
    this.broadcastQueue(channelId);
  }

  /** The queue moves again. Returns whether it had been standing by. */
  releaseQueue(channelId: string): boolean {
    if (!this.held.delete(channelId)) return false;
    this.broadcastQueue(channelId);
    return true;
  }

  /** Put a prompt at the back of the line. */
  push(channelId: string, entry: QueueEntry): void {
    const queue = this.entries.get(channelId) ?? [];
    queue.push(entry);
    this.entries.set(channelId, queue);
  }

  forgetChannel(channelId: string): void {
    this.entries.delete(channelId);
    this.held.delete(channelId);
    this.epochs.delete(channelId);
    this.cutIn.delete(channelId);
  }
}

/** The queue with its visible entries in a new order. The silent ones (a
 *  split's remainder) keep their slots: they are the running answer's,
 *  not places in line. */
export function reslot(queue: QueueEntry[], visible: QueueEntry[]): QueueEntry[] {
  let i = 0;
  return queue.map((entry) => (entry.silent ? entry : visible[i++]!));
}

/**
 * Two queued prompts as one: `first`'s text, a blank line, `second`'s,
 * under `second`'s id. `second`'s attachments and the markers that name
 * them are renumbered past `first`'s, so "[image #1]" in each half still
 * means the picture it meant.
 */
export function mergeEntries(first: QueueEntry, second: QueueEntry): QueueEntry {
  const offset = { image: 0, video: 0, file: 0, region: 0 };
  for (const upload of first.uploads) {
    offset[upload.kind] = Math.max(offset[upload.kind], upload.n);
    for (const region of upload.regions ?? []) offset.region = Math.max(offset.region, region.n);
  }
  const shift = (kind: keyof typeof offset, n: number) => n + offset[kind];
  const text = second.text.replace(
    /\[(image|video|file|region)\s#(\d+)\]/g,
    (_, kind: keyof typeof offset, n: string) => `[${kind} #${shift(kind, Number(n))}]`,
  );
  const uploads = second.uploads.map((upload) => ({
    ...upload,
    n: shift(upload.kind, upload.n),
    ...(upload.regions
      ? { regions: upload.regions.map((region) => ({ ...region, n: shift("region", region.n) })) }
      : {}),
  }));
  const attachments = [
    ...(first.attachments ?? []),
    ...(second.attachments ?? []).map((att) => ({
      ...att,
      n: shift(att.kind, att.n),
      ...(att.regions
        ? { regions: att.regions.map((region) => ({ ...region, n: shift("region", region.n) })) }
        : {}),
    })),
  ];
  return {
    id: second.id,
    text: [first.text, text].filter((part) => part.trim()).join("\n\n"),
    uploads: [...first.uploads, ...uploads],
    silent: false,
    ...(attachments.length ? { attachments } : {}),
    ...(first.split || second.split ? { split: true } : {}),
  };
}

/**
 * The queue with `fromId` carried onto `intoId` and folded into it — or
 * null when either is not a prompt in line. The words go in the order the
 * two stood in the line, whichever was carried: the one nearer the front
 * reads first, the way it would have gone out first. The fold takes the
 * place of the one it was dropped on, and keeps both halves as they were
 * so `uncombine` can take it back.
 */
export function combine(queue: QueueEntry[], fromId: string, intoId: string): QueueEntry[] | null {
  if (fromId === intoId) return null;
  const inLine = (e: QueueEntry) => !e.silent && !e.editing;
  const from = queue.find((e) => e.id === fromId && inLine(e));
  const into = queue.find((e) => e.id === intoId && inLine(e));
  if (!from || !into) return null;
  // a message from another agent keeps its own place: it is not the
  // user's to fold into theirs, and its sender is waiting on that one
  if (from.from || into.from) return null;
  const [first, second] = queue.indexOf(from) < queue.indexOf(into) ? [from, into] : [into, from];
  const merged: QueueEntry = {
    ...mergeEntries(first, second),
    id: into.id,
    combined: {
      into,
      from,
      fromAfter: queue
        .slice(0, queue.indexOf(from))
        .filter((e) => inLine(e))
        .map((e) => e.id),
    },
  };
  return queue.filter((e) => e !== from).map((e) => (e === into ? merged : e));
}

/**
 * A fold taken back: the prompt dropped on back in the fold's place, the
 * one carried back where it had been — or null when `id` is not a fold
 * still waiting in line (it went out, or was rewritten meanwhile).
 */
export function uncombine(queue: QueueEntry[], id: string): QueueEntry[] | null {
  const merged = queue.find((e) => e.id === id && !e.silent && !e.editing);
  const parts = merged?.combined;
  if (!merged || !parts) return null;
  const next = queue.map((e) => (e === merged ? parts.into : e));
  const anchors = new Set(parts.fromAfter);
  let after = -1;
  next.forEach((e, i) => {
    if (anchors.has(e.id)) after = i;
  });
  if (after >= 0) next.splice(after + 1, 0, parts.from);
  else {
    const front = next.findIndex((e) => !e.silent);
    next.splice(front === -1 ? next.length : front, 0, parts.from);
  }
  return next;
}
