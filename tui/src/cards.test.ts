import { describe, expect, test } from "bun:test";
import type { PermissionRequest } from "../../shared/protocol";
import { cardKey, cardLines, cardState, type CardKey, type CardState, type Verdict } from "./cards";

const request = (over: Partial<PermissionRequest> = {}): PermissionRequest => ({
  requestId: "q1",
  projectId: "chat",
  toolName: "Bash",
  input: { command: "rm -rf build" },
  suggestions: [{}],
  ts: 0,
  ...over,
});

/** Press keys one after another; the answer, when one of them gave it. */
function press(
  req: PermissionRequest,
  keys: Array<CardKey | CardKey["key"]>,
): { state: CardState; verdict?: Verdict } {
  let state = cardState(req);
  let verdict: Verdict | undefined;
  for (const k of keys) {
    const out = cardKey(req, state, typeof k === "string" ? ({ key: k } as CardKey) : k);
    state = out.state;
    verdict = out.verdict ?? verdict;
  }
  return { state, ...(verdict ? { verdict } : {}) };
}
const text = (t: string): CardKey => ({ key: "text", text: t });

const question = (over: Record<string, unknown> = {}) =>
  request({
    kind: "question",
    toolName: "AskUserQuestion",
    input: {
      questions: [
        {
          question: "Which way?",
          header: "Approach",
          multiSelect: false,
          options: [
            { label: "Fast", description: "less safe" },
            { label: "Careful", description: "slower" },
          ],
          ...over,
        },
      ],
    },
  });

describe("cards", () => {
  test("a permission: allow, always allow, deny", () => {
    expect(press(request(), ["enter"]).verdict).toEqual({ type: "permission", allow: true });
    expect(press(request(), ["down", "enter"]).verdict).toEqual({
      type: "permission",
      allow: true,
      always: true,
    });
    expect(press(request(), ["down", "down", "enter"]).verdict).toEqual({ type: "permission", allow: false });
    expect(press(request(), [text("3")]).verdict).toEqual({ type: "permission", allow: false });
  });

  test("no 'always' when the harness offers no rule to keep", () => {
    expect(press(request({ suggestions: [] }), ["down", "enter"]).verdict).toEqual({
      type: "permission",
      allow: false,
    });
  });

  test("a word being typed as the card came up answers nothing", () => {
    expect(press(request(), [text("h"), text("i"), "space", text("x"), "backspace"]).verdict).toBeUndefined();
  });

  test("a question: one pick answers it", () => {
    expect(press(question(), ["down", "enter"]).verdict).toEqual({
      type: "question",
      answers: { answers: { "Which way?": "Careful" }, values: { "Which way?": ["Careful"] } },
    });
  });

  test("a question: your own words instead", () => {
    const out = press(question(), ["down", "down", "enter", text("a third way"), "enter"]);
    expect(out.verdict).toEqual({
      type: "question",
      answers: { answers: { "Which way?": "a third way" }, values: { "Which way?": ["a third way"] } },
    });
  });

  test("a question that must be answered says so and stays", () => {
    const out = press(question(), ["down", "down", "enter", "enter"]);
    expect(out.verdict).toBeUndefined();
    expect(out.state.error).toBe("An answer is required.");
  });

  test("several ticks, then enter", () => {
    const out = press(question({ multiSelect: true }), ["space", "down", "space", "enter"]);
    expect(out.verdict).toEqual({
      type: "question",
      answers: { answers: { "Which way?": "Fast, Careful" }, values: { "Which way?": ["Fast", "Careful"] } },
    });
  });

  test("two questions are answered one after the other, and sent together", () => {
    const req = request({
      kind: "question",
      input: {
        questions: [
          { question: "A?", header: "A", multiSelect: false, options: [{ label: "yes", description: "" }] },
          {
            id: "b",
            question: "B?",
            header: "B",
            multiSelect: false,
            options: [{ label: "no", description: "", value: "0" }],
          },
        ],
      },
    });
    const first = press(req, ["enter"]);
    expect(first.verdict).toBeUndefined();
    expect(first.state.q).toBe(1);
    expect(press(req, ["enter", "enter"]).verdict).toEqual({
      type: "question",
      answers: { answers: { "A?": "yes", "B?": "no" }, values: { "A?": ["yes"], b: ["0"] } },
    });
  });

  test("a name: kept, changed, skipped", () => {
    const req = request({
      kind: "component",
      input: { name: "the gauges", files: ["a.tsx"], note: "small dragons" },
    });
    expect(press(req, ["enter"]).verdict).toEqual({ type: "name", name: "the gauges" });
    expect(
      press(req, ["down", "enter", text("the dragon"), "space", text("gauges"), "enter"]).verdict,
    ).toEqual({
      type: "name",
      name: "the dragon gauges",
    });
    expect(press(req, ["down", "down", "enter"]).verdict).toEqual({ type: "name" });
  });

  test("an agent asking to message another: allow or deny", () => {
    const req = request({
      kind: "message",
      input: { to: "x", project: "midna", title: "Lead", text: "ping", reply: "wait" },
    });
    expect(press(req, ["down", "enter"]).verdict).toEqual({ type: "permission", allow: false });
  });

  test("what a card shows: what is asked, the rows, the keys", () => {
    const lines = cardLines(request(), cardState(request()), 60, 12, true);
    expect(lines).toEqual([
      "? Allow Bash",
      "  rm -rf build",
      "❯ 1. Allow",
      "  2. Always allow",
      "  3. Deny",
      "  ↑↓ choose · enter pick · 1-9 pick by number · esc back to the prompt",
    ]);
    expect(cardLines(request(), cardState(request()), 60, 12, false).at(-1)).toBe("  tab to answer");
  });

  test("a long ask gives way to its choices", () => {
    const req = request({ input: { command: Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") } });
    const lines = cardLines(req, cardState(req), 60, 9, true);
    expect(lines).toHaveLength(9);
    expect(lines).toContain("  3. Deny");
    expect(lines.join("\n")).toContain("more lines");
  });

  test("a question shows its options with what each means", () => {
    const lines = cardLines(question(), cardState(question()), 60, 12, true);
    expect(lines.slice(0, 5)).toEqual([
      "? Approach",
      "  Which way?",
      "❯ 1. Fast — less safe",
      "  2. Careful — slower",
      "  3. Something else…",
    ]);
  });
});
