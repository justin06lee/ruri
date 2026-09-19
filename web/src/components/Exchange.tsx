import { memo, type ReactNode } from "react";
import {
  excerpt,
  unmarked,
  type Project,
  type TranscriptEvent,
  type TurnNote,
} from "../../../shared/protocol";
import { EventView } from "./EventView";
import { Icon } from "./chat/Icon";

export interface Turn {
  /** The opening user-event id, or "pre" for events before any prompt. */
  turnId: string;
  events: TranscriptEvent[];
  /** A compaction mark stands alone — it never folds or hosts other events. */
  solo?: boolean;
}

/** Group the flat event stream into prompt→result turns. */
export function groupTurns(events: TranscriptEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    const last = turns[turns.length - 1];
    if (event.kind === "compaction") {
      turns.push({ turnId: `compaction-${event.id}`, events: [event], solo: true });
    } else if (event.kind === "user" || !last || last.solo) {
      turns.push({ turnId: event.kind === "user" ? event.id : `pre-${event.id}`, events: [event] });
    } else {
      last.events.push(event);
    }
  }
  return turns;
}

/** How much of a prompt, and of a reply's last message, stands in for a
 *  note not written yet — the server cuts the history's outline the same. */
const PROMPT_EXCERPT = 220;
const REPLY_EXCERPT = 240;

/** A live turn's stand-ins for its notes: its prompt, and its last reply. */
export function turnExcerpts(turn: Turn): { prompt: string; reply: string } {
  const head = turn.events[0];
  let reply = "";
  for (let i = turn.events.length - 1; i > 0 && !reply; i--) {
    const event = turn.events[i]!;
    if (event.kind === "assistant" && event.text.trim()) reply = event.text;
  }
  return {
    prompt: excerpt(head?.kind === "user" ? head.text : "", PROMPT_EXCERPT),
    reply: excerpt(unmarked(reply), REPLY_EXCERPT),
  };
}

/** A turn shown whole needs no stand-ins. */
export const NO_EXCERPTS = { prompt: "", reply: "" };

/** What a click opens: one half of an exchange, or both. */
export type Half = "prompt" | "reply" | "both";

/** A folded half: its note, standing where the half would. A click (or
 *  Enter) opens that half; dragging across it to copy a line doesn't. */
function NoteHalf({
  className,
  title,
  onOpen,
  children,
}: {
  className: string;
  title: string;
  onOpen(): void;
  children: ReactNode;
}) {
  return (
    <div
      className={className}
      role="button"
      tabIndex={0}
      title={title}
      onClick={(e) => {
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return;
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        onOpen();
      }}
    >
      {children}
    </div>
  );
}

/**
 * An open half, and the way it folds back to its note.
 *
 * A prompt folds on a click on its bubble, at once. Under the pointer the
 * bubble takes the note's dashed edge — the look the click takes it back
 * to — so the click is never a surprise. A click on anything in it that
 * does something of its own (a link, a button, a picture), or a drag that
 * selects text, folds nothing.
 *
 * A reply folds by the rail down its left edge, never by a click on it. A
 * reply is long and full of things that do something of their own — tool
 * chips, patches, links — so "click anywhere" was both easy to do by
 * accident and hard to find a spot for. The rail runs its whole height, to
 * hand wherever in the reply you are, and hovering it dims the reply: what
 * a click would fold, before it does.
 */
function OpenHalf({
  half,
  folds,
  onFold,
  children,
}: {
  half: "prompt" | "reply";
  folds: boolean;
  onFold: () => void;
  children: React.ReactNode;
}) {
  if (half === "reply") {
    return (
      <div className={`exchange-half${folds ? " folds" : ""}`} data-half="reply">
        {folds && (
          <button
            type="button"
            className="half-rail"
            title="Fold the reply back to its note"
            aria-label="Fold the reply back to its note"
            onClick={onFold}
          />
        )}
        {children}
      </div>
    );
  }
  return (
    <div
      className={`exchange-half${folds ? " folds" : ""}`}
      data-half="prompt"
      onClick={
        folds
          ? (e) => {
              const target = e.target as HTMLElement;
              if (!target.closest(".msg")) return;
              if (
                target.closest(
                  "a, button, input, textarea, select, label, summary, img, video, [role='button']",
                )
              )
                return;
              const selection = window.getSelection();
              if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode))
                return;
              onFold();
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

/**
 * One exchange, each half on its own. A half is either shown in full or
 * folded to its recall note, laid out like the chat either way: the
 * prompt's note in a dashed bubble on the right, the reply's under it — a
 * cut of the text itself for a note not written yet. A click on a note
 * opens that half alone, and it folds back the way it came: a prompt by a
 * click on it, a reply by its rail (see OpenHalf). "Full exchange" opens
 * both; the chevron folds the pair back. Every exchange above the newest
 * compaction starts folded, one below it open — and a reply open from the
 * start has no rail, and folds only by the chevron.
 */
export const Exchange = memo(function Exchange({
  turnId,
  events,
  note,
  prompt,
  reply,
  count,
  promptOpen,
  replyOpen,
  replyFolds,
  loading,
  far,
  project,
  channelId,
  onRewind,
  onFork,
  onOpen,
  onFold,
  onFoldHalf,
}: {
  turnId: string;
  /** Its events — absent for an earlier exchange until the history comes. */
  events: TranscriptEvent[] | undefined;
  note: TurnNote | undefined;
  /** Stand-ins for the notes while they're unwritten. */
  prompt: string;
  reply: string;
  count: number;
  promptOpen: boolean;
  replyOpen: boolean;
  /** A click on the open reply folds it: it was opened from its note. */
  replyFolds: boolean;
  /** Opened, and its events still on their way. */
  loading?: boolean;
  far?: boolean;
  project?: Project;
  channelId?: string;
  onRewind?: (event: Extract<TranscriptEvent, { kind: "user" }>) => void;
  onFork?: (event: Extract<TranscriptEvent, { kind: "user" }>) => void;
  onOpen(turnId: string, half: Half): void;
  onFold(turnId: string): void;
  onFoldHalf(turnId: string, half: "prompt" | "reply"): void;
}) {
  const head = promptOpen ? events?.[0] : undefined;
  const rest = replyOpen && events ? events.slice(1) : undefined;
  const folded = !head && !rest;
  const asked = note?.user || prompt || "an exchange";
  const answered = note?.reply || reply;
  const view = (event: TranscriptEvent) => (
    <EventView
      key={event.id}
      event={event}
      project={project}
      channelId={channelId}
      onRewind={onRewind}
      onFork={onFork}
    />
  );
  return (
    <div className={`turn${folded ? " folded" : ""}${far ? " far" : ""}`} data-turn={turnId}>
      {!folded && (
        <button
          className="icon-button turn-fold"
          title="Fold this exchange to its notes"
          onClick={() => onFold(turnId)}
        >
          <Icon d="M6 15l6-6 6 6" />
        </button>
      )}
      {head ? (
        <OpenHalf half="prompt" folds onFold={() => onFoldHalf(turnId, "prompt")}>
          {view(head)}
        </OpenHalf>
      ) : (
        <NoteHalf
          className="msg user note"
          title="Show your whole prompt"
          onOpen={() => onOpen(turnId, "prompt")}
        >
          {asked}
        </NoteHalf>
      )}
      {rest ? (
        <OpenHalf
          half="reply"
          folds={replyFolds && rest.length > 0}
          onFold={() => onFoldHalf(turnId, "reply")}
        >
          {rest.map(view)}
        </OpenHalf>
      ) : answered ? (
        <NoteHalf
          className="msg assistant note"
          title="Show the whole reply"
          onOpen={() => onOpen(turnId, "reply")}
        >
          {answered}
        </NoteHalf>
      ) : null}
      {!(head && rest) && (
        <button
          className="folded-open"
          title="Show the whole exchange"
          onClick={() => onOpen(turnId, "both")}
        >
          <Icon d="M9 6l6 6-6 6" />
          {loading ? "opening…" : `full exchange · ${count} events`}
        </button>
      )}
    </div>
  );
});
