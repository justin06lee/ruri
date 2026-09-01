/**
 * The AskUserQuestion card. This is not a permission — the model is asking
 * you something, so the card asks back instead of offering allow/deny. It
 * rides the permission channel (which already survives reconnects) and is
 * told apart by `request.kind === "question"`.
 *
 * Answers go back as the tool's own input: `answers` is a field of
 * AskUserQuestion's schema, so the tool reads the picks and reports them to
 * the model itself — ruri never has to phrase them.
 *
 * Several questions are one card, not a form: the questions sit side by
 * side on a strip and the card slides between them. Picking an answer to a
 * single-choice question slides on to the next one by itself; the strip is
 * as tall as its tallest question, so nothing jumps as it moves.
 *
 * What you have typed and picked outlives the card: switching to another
 * session unmounts it, and coming back finds the answers — and the question
 * you were on — exactly where you left them. The state lives here, keyed
 * by the request, until the answer goes out.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { AskAnswers, AskQuestion, AskQuestions, PermissionRequest } from "../../../shared/protocol";
import { send } from "../store";

/** What one question's answer looks like while the card is open. */
interface Draft {
  /** Chosen option labels, in the order the user picked them. */
  picked: string[];
  /** Set when "Other" is on — the typed answer replaces the labels. */
  other: string;
  otherOn: boolean;
}

/** A card's answers in progress, kept across unmounts by request id. */
interface Held {
  drafts: Draft[];
  at: number;
}

const held = new Map<string, Held>();

/** How long a picked answer stays on screen before the card moves on. */
const ADVANCE_MS = 260;

function Check({ on, multi }: { on: boolean; multi: boolean }) {
  return (
    <span className={`ask-mark ${multi ? "multi" : "single"} ${on ? "on" : ""}`} aria-hidden>
      {on && (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
          <path d={multi ? "M20 6L9 17l-5-5" : "M12 12h.01"} />
        </svg>
      )}
    </span>
  );
}

function QuestionBlock({
  q,
  draft,
  current,
  onChange,
  onPicked,
}: {
  q: AskQuestion;
  draft: Draft;
  /** Whether this is the question the strip is showing. */
  current: boolean;
  onChange: (next: Draft) => void;
  /** A single-choice answer landed — the card may move on. */
  onPicked: () => void;
}) {
  // The preview belongs to whichever option is "current": the last one
  // picked, so a multi-select shows the thing you just reached for.
  const focused = draft.picked[draft.picked.length - 1];
  const preview = q.options.find((o) => o.label === focused)?.preview;
  const otherRef = useRef<HTMLTextAreaElement>(null);

  const toggle = (label: string) => {
    if (q.multiSelect) {
      const picked = draft.picked.includes(label)
        ? draft.picked.filter((l) => l !== label)
        : [...draft.picked, label];
      onChange({ ...draft, picked, otherOn: draft.otherOn });
    } else {
      onChange({ ...draft, picked: [label], otherOn: false });
      onPicked();
    }
  };

  const toggleOther = () => {
    const otherOn = !draft.otherOn;
    onChange({
      ...draft,
      otherOn,
      // an "Other" answer replaces the options in a single-select;
      // in a multi it just rides alongside them
      picked: q.multiSelect || draft.otherOn ? draft.picked : [],
    });
    // the box takes the caret the moment it opens — but only then, never on
    // a remount, where every open box on the strip would fight for it
    if (otherOn) requestAnimationFrame(() => otherRef.current?.focus());
  };

  return (
    <div className="ask-question" inert={!current}>
      <div className="ask-head">
        {q.header && <span className="ask-chip">{q.header}</span>}
        <span className="ask-prompt">{q.question}</span>
      </div>
      <div className="ask-options">
        {q.options.map((o) => {
          const on = draft.picked.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              className={`ask-option ${on ? "on" : ""}`}
              onClick={() => toggle(o.label)}
            >
              <Check on={on} multi={q.multiSelect} />
              <span className="ask-body">
                <span className="ask-label">{o.label}</span>
                {o.description && <span className="ask-desc">{o.description}</span>}
              </span>
            </button>
          );
        })}
        <button type="button" className={`ask-option ${draft.otherOn ? "on" : ""}`} onClick={toggleOther}>
          <Check on={draft.otherOn} multi={q.multiSelect} />
          <span className="ask-body">
            <span className="ask-label">Other</span>
            <span className="ask-desc">Answer in your own words</span>
          </span>
        </button>
      </div>
      {draft.otherOn && (
        <textarea
          ref={otherRef}
          className="ask-other"
          rows={2}
          placeholder="Your answer…"
          value={draft.other}
          onChange={(e) => onChange({ ...draft, other: e.target.value })}
        />
      )}
      {preview && <pre className="ask-preview">{preview}</pre>}
    </div>
  );
}

/** One question's answer string, or "" while it is still unanswered. */
function answerOf(draft: Draft): string {
  if (draft.otherOn) {
    const typed = draft.other.trim();
    if (!typed) return "";
    return draft.picked.length > 0 ? [...draft.picked, typed].join(", ") : typed;
  }
  return draft.picked.join(", ");
}

export function QuestionCard({ request }: { request: PermissionRequest }) {
  const questions = (request.input as AskQuestions).questions;
  const [state, setState] = useState<Held>(
    () =>
      held.get(request.requestId) ?? {
        drafts: questions.map(() => ({ picked: [], other: "", otherOn: false })),
        at: 0,
      },
  );
  // every change is written through, so an unmount loses nothing
  useEffect(() => {
    held.set(request.requestId, state);
  }, [request.requestId, state]);

  const { drafts, at } = state;
  const answered = useMemo(() => drafts.every((d) => answerOf(d) !== ""), [drafts]);
  const many = questions.length > 1;
  const last = questions.length - 1;
  const go = (to: number) => setState((s) => ({ ...s, at: Math.max(0, Math.min(last, to)) }));

  // The move-on after a pick is a beat later, so the mark is seen landing
  // before the question slides away; a card that unmounts first drops it.
  const advance = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (advance.current) clearTimeout(advance.current);
  }, []);
  const picked = (index: number) => {
    if (index >= last) return;
    if (advance.current) clearTimeout(advance.current);
    advance.current = setTimeout(() => {
      advance.current = null;
      go(index + 1);
    }, ADVANCE_MS);
  };

  const finish = (answers?: AskAnswers) => {
    held.delete(request.requestId);
    send({ type: "question_response", requestId: request.requestId, ...(answers ? { answers } : {}) });
  };

  const submit = () => {
    const answers: AskAnswers["answers"] = {};
    const annotations: NonNullable<AskAnswers["annotations"]> = {};
    questions.forEach((q, i) => {
      const draft = drafts[i]!;
      answers[q.question] = answerOf(draft);
      // the tool's schema carries the focused option's preview back, so the
      // model sees the mockup it was judged on rather than just a label
      const focused = draft.picked[draft.picked.length - 1];
      const preview = q.options.find((o) => o.label === focused)?.preview;
      if (preview) annotations[q.question] = { preview };
    });
    finish({
      answers,
      ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    });
  };

  return (
    <div className="ask-card">
      <div className="ask-title">
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
          <circle cx="12" cy="12" r="10" />
        </svg>
        {many ? `${questions.length} questions for you` : "A question for you"}
        {many && (
          <span className="ask-pager">
            <button
              type="button"
              className="icon-button"
              title="Previous question"
              disabled={at === 0}
              onClick={() => go(at - 1)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <span className="ask-count">
              {at + 1} / {questions.length}
            </span>
            <button
              type="button"
              className="icon-button"
              title="Next question"
              disabled={at === last}
              onClick={() => go(at + 1)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </span>
        )}
      </div>
      {/* the strip holds every question side by side and slides between
          them; being laid out together is what makes the card as tall as
          the tallest of them, so the move never changes the card's height */}
      <div className="ask-track">
        <div className="ask-strip" style={{ transform: `translateX(-${at * 100}%)` }}>
          {questions.map((q, i) => (
            <div className="ask-slide" key={i}>
              <QuestionBlock
                q={q}
                draft={drafts[i] ?? drafts[0]!}
                current={i === at}
                onChange={(next) =>
                  setState((s) => ({ ...s, drafts: s.drafts.map((cur, j) => (j === i ? next : cur)) }))
                }
                onPicked={() => picked(i)}
              />
            </div>
          ))}
        </div>
      </div>
      <div className="ask-actions">
        {many && (
          <span className="ask-dots">
            {questions.map((q, i) => (
              <button
                key={i}
                type="button"
                className={`ask-dot ${i === at ? "at" : ""} ${answerOf(drafts[i]!) ? "done" : ""}`}
                title={q.header || q.question}
                onClick={() => go(i)}
              />
            ))}
          </span>
        )}
        <button className="primary" disabled={!answered} onClick={submit}>
          {many ? "Send answers" : "Send answer"}
        </button>
        <button className="ghost" title="Let the model carry on without an answer" onClick={() => finish()}>
          Skip
        </button>
      </div>
    </div>
  );
}
