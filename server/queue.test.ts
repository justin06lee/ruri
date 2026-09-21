import { describe, expect, test } from "bun:test";
import { combine, uncombine, type QueueEntry } from "./queue.js";

const entry = (id: string, extra: Partial<QueueEntry> = {}): QueueEntry => ({
  id,
  text: `prompt ${id}`,
  uploads: [],
  silent: false,
  ...extra,
});

const ids = (queue: QueueEntry[] | null) => queue?.map((e) => e.id);

describe("folding queued prompts together", () => {
  test("the words go in the order the two stood in the line, whichever was carried", () => {
    const queue = [entry("1"), entry("2"), entry("3")];
    // prompt 2 carried up onto prompt 1
    const up = combine(queue, "2", "1")!;
    expect(ids(up)).toEqual(["1", "3"]);
    expect(up[0]!.text).toBe("prompt 1\n\nprompt 2");
    // prompt 1 carried down onto prompt 3
    const down = combine(queue, "1", "3")!;
    expect(ids(down)).toEqual(["2", "3"]);
    expect(down[1]!.text).toBe("prompt 1\n\nprompt 3");
  });

  test("pictures keep their numbers in reading order", () => {
    const pic = (n: number) => ({
      kind: "image" as const,
      id: `p${n}`,
      n,
      name: `p${n}.png`,
      mediaType: "image/png",
      data: "x",
    });
    const queue = [
      entry("1", { text: "look at [image #1]", uploads: [pic(1)] }),
      entry("2", { text: "and [image #1]", uploads: [pic(1)] }),
    ];
    const folded = combine(queue, "2", "1")!;
    expect(folded[0]!.text).toBe("look at [image #1]\n\nand [image #2]");
    expect(folded[0]!.uploads.map((u) => u.n)).toEqual([1, 2]);
  });

  test("nothing folds into itself, into a silent entry, or into one being rewritten", () => {
    const queue = [entry("1"), entry("s", { silent: true }), entry("e", { editing: true })];
    expect(combine(queue, "1", "1")).toBeNull();
    expect(combine(queue, "1", "s")).toBeNull();
    expect(combine(queue, "1", "e")).toBeNull();
  });
});

describe("taking a fold back", () => {
  test("both prompts return to where they stood, whichever way it was carried", () => {
    const queue = [entry("1"), entry("2"), entry("3"), entry("4")];
    for (const [from, into] of [
      ["2", "1"],
      ["1", "3"],
      ["4", "2"],
      ["1", "4"],
    ] as const) {
      const back = uncombine(combine(queue, from, into)!, into)!;
      expect(ids(back)).toEqual(["1", "2", "3", "4"]);
      expect(back.map((e) => e.text)).toEqual(queue.map((e) => e.text));
    }
  });

  test("a split's silent remainder keeps the front", () => {
    const queue = [entry("s", { silent: true }), entry("1"), entry("2")];
    const back = uncombine(combine(queue, "1", "2")!, "2")!;
    expect(ids(back)).toEqual(["s", "1", "2"]);
  });

  test("the carried one goes behind whichever of its old neighbours are still waiting", () => {
    const queue = [entry("1"), entry("2"), entry("3")];
    const folded = combine(queue, "3", "1")!;
    // prompt 2 went out meanwhile
    const back = uncombine(
      folded.filter((e) => e.id !== "2"),
      "1",
    )!;
    expect(ids(back)).toEqual(["1", "3"]);
  });

  test("a fold that is gone, or was never one, is left alone", () => {
    const queue = [entry("1"), entry("2")];
    expect(uncombine(queue, "1")).toBeNull();
    expect(uncombine(combine(queue, "2", "1")!, "2")).toBeNull();
  });
});
