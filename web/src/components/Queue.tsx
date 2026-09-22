import { useEffect, useRef, useState } from "react";
import type { QueuedPrompt, QueueHold } from "../../../shared/protocol";
import { composeInto, send } from "../store";
import { TranscriptAttachments } from "./Attachments";
import { MarkerText } from "./Markers";

/** Where a lifted card is about to land: on the edge of another (a place
 *  in line) or on its body (the two become one prompt). */
type DropZone = "before" | "after" | "merge";

/** How long a fold can be taken back from its card. Long enough to notice
 *  a drop that landed on the wrong card; after that it is just a prompt. */
const UNDO_MS = 8000;

interface Lift {
  id: string;
  /** How far the card has been carried from where it sits. */
  dy: number;
  over: { id: string; zone: DropZone } | null;
}

/**
 * A prompt held app-side while a turn runs — nothing reaches the harness
 * until its turn comes. Editable and removable right up to dispatch.
 */
function QueuedCard({
  projectId,
  item,
  held,
  lift,
  onLift,
  onUndo,
}: {
  projectId: string;
  item: QueuedPrompt;
  /** The queue is standing by since a stopped turn — nothing is waiting on
   *  a running answer, it is waiting on you. */
  held?: boolean;
  lift?: Lift | null;
  /** The list's pointer handlers, on every card that can be carried. */
  onLift?: {
    down(e: React.PointerEvent<HTMLDivElement>, id: string): void;
    move(e: React.PointerEvent<HTMLDivElement>): void;
    up(e: React.PointerEvent<HTMLDivElement>): void;
    cancel(): void;
  };
  /** This card is a fold made a moment ago, and this takes it back. */
  onUndo?: () => void;
}) {
  // Editing takes the prompt out of the line and puts it in the composer —
  // the box you wrote it in, with its attachments, not a second one
  // embedded in the card. The others move up meanwhile; sending the
  // rewrite puts it back where it was among whichever are still waiting.
  const edit = () => {
    send({ type: "queue_edit", projectId, itemId: item.id });
    composeInto(projectId, item.text, item.attachments);
  };
  const lifting = lift?.id === item.id;
  const over = lift?.over?.id === item.id ? lift.over.zone : null;
  const carried = Boolean(onLift) && !item.editing;

  return (
    <div
      className={[
        "queued-card",
        held ? "standby" : "",
        item.editing ? "editing" : "",
        carried ? "carried" : "",
        lifting ? "lifting" : "",
        over === "merge"
          ? "merge-into"
          : over === "before"
            ? "drop-before"
            : over === "after"
              ? "drop-after"
              : "",
      ].join(" ")}
      data-queued={item.id}
      data-editing={item.editing ? "1" : undefined}
      style={lifting ? { transform: `translateY(${lift!.dy}px)` } : undefined}
      onPointerDown={carried ? (e) => onLift!.down(e, item.id) : undefined}
      onPointerMove={carried ? onLift!.move : undefined}
      onPointerUp={carried ? onLift!.up : undefined}
      onPointerCancel={carried ? onLift!.cancel : undefined}
    >
      <div className="queued-head">
        <span className="queued-label">
          {item.editing ? "editing — in the composer" : onUndo ? "combined" : held ? "standing by" : "queued"}
        </span>
        {onUndo && (
          <button
            className="queued-undo"
            title="Take the two apart again, back where they were"
            onClick={onUndo}
          >
            undo
          </button>
        )}
        <span className="queued-actions">
          {!item.editing && (
            <button
              className="icon-button"
              title="Edit — takes it out of the line and into the composer; the rest go on without it until it is sent back"
              onClick={edit}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
          )}
          <button
            className="icon-button"
            title="Remove from the queue"
            onClick={() => send({ type: "queue_remove", projectId, itemId: item.id })}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </span>
      </div>
      <div className="queued-text">
        <MarkerText text={item.text} />
      </div>
      {item.attachments && item.attachments.length > 0 && (
        <TranscriptAttachments attachments={item.attachments} />
      )}
    </div>
  );
}

/**
 * The line of queued prompts, and the carrying of them: press a card and
 * move, and it lifts; let it go on the edge of another and it takes that
 * place in line, let it go on the body of another and the two fold into
 * one prompt where it landed — the words in the order the two stood in
 * the line, so the one nearer the front still reads first. For a few
 * seconds the fold wears an undo that takes it apart again. The card
 * being rewritten sits under the line and takes no part.
 */
export function QueuedList({
  projectId,
  items,
  held,
}: {
  projectId: string;
  items: QueuedPrompt[];
  held: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [lift, setLift] = useState<Lift | null>(null);
  /** A press that may become a carry — it does once it has moved a little,
   *  so a click on the card is still a click. */
  const press = useRef<{ id: string; x: number; y: number; live: boolean } | null>(null);
  const movable = items.filter((item) => !item.editing).length > 1;
  /** The fold just made here, while it can still be taken back. */
  const [undoable, setUndoable] = useState<string | null>(null);
  useEffect(() => {
    if (!undoable) return;
    const timer = setTimeout(() => setUndoable(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [undoable]);

  const cards = () =>
    [...(listRef.current?.querySelectorAll<HTMLElement>("[data-queued]") ?? [])].filter(
      (el) => el.dataset["editing"] !== "1",
    );

  /** What the pointer is over, at this height: a card's edge, its body, or
   *  — between cards — the nearest edge. */
  const zoneAt = (id: string, y: number): Lift["over"] => {
    const others = cards().filter((el) => el.dataset["queued"] !== id);
    for (const el of others) {
      const r = el.getBoundingClientRect();
      if (y < r.top || y > r.bottom) continue;
      const edge = Math.min(r.height * 0.3, 22);
      const zone: DropZone = y < r.top + edge ? "before" : y > r.bottom - edge ? "after" : "merge";
      return { id: el.dataset["queued"]!, zone };
    }
    const below = others.find((el) => el.getBoundingClientRect().top > y);
    if (below) return { id: below.dataset["queued"]!, zone: "before" };
    const above = [...others].reverse().find((el) => el.getBoundingClientRect().bottom < y);
    if (above) return { id: above.dataset["queued"]!, zone: "after" };
    return null;
  };

  const onLift = {
    down(e: React.PointerEvent<HTMLDivElement>, id: string) {
      if (e.button !== 0 || !movable) return;
      if ((e.target as Element).closest("button, a, input, textarea, img, video")) return;
      press.current = { id, x: e.clientX, y: e.clientY, live: false };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    move(e: React.PointerEvent<HTMLDivElement>) {
      const p = press.current;
      if (!p) return;
      const dy = e.clientY - p.y;
      if (!p.live) {
        if (Math.hypot(e.clientX - p.x, dy) < 5) return;
        p.live = true;
        window.getSelection()?.removeAllRanges();
      }
      setLift({ id: p.id, dy, over: zoneAt(p.id, e.clientY) });
    },
    up(e: React.PointerEvent<HTMLDivElement>) {
      const p = press.current;
      press.current = null;
      if (!p?.live) return;
      const over = zoneAt(p.id, e.clientY);
      setLift(null);
      if (!over) return;
      if (over.zone === "merge") {
        send({ type: "queue_merge", projectId, itemId: p.id, intoId: over.id });
        setUndoable(over.id);
        return;
      }
      const line = items.filter((item) => !item.editing && item.id !== p.id).map((item) => item.id);
      const at = line.indexOf(over.id);
      const beforeId = over.zone === "before" ? over.id : line[at + 1];
      send({ type: "queue_move", projectId, itemId: p.id, ...(beforeId ? { beforeId } : {}) });
    },
    cancel() {
      press.current = null;
      setLift(null);
    },
  };

  return (
    <div className={`queued-list ${lift ? "lifting" : ""}`} ref={listRef}>
      {items.map((item) => (
        <QueuedCard
          key={item.id}
          projectId={projectId}
          item={item}
          held={held}
          lift={lift}
          onLift={movable ? onLift : undefined}
          {...(undoable === item.id && !item.editing
            ? {
                onUndo: () => {
                  send({ type: "queue_unmerge", projectId, itemId: item.id });
                  setUndoable(null);
                },
              }
            : {})}
        />
      ))}
    </div>
  );
}

/** A time a limit lifts, as the clock on the wall would say it — with the
 *  day when it is not today. */
function whenLifts(at: number): string {
  const date = new Date(at);
  const today = date.toDateString() === new Date().toDateString();
  return date.toLocaleString([], {
    ...(today ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The line under a queue that is standing by: why it is, and a button that
 * sends it on. It never goes by itself — a stop was the user's word, and
 * after a dropped connection or a usage limit they are the one who knows
 * whether what they queued still stands.
 */
export function QueueStandby({
  projectId,
  count,
  hold,
}: {
  projectId: string;
  count: number;
  hold: QueueHold;
}) {
  const resetsAt = hold.by === "limit" ? hold.resetsAt : undefined;
  // the line changes when the limit lifts, whether or not anything else
  // moves: the limit that has lifted, by when it said it would
  const [liftedAt, setLiftedAt] = useState<number>();
  useEffect(() => {
    if (!resetsAt) return;
    const ms = Math.max(0, Math.min(resetsAt - Date.now() + 500, 2 ** 31 - 1));
    const timer = setTimeout(() => setLiftedAt(resetsAt), ms);
    return () => clearTimeout(timer);
  }, [resetsAt]);

  const prompts = count === 1 ? "1 prompt" : `${count} prompts`;
  const them = count === 1 ? "it" : "them";
  const why =
    hold.by === "stop"
      ? `${prompts} held by the stop — ${count === 1 ? "it goes" : "they go"} out after your next one`
      : hold.by === "network"
        ? hold.back
          ? `The connection is back — ${prompts} waiting for you`
          : `The connection dropped — holding ${prompts} until you send ${them}`
        : resetsAt && liftedAt === resetsAt
          ? `The usage limit has reset — ${prompts} waiting for you`
          : `Usage limit reached${resetsAt ? ` until ${whenLifts(resetsAt)}` : ""} — holding ${prompts} until you send ${them}`;
  return (
    <div className={`queue-standby by-${hold.by}`}>
      <span>{why}</span>
      <button
        title="Send what is waiting, now, in the order it was written"
        onClick={() => send({ type: "queue_send", projectId })}
      >
        Send queued
      </button>
    </div>
  );
}
