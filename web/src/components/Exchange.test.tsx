import "../test/dom";
import { describe, expect, test } from "bun:test";
import { excerpt, type TranscriptEvent } from "../../../shared/protocol";

// After the window exists (see ../test/dom): everything below reaches
// DOMPurify through the markdown the events are drawn with.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Exchange } = await import("./Exchange");

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

const EVENTS: TranscriptEvent[] = [
  { kind: "user", id: "u1", text: "fix the thing", ts: 1 },
  { kind: "assistant", id: "a1", text: "fixed it", ts: 2 },
];

/** An exchange with both halves open, the way a live turn is shown. */
function open(foldable: boolean): HTMLElement {
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  const root = createRoot(holder);
  act(() => {
    root.render(
      <Exchange
        turnId="u1"
        events={EVENTS}
        note={undefined}
        prompt=""
        reply=""
        count={2}
        promptOpen
        replyOpen
        replyFolds
        foldable={foldable}
        onOpen={() => {}}
        onFold={() => {}}
        onFoldHalf={() => {}}
      />,
    );
  });
  return holder;
}

// Only an exchange above the newest compaction has notes to fold to.
// Below it, folding an exchange would hide what is actually being said
// behind nothing, so none of the ways in exist.
describe("an exchange below the newest compaction", () => {
  test("offers no way to fold: no chevron, no pill, no click on the prompt", () => {
    const dom = open(false);
    expect(dom.querySelector(".turn-fold")).toBeNull();
    expect(dom.querySelector(".half-fold")).toBeNull();
    expect(dom.querySelector(".exchange-half.folds")).toBeNull();
  });

  test("and still shows both halves whole", () => {
    const dom = open(false);
    expect(dom.querySelector(".msg.user")?.textContent).toContain("fix the thing");
    expect(dom.querySelector(".msg.assistant")?.textContent).toContain("fixed it");
    expect(dom.querySelector(".msg.note")).toBeNull();
  });

  test("where one above it offers all three", () => {
    const dom = open(true);
    expect(dom.querySelector(".turn-fold")).not.toBeNull();
    expect(dom.querySelector(".half-fold")?.textContent).toContain("fold reply");
    expect(dom.querySelectorAll(".exchange-half.folds").length).toBe(2);
  });
});

// ruri's own prompt carrying a chat on after it compacted itself
// (server/selfCompaction.ts continuePrompt): neither the user's prompt nor
// a message from the agent its `from` names.
const NOTE = "Doing: the audit for the lead. Done: two paths. Next: the third.";
const CARRY_ON_TEXT = [
  "↻ You compacted yourself: this is a fresh session, and the brief above is the conversation so far. This is the handoff note you wrote for this moment:",
  "",
  "<handoff-note>",
  NOTE,
  "</handoff-note>",
  "",
  "Carry on from where it leaves off, now — nobody else will tell you to.",
].join("\n");

(globalThis as Record<string, unknown>)["ResizeObserver"] ??= class {
  observe() {}
  disconnect() {}
};

function carriedOn(events: TranscriptEvent[], promptOpen: boolean, prompt = ""): HTMLElement {
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  const root = createRoot(holder);
  act(() => {
    root.render(
      <Exchange
        turnId="c1"
        events={promptOpen ? events : undefined}
        note={undefined}
        prompt={prompt}
        reply="carried on"
        count={events.length}
        promptOpen={promptOpen}
        replyOpen={false}
        replyFolds={false}
        foldable
        onOpen={() => {}}
        onFold={() => {}}
        onFoldHalf={() => {}}
      />,
    );
  });
  return holder;
}

describe("ruri carrying a chat on after it compacted itself", () => {
  test("shows as ruri's line and the agent's note, never as a prompt", () => {
    const dom = carriedOn([{ kind: "user", id: "c1", text: CARRY_ON_TEXT, ts: 1 }], true);
    expect(dom.querySelector(".msg.user")).toBeNull();
    expect(dom.querySelector(".carry-on-head")?.textContent).toBe("carried on from its handoff note");
    expect(dom.querySelector(".carry-on-note")?.textContent).toContain(NOTE);
    expect(dom.textContent).not.toContain("You compacted yourself");
    expect(dom.querySelector(".rewind-pencil")).toBeNull();
  });

  test("carried with another agent's message: whose job it is, not a message from it", () => {
    const from = {
      agent: "lead",
      project: "ruri",
      title: "Lead",
      letter: "l1",
      reply: "wait" as const,
      depth: 1,
      carried: true,
    };
    const dom = carriedOn([{ kind: "user", id: "c1", text: CARRY_ON_TEXT, from, ts: 1 }], true);
    expect(dom.querySelector(".letter-from")).toBeNull();
    expect(dom.querySelector(".carry-on-head")?.textContent).toBe(
      "carried on from its handoff note · for ruri · Lead",
    );
  });

  test("folded above a newer compaction, it is the same line over a cut of the note", () => {
    const dom = carriedOn([], false, excerpt(CARRY_ON_TEXT, 220));
    expect(dom.querySelector(".msg.user.note")).toBeNull();
    expect(dom.querySelector(".msg.carry-on.note .carry-on-head")?.textContent).toBe(
      "carried on from its handoff note",
    );
    expect(dom.querySelector(".carry-on-cut")?.textContent).toContain("Doing: the audit");
  });
});
