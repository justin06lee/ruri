import { describe, expect, test } from "bun:test";
import stringWidth from "string-width";
import { markdownLines } from "./markdown";

describe("markdown for a terminal", () => {
  test("paragraphs wrap to the width, wide characters counted as two", () => {
    const lines = markdownLines(
      "one two three four five six seven eight nine ten 한국어 문장도 줄바꿈이 됩니다",
      20,
    );
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(20);
  });

  test("inline marks go, their words stay; entities are themselves", () => {
    expect(markdownLines('a **bold** *em* `co<de>` ~~gone~~ < & "q"', 80)).toEqual([
      'a bold em co<de> gone < & "q"',
    ]);
  });

  test("a link shows where it goes unless it says so already", () => {
    expect(markdownLines("[docs](https://x.dev)", 80)).toEqual(["docs (https://x.dev)"]);
    expect(markdownLines("<https://x.dev>", 80)).toEqual(["https://x.dev"]);
  });

  test("lists: bullets, numbers, nesting, ticks", () => {
    expect(
      markdownLines("- one\n- two\n  - inner\n\n3. three\n4. four\n\n- [x] done\n- [ ] todo", 40),
    ).toEqual(["• one", "• two", "  • inner", "", "3. three", "4. four", "", "☑ done", "☐ todo"]);
  });

  test("a list item's second line stands under its first", () => {
    expect(markdownLines("- alpha beta gamma delta", 14)).toEqual(["• alpha beta", "  gamma delta"]);
  });

  test("code keeps its spaces and says its language", () => {
    expect(markdownLines("```ts\nconst x = 1;\n  y();\n```", 40)).toEqual([
      "┌ ts",
      "│ const x = 1;",
      "│   y();",
    ]);
  });

  test("a code fence still open, as a reply streams, is code", () => {
    expect(markdownLines("```\nhalf", 40)).toEqual(["│ half"]);
  });

  test("headings, quotes and rules, one blank line between blocks", () => {
    expect(markdownLines("# Title\ntext\n\n> quoted\n\n---\nend", 40)).toEqual([
      "Title",
      "",
      "text",
      "",
      "▎ quoted",
      "",
      "─".repeat(40),
      "",
      "end",
    ]);
  });

  test("a table stands as columns when it fits, and as rows of labels when it does not", () => {
    expect(markdownLines("| a | b |\n|---|---|\n| 1 | two |", 40)).toEqual(["a │ b  ", "──┼────", "1 │ two"]);
    expect(markdownLines("| name | what |\n|---|---|\n| first | a long cell here |", 16)).toEqual([
      "name: first",
      "what: a long",
      "cell here",
    ]);
  });

  test("nothing is nothing", () => {
    expect(markdownLines("  \n", 40)).toEqual([]);
  });
});
