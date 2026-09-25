import { memo, useId, useState } from "react";
import type { Project, TranscriptEvent } from "../../../shared/protocol";
import { Markdown } from "../markdown";
import { send } from "../store";
import { ToolImage, TranscriptAttachments } from "./Attachments";
import { DiffView } from "./Diff";
import { AgentCard } from "./chat/AgentCard";
import { Icon, toolIcon } from "./chat/Icon";

/* ── transcript events ───────────────────────────────────────────── */

/** Collapse absolute in-project paths to "name/relative" at render time —
 *  the server shortens new events, but archived ones predate that, and this
 *  keeps every chip short regardless of when it was written. */
function shortenDisplay(text: string, project?: Project): string {
  const root = project?.path.replace(/\/+$/, "");
  if (!root || !project) return text;
  return text.split(`${root}/`).join(`${project.name}/`).split(root).join(project.name);
}

/** A sent slash command ("/compact", "/clear", …) — one short line, nothing
 *  but the command and its arguments. */
function isCommand(text: string): boolean {
  const t = text.trim();
  return t.length <= 80 && !t.includes("\n") && /^\/[a-z0-9_:-]+(\s|$)/i.test(t);
}

/**
 * A uniform zigzag rule — the compaction separator's tear line. Weighted to
 * read as the same hairline as the result lines' rule: 1px there is crisp,
 * but a diagonal of the same width gets spread across ~1.4 device pixels by
 * antialiasing, so the stroke is nudged up to land at the same density.
 */
function ZigzagRule() {
  const id = useId();
  return (
    <svg className="jag" aria-hidden>
      <defs>
        <pattern id={id} width="12" height="9" patternUnits="userSpaceOnUse">
          <path
            d="M0 7 L6 2 L12 7"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.15"
            strokeLinejoin="round"
          />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${id})`} />
    </svg>
  );
}

/**
 * The compaction point: everything above went into a fresh session as a
 * brief only the model reads. The user just sees the zigzag line — the
 * label unfolds the prompt/reply notes the model was handed.
 */
export function CompactionMark({
  event,
  load,
}: {
  event: Extract<TranscriptEvent, { kind: "compaction" }>;
  /** For a mark known only from the history's outline, which leaves out
   *  its brief: fetch the history the brief is in. */
  load?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const bodiless = !event.entries?.length && !event.text;
  return (
    <div className="compaction">
      <div className="compaction-line">
        <ZigzagRule />
        <button
          className="compaction-label"
          title={open ? "Hide what the model was handed" : "Show what the model was handed"}
          onClick={() => {
            if (!open && bodiless) load?.();
            setOpen(!open);
          }}
        >
          <svg
            className="icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="6" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12" />
          </svg>
          compacted
        </button>
        <ZigzagRule />
      </div>
      {/* no scroll gate on the brief (lib/scrollGate.ts): it is opened on
          purpose, to be read, so the wheel is its own the moment it's there */}
      {open &&
        (event.entries?.length || event.digest ? (
          <div className="compaction-brief">
            {/* the oldest exchanges, condensed together — a long chat's
                list stops at its newest few (server/compaction.ts) */}
            {event.digest && (
              <div className="compaction-turn compaction-digest">
                <span className="compaction-n">
                  {event.digest.through > 0 ? `1–${event.digest.through}` : "…"}
                </span>
                <div className="compaction-pair">
                  <div className="compaction-condensed">{event.digest.text}</div>
                </div>
              </div>
            )}
            {(event.entries ?? []).map((entry, i) => (
              <div className="compaction-turn" key={entry.n ?? i}>
                <span className="compaction-n">{entry.n ?? i + 1}</span>
                <div className="compaction-pair">
                  <div className="compaction-you">{entry.user}</div>
                  <div className="compaction-reply">{entry.reply}</div>
                </div>
              </div>
            ))}
          </div>
        ) : bodiless ? (
          <div className="compaction-brief raw">loading…</div>
        ) : (
          // compactions from before the structured entries: the raw brief
          <pre className="compaction-brief raw">{event.text}</pre>
        ))}
    </div>
  );
}

function PlanEvent({ event }: { event: Extract<TranscriptEvent, { kind: "plan" }> }) {
  if (event.removed) {
    return <div className="plan-event removed">plan cleared</div>;
  }
  return (
    <div className="plan-event">
      <div className="plan-event-head">
        <Icon d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11" />
        Plan
      </div>
      {event.explanation && <div className="plan-event-explanation">{event.explanation}</div>}
      {event.entries && event.entries.length > 0 && (
        <div className="plan-event-entries">
          {event.entries.map((entry, index) => (
            <div className={`plan-event-entry ${entry.status}`} key={`${index}-${entry.content}`}>
              <span className="plan-event-mark" aria-hidden>
                {entry.status === "completed" ? "✓" : entry.status === "in_progress" ? "→" : "·"}
              </span>
              <span>{entry.content}</span>
            </div>
          ))}
        </div>
      )}
      {event.markdown && <Markdown text={event.markdown} />}
      {event.uri && <span className="plan-event-uri">{event.uri}</span>}
    </div>
  );
}

/**
 * One transcript event. Memoised: an event never changes once it's written,
 * so a re-render of the pane — a delta arriving, older turns filling in
 * behind you, a status flipping — re-renders none of the ones already on
 * screen.
 */
export const EventView = memo(function EventView({
  event,
  project,
  channelId,
  onRewind,
  onFork,
}: {
  event: TranscriptEvent;
  project?: Project;
  channelId?: string;
  /** Present when this prompt can be rewound to — renders the pencil. */
  onRewind?: (event: Extract<TranscriptEvent, { kind: "user" }>) => void;
  /** Present when the conversation can be forked here — renders the branch. */
  onFork?: (event: Extract<TranscriptEvent, { kind: "user" }>) => void;
}) {
  switch (event.kind) {
    case "user":
      if (isCommand(event.text) && !event.attachments?.length) {
        return (
          <button
            className="msg command-chip"
            title="A command you ran — click to clear it from the transcript"
            onClick={() => {
              if (channelId) send({ type: "remove_event", projectId: channelId, eventId: event.id });
            }}
          >
            {event.text.trim()}
          </button>
        );
      }
      return (
        <div className={`msg user${event.from ? " letter" : ""}`}>
          {/* another agent's message, not the user's — or an answer to one
              this chat sent (server/talk.ts) */}
          {event.from && (
            <div className="letter-from">
              {event.from.answer ? "answer from" : "message from"}{" "}
              <b>
                {event.from.project}
                {event.from.title ? ` · ${event.from.title}` : ""}
              </b>
              {/* it stopped the turn that was running to be read now */}
              {event.from.cutIn && " · cut in"}
            </div>
          )}
          {onRewind && (
            <button
              className="icon-button rewind-pencil"
              title="Rewind here — the conversation returns to just before this prompt, and the prompt comes back to the composer"
              onClick={() => onRewind(event)}
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
          {onFork && (
            <button
              className="icon-button fork-branch"
              title="Fork here — a new chat in this project that starts from this exchange and goes its own way; this one is left exactly as it is"
              onClick={() => onFork(event)}
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
                <circle cx="6" cy="4" r="2.5" />
                <circle cx="6" cy="20" r="2.5" />
                <circle cx="18" cy="8" r="2.5" />
                <path d="M6 6.5v11M18 10.5c0 4-3 5-6 5.5-2.5.4-5 1-6 2" />
              </svg>
            </button>
          )}
          <Markdown text={event.text} attachments={event.attachments} />
          {event.attachments && event.attachments.length > 0 && (
            <TranscriptAttachments attachments={event.attachments} />
          )}
        </div>
      );
    case "assistant":
      return (
        <div className="msg assistant">
          <Markdown text={event.text} />
        </div>
      );
    case "tool": {
      if (event.agent) return <AgentCard agent={event.agent} channelId={channelId} />;
      // The question itself is the card that asked it — a chip repeating the
      // questions above it says nothing the user has not just answered. The
      // event stays in the archive, so a compaction still carries the ask.
      if (event.name === "AskUserQuestion") return null;
      const summary = shortenDisplay(event.summary, project);
      const chip = (
        <div className="tool-chip" title={summary}>
          <Icon d={toolIcon(event.name)} />
          <span className="tool-name">{event.name}</span>
          <span className="tool-summary">{summary}</span>
        </div>
      );
      if (!event.image && !event.diff) return chip;
      // A patch already carries its file's name and path, in its own head and
      // along its own bottom — a chip above it would say both a second time,
      // so the diff stands on its own.
      if (event.diff && !event.image) return <DiffView diff={event.diff} />;
      // what the tool read rides under its own chip, so the path and the
      // thing it names read as one event
      return (
        <div className="tool-block">
          {chip}
          {event.image && <ToolImage image={event.image} />}
          {event.diff && <DiffView diff={event.diff} />}
        </div>
      );
    }
    case "plan":
      return <PlanEvent event={event} />;
    case "result": {
      // the CLI reports a user abort as diagnostic soup — archived events
      // predating the server-side flag still deserve the plain reading
      const stopped = event.stopped || (event.error?.includes("[ede_diagnostic]") ?? false);
      if (stopped) {
        return (
          <div className="result-line stopped">
            <span className="result-rule" />
            <span className="result-text">
              you stopped this response
              {event.costUsd !== undefined && ` · $${event.costUsd.toFixed(4)}`}
              {event.durationMs !== undefined && ` · ${(event.durationMs / 1000).toFixed(1)}s`}
            </span>
            <span className="result-rule" />
          </div>
        );
      }
      return event.ok ? (
        <div className="result-line ok">
          <span className="result-rule" />
          <span className="result-text">
            <Icon d="M20 6L9 17l-5-5" />
            done
            {event.costUsd !== undefined && ` · $${event.costUsd.toFixed(4)}`}
            {event.durationMs !== undefined && ` · ${(event.durationMs / 1000).toFixed(1)}s`}
          </span>
          <span className="result-rule" />
        </div>
      ) : (
        <div className="result-line err">
          <span className="result-rule" />
          <span className="result-text">
            <Icon d="M18 6L6 18M6 6l12 12" />
            {event.error ?? "error"}
          </span>
          <span className="result-rule" />
        </div>
      );
    }
    case "info":
      return <div className="info-line">{event.text}</div>;
    case "compaction":
      return <CompactionMark event={event} />;
  }
});
