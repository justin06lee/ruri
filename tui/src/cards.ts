/**
 * The cards a chat waits on the user with, for a terminal: a permission
 * (allow, always, deny), a question with its options, an agent asking to
 * message another, and a name for something it built. Each is a few lines
 * above the prompt box and a small state the keys move; what the keys
 * decide is a `Verdict` the app sends (store.ts). Pure.
 */
import type {
  AskAnswers,
  AskQuestion,
  AskQuestions,
  ComponentProposal,
  PermissionRequest,
  TalkAsk,
} from "../../shared/protocol";
import { questionError } from "../../shared/questionInput";
import { backspace, EMPTY, insert, type Edit } from "./editor";
import { markdownLines, wrap } from "./markdown";
import { fit } from "./rows";
import { paint } from "./theme";

/** What a question holds so far: the options picked, and words typed
 *  instead of (or beside) them. */
interface Draft {
  picked: string[];
  other: string;
}

export interface CardState {
  /** Whose state this is: a new card starts from nothing. */
  requestId: string;
  /** The row the cursor is on. */
  at: number;
  /** Which question is up. */
  q: number;
  drafts: Draft[];
  /** Typing into the cursor's row: a question's own words, or a new name. */
  typing?: Edit;
  /** Why the last Enter did nothing. */
  error?: string;
}

export type Verdict =
  | { type: "permission"; allow: boolean; always?: boolean }
  | { type: "question"; answers?: AskAnswers }
  | { type: "name"; name?: string };

export type CardKey =
  { key: "up" | "down" | "enter" | "space" | "backspace" } | { key: "text"; text: string };

const kindOf = (request: PermissionRequest) => request.kind ?? "permission";
const questionsOf = (request: PermissionRequest): AskQuestion[] =>
  (request.input as AskQuestions | undefined)?.questions ?? [];

export function cardState(request: PermissionRequest): CardState {
  return {
    requestId: request.requestId,
    at: 0,
    q: 0,
    drafts: questionsOf(request).map(() => ({ picked: [], other: "" })),
  };
}

/** The rows a card's cursor moves over. */
function choices(request: PermissionRequest, state: CardState): string[] {
  switch (kindOf(request)) {
    case "question": {
      const question = questionsOf(request)[state.q];
      if (!question) return [];
      return [
        ...question.options.map((o) => o.label),
        ...(question.allowOther === false && question.options.length > 0 ? [] : ["Something else…"]),
      ];
    }
    case "component":
      return [`Keep “${(request.input as ComponentProposal).name}”`, "Call it something else…", "Skip"];
    case "message":
      return ["Allow", "Deny"];
    default:
      return ["Allow", ...(request.suggestions?.length ? ["Always allow"] : []), "Deny"];
  }
}

const valuesOf = (question: AskQuestion, draft: Draft): string[] => [
  ...draft.picked.map((label) => question.options.find((o) => o.label === label)?.value ?? label),
  ...(draft.other.trim() ? [draft.other] : []),
];

function answersOf(questions: AskQuestion[], drafts: Draft[]): AskAnswers {
  const answers: AskAnswers["answers"] = {};
  const values: NonNullable<AskAnswers["values"]> = {};
  questions.forEach((question, i) => {
    const draft = drafts[i]!;
    answers[question.question] = [...draft.picked, ...(draft.other.trim() ? [draft.other] : [])].join(", ");
    values[question.id ?? question.question] = valuesOf(question, draft);
  });
  return { answers, values };
}

/** A key on a card: its state after it, and the answer when that key gave one. */
export function cardKey(
  request: PermissionRequest,
  state: CardState,
  input: CardKey,
): { state: CardState; verdict?: Verdict } {
  const rows = choices(request, state);
  const kind = kindOf(request);
  const { error: _said, ...clear } = state;

  // typing into the row: every key is a letter but Enter
  if (state.typing) {
    if (input.key === "text") return { state: { ...clear, typing: insert(state.typing, input.text) } };
    if (input.key === "space") return { state: { ...clear, typing: insert(state.typing, " ") } };
    if (input.key === "backspace") return { state: { ...clear, typing: backspace(state.typing) } };
    if (input.key !== "enter") {
      // an arrow leaves the row, keeping what was typed as the question's own words
      const { typing: _left, ...rest } = clear;
      const typed = state.typing.text;
      const drafts =
        kind === "question"
          ? rest.drafts.map((d, i) => (i === rest.q ? { ...d, other: typed } : d))
          : rest.drafts;
      return cardKey(request, { ...rest, drafts }, input);
    }
    const typed = state.typing.text.trim();
    if (kind === "component") {
      return typed ? { state: clear, verdict: { type: "name", name: typed } } : { state: clear };
    }
    const { typing: _done, ...rest } = clear;
    const drafts = rest.drafts.map((d, i) => (i === rest.q ? { ...d, other: typed } : d));
    return advance(request, { ...rest, drafts });
  }

  if (input.key === "up") return { state: { ...clear, at: Math.max(0, state.at - 1) } };
  if (input.key === "down") return { state: { ...clear, at: Math.min(rows.length - 1, state.at + 1) } };
  if (input.key === "backspace") return { state: clear };
  // a space answers nothing but a tick box: a word being typed as the card
  // came up must not allow what it asks
  if (input.key === "space" && !(kind === "question" && questionsOf(request)[state.q]?.multiSelect)) {
    return { state: clear };
  }
  // a number picks its row, as it reads on screen
  if (input.key === "text") {
    const n = /^[1-9]$/.test(input.text) ? Number(input.text) - 1 : -1;
    if (n < 0 || n >= rows.length) return { state: clear };
    return cardKey(request, { ...clear, at: n }, { key: "enter" });
  }

  if (kind === "question") {
    const question = questionsOf(request)[state.q];
    if (!question) return { state: clear, verdict: { type: "question" } };
    const draft = state.drafts[state.q]!;
    const label = question.options[state.at]?.label;
    // the row past the options: the user's own words
    if (label === undefined)
      return { state: { ...clear, typing: { text: draft.other, caret: draft.other.length } } };
    if (question.multiSelect) {
      if (input.key === "enter" && draft.picked.length > 0) return advance(request, clear);
      const picked = draft.picked.includes(label)
        ? draft.picked.filter((l) => l !== label)
        : [...draft.picked, label];
      return {
        state: { ...clear, drafts: state.drafts.map((d, i) => (i === state.q ? { ...d, picked } : d)) },
      };
    }
    const drafts = state.drafts.map((d, i) => (i === state.q ? { picked: [label], other: "" } : d));
    return advance(request, { ...clear, drafts });
  }

  if (kind === "component") {
    if (state.at === 0)
      return { state: clear, verdict: { type: "name", name: (request.input as ComponentProposal).name } };
    if (state.at === 1) return { state: { ...clear, typing: EMPTY } };
    return { state: clear, verdict: { type: "name" } };
  }

  const chosen = rows[state.at];
  if (chosen === "Deny") return { state: clear, verdict: { type: "permission", allow: false } };
  return {
    state: clear,
    verdict: { type: "permission", allow: true, ...(chosen === "Always allow" ? { always: true } : {}) },
  };
}

/** This question is answered: the next one, or — after the last — all of
 *  them, sent. One that isn't says why and stays. */
function advance(request: PermissionRequest, state: CardState): { state: CardState; verdict?: Verdict } {
  const questions = questionsOf(request);
  const question = questions[state.q]!;
  const error = questionError(question, valuesOf(question, state.drafts[state.q]!));
  if (error) return { state: { ...state, error } };
  if (state.q < questions.length - 1) return { state: { ...state, q: state.q + 1, at: 0 } };
  return { state, verdict: { type: "question", answers: answersOf(questions, state.drafts) } };
}

const clock = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** What a permission is for, in the tool's own words. */
function detail(request: PermissionRequest, width: number): string[] {
  const input = (request.input ?? {}) as Record<string, unknown>;
  if (request.toolName === "ExitPlanMode" && typeof input["plan"] === "string") {
    return markdownLines(input["plan"], width);
  }
  const said =
    typeof input["command"] === "string"
      ? input["command"]
      : typeof input["file_path"] === "string"
        ? input["file_path"]
        : JSON.stringify(request.input, null, 2);
  return (said ?? "").split("\n").flatMap((line) => wrap(line, width));
}

/** A card as lines `width` wide, `max` tall at most: what is asked, the
 *  rows to choose from, and the keys. `focused` shows the cursor. */
export function cardLines(
  request: PermissionRequest,
  state: CardState,
  width: number,
  max: number,
  focused: boolean,
): string[] {
  const kind = kindOf(request);
  const rows = choices(request, state);
  const inner = Math.max(8, width - 2);
  const head: string[] = [];
  const body: string[] = [];
  let keys = "↑↓ choose · enter pick · 1-9 pick by number";

  if (kind === "question") {
    const questions = questionsOf(request);
    const question = questions[state.q];
    const count = questions.length > 1 ? ` (${state.q + 1}/${questions.length})` : "";
    head.push(paint.amber(paint.bold(`? ${question?.header ?? "Question"}${count}`)));
    body.push(...wrap(question?.question ?? "", inner));
    if (question?.hint) body.push(...wrap(question.hint, inner).map((l) => paint.soft(l)));
    if (question?.multiSelect) keys = "↑↓ choose · space tick · enter next";
    if (request.late) body.push(paint.soft("the turn moved on: an answer goes as a new prompt"));
  } else if (kind === "component") {
    const proposal = request.input as ComponentProposal;
    head.push(paint.amber(paint.bold("? What do you call this")));
    body.push(...wrap(`${paint.bold(proposal.name)} — ${proposal.note}`, inner));
    body.push(paint.soft(fit(proposal.files.join(", "), inner)));
  } else if (kind === "message") {
    const ask = request.input as TalkAsk;
    head.push(paint.amber(paint.bold(`? Message ${ask.project} · ${ask.title}`)));
    body.push(...ask.text.split("\n").flatMap((line) => wrap(line, inner)));
  } else {
    head.push(paint.amber(paint.bold(`? Allow ${request.toolName}`)));
    body.push(...detail(request, inner));
  }
  if (request.asked) {
    head.push(
      paint.soft(
        `asked of ${request.asked.name} until ${clock(request.asked.until)} — you can answer it too`,
      ),
    );
  }

  const draft = state.drafts[state.q];
  const question = kind === "question" ? questionsOf(request)[state.q] : undefined;
  const options = rows.map((label, i) => {
    const on = i === state.at;
    const ticked = draft?.picked.includes(label) ?? false;
    const box = question?.multiSelect && i < question.options.length ? (ticked ? "☑ " : "☐ ") : "";
    const typed =
      on && state.typing
        ? `${state.typing.text}${paint.inverse(" ")}`
        : kind === "question" && i >= (question?.options.length ?? 0) && draft?.other
          ? draft.other
          : "";
    const said = typed ? `${label.replace(/…$/, "")}: ${typed}` : label;
    const note = question?.options[i]?.description;
    const text = fit(`${i + 1}. ${box}${said}${note ? paint.soft(` — ${note}`) : ""}`, inner);
    return on && focused ? `${paint.accent("❯")} ${paint.bold(text)}` : `  ${text}`;
  });

  const foot = [
    ...(state.error ? [paint.red(`  ${state.error}`)] : []),
    paint.soft(focused ? `  ${keys} · esc back to the prompt` : "  tab to answer"),
  ];
  // the question's own words give way first: the choices always show
  const room = Math.max(1, max - head.length - options.length - foot.length);
  const cut =
    body.length > room
      ? [...body.slice(0, room - 1), paint.soft(`… ${body.length - room + 1} more lines`)]
      : body;
  return [...head, ...cut.map((line) => `  ${line}`), ...options, ...foot].slice(0, Math.max(3, max));
}
