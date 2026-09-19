import "../test/dom";
import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../../../shared/protocol";

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
