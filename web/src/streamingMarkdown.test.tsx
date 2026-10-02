import "./test/dom";
import { describe, expect, test } from "bun:test";

// After the window exists (see ./test/dom): DOMPurify binds to it as it loads.
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { StreamingMarkdown } = await import("./markdown");
const { markdownHtml } = await import("./lib/markdownHtml");

(globalThis as Record<string, unknown>)["IS_REACT_ACT_ENVIRONMENT"] = true;

function mount(): { show: (text: string) => void; box: () => HTMLElement } {
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  const root = createRoot(holder);
  return {
    show: (text) => act(() => root.render(<StreamingMarkdown text={text} />)),
    box: () => holder.querySelector<HTMLElement>(".md")!,
  };
}

/** The same markup, compared as the page has it. */
function same(html: string): string {
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.innerHTML;
}

describe("a reply as it streams in", () => {
  test("shows what the whole-text render shows, at every paragraph", () => {
    const { show, box } = mount();
    const paragraphs = [
      "First, the plan.",
      "- one\n- two",
      "```ts\nconst a = 1;\n```",
      "| a | b |\n| - | - |\n| 1 | 2 |",
      "> and a quote",
      "Done.",
    ];
    let text = "";
    for (const paragraph of paragraphs) {
      text += `${paragraph}\n\n`;
      show(text);
      expect(box().innerHTML).toBe(same(markdownHtml(text)));
    }
  });

  test("a finished paragraph's nodes are put in once and left alone", () => {
    const { show, box } = mount();
    show("One.\n\nTwo.\n\n");
    const first = box().querySelector("p");
    show("One.\n\nTwo.\n\nThree.\n\n");
    show("One.\n\nTwo.\n\nThree.\n\nFour.\n\n");
    // the very same element: nothing above the newest block is rebuilt
    expect(box().querySelector("p")).toBe(first);
    expect(box().querySelectorAll("p")).toHaveLength(4);
  });

  test("a rewind replaces everything", () => {
    const { show, box } = mount();
    show("One.\n\nTwo.\n\n");
    show("Something else.\n\n");
    expect(box().innerHTML).toBe(same(markdownHtml("Something else.\n\n")));
  });
});
