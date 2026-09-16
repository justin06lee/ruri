import { describe, expect, test } from "bun:test";
import { buildDiff, parseUnifiedDiff } from "./diff.js";

describe("buildDiff", () => {
  test("null when nothing moved", () => {
    expect(buildDiff("a.txt", "same\n", "same\n")).toBeNull();
    expect(buildDiff("a.txt", null, "")).toBeNull();
  });

  test("a one-line change becomes one hunk with three lines of context", () => {
    const before = ["1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n") + "\n";
    const after = before.replace("5", "five");
    const diff = buildDiff("n.txt", before, after)!;
    expect(diff.path).toBe("n.txt");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.created).toBeUndefined();
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0]!;
    expect(hunk.oldStart).toBe(2);
    expect(hunk.newStart).toBe(2);
    expect(hunk.lines.map((l) => `${l.kind[0]}${l.text}`)).toEqual([
      "c2",
      "c3",
      "c4",
      "d5",
      "afive",
      "c6",
      "c7",
      "c8",
    ]);
  });

  test("changes far apart land in separate hunks", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const before = lines.join("\n") + "\n";
    const edited = [...lines];
    edited[1] = "changed 2";
    edited[27] = "changed 28";
    const diff = buildDiff("f", before, edited.join("\n") + "\n")!;
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[0]!.oldStart).toBe(1);
    expect(diff.hunks[1]!.oldStart).toBe(25);
  });

  test("a new file is all additions and marked created", () => {
    const diff = buildDiff("new.txt", null, "a\nb\n")!;
    expect(diff.created).toBe(true);
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(0);
    expect(diff.hunks[0]!.lines.every((l) => l.kind === "add")).toBe(true);
  });

  test("a trailing newline is a terminator, not an empty last line", () => {
    const diff = buildDiff("t", "a\n", "a\nb\n")!;
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(0);
  });

  test("a huge rewrite is truncated rather than dropped", () => {
    const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n");
    const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
    const diff = buildDiff("big", before, after)!;
    expect(diff.truncated).toBe(true);
    expect(diff.added).toBe(2000);
    expect(diff.removed).toBe(2000);
    const shown = diff.hunks.reduce((n, h) => n + h.lines.length, 0);
    expect(shown).toBeLessThanOrEqual(600);
  });
});

describe("parseUnifiedDiff", () => {
  const patch = [
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -10,3 +10,4 @@",
    " keep",
    "-gone",
    "+here",
    "+and here",
    " keep",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  test("reads hunk headers and line kinds", () => {
    const diff = parseUnifiedDiff("x.ts", patch)!;
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toHaveLength(1);
    const hunk = diff.hunks[0]!;
    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);
    expect(hunk.lines).toEqual([
      { kind: "ctx", text: "keep" },
      { kind: "del", text: "gone" },
      { kind: "add", text: "here" },
      { kind: "add", text: "and here" },
      { kind: "ctx", text: "keep" },
    ]);
  });

  test("carries the created flag through", () => {
    expect(parseUnifiedDiff("x.ts", patch, { created: true })!.created).toBe(true);
    expect(parseUnifiedDiff("x.ts", patch)!.created).toBeUndefined();
  });

  test("null for a patch that changes nothing", () => {
    expect(parseUnifiedDiff("x.ts", "@@ -1,1 +1,1 @@\n same\n")).toBeNull();
    expect(parseUnifiedDiff("x.ts", "")).toBeNull();
  });
});
