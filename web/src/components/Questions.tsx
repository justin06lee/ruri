/**
 * The AskUserQuestion card. This is not a permission — the model is asking
 * you something, so the card asks back instead of offering allow/deny. It
 * rides the permission channel (which already survives reconnects) and is
 * told apart by `request.kind === "question"`.
 *
 * Answers go back as the tool's own input: `answers` is a field of
 * AskUserQuestion's schema, so the tool reads the picks and reports them to
 * the model itself — ruri never has to phrase them.
 */

import { useMemo, useState } from "react";
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
  onChange,
}: {
  q: AskQuestion;
  draft: Draft;
  onChange: (next: Draft) => void;
}) {
  // The preview belongs to whichever option is "current": the last one
  // picked, so a multi-select shows the thing you just reached for.
  const focused = draft.picked[draft.picked.length - 1];
  const preview = q.options.find((o) => o.label === focused)?.preview;

  const toggle = (label: string) => {
    if (q.multiSelect) {
      const picked = draft.picked.includes(label)
        ? draft.picked.filter((l) => l !== label)
        : [...draft.picked, label];
      onChange({ ...draft, picked, otherOn: draft.otherOn });
    } else {
      onChange({ ...draft, picked: [label], otherOn: false });
    }
  };

  return (
    <div className="ask-question">
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
        <button
          type="button"
          className={`ask-option ${draft.otherOn ? "on" : ""}`}
          onClick={() =>
            onChange({
              ...draft,
              otherOn: !draft.otherOn,
              // an "Other" answer replaces the options in a single-select;
              // in a multi it just rides alongside them
              picked: q.multiSelect || draft.otherOn ? draft.picked : [],
            })
          }
        >
          <Check on={draft.otherOn} multi={q.multiSelect} />
          <span className="ask-body">
            <span className="ask-label">Other</span>
            <span className="ask-desc">Answer in your own words</span>
          </span>
        </button>
      </div>
      {draft.otherOn && (
        <textarea
          className="ask-other"
          autoFocus
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
  const [drafts, setDrafts] = useState<Draft[]>(() =>
    questions.map(() => ({ picked: [], other: "", otherOn: false })),
  );
  /** Which question the card is showing — one at a time, however many were
   *  asked, so a card is a card and not a form. */
  const [at, setAt] = useState(0);

  const answered = useMemo(() => drafts.every((d) => answerOf(d) !== ""), [drafts]);
  const current = questions[at] ?? questions[0]!;
  const many = questions.length > 1;
  const go = (to: number) => setAt(Math.max(0, Math.min(questions.length - 1, to)));

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
    send({
      type: "question_response",
      requestId: request.requestId,
      answers: {
        answers,
        ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
      },
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
              disabled={at === questions.length - 1}
              onClick={() => go(at + 1)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 18l6-6-6-6" />
              </svg>
            </button>
          </span>
        )}
      </div>
      <QuestionBlock
        key={at}
        q={current}
        draft={drafts[at] ?? drafts[0]!}
        onChange={(next) => setDrafts((d) => d.map((cur, j) => (j === at ? next : cur)))}
      />
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
        <button
          className="ghost"
          title="Let the model carry on without an answer"
          onClick={() => send({ type: "question_response", requestId: request.requestId })}
        >
          Skip
        </button>
      </div>
    </div>
  );
}
