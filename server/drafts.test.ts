import { describe, expect, test } from "bun:test";
import type { DraftAttachment } from "../shared/protocol.js";
import { FreshFiles, sameFiles } from "./drafts.js";

const file = (id: string, over: Partial<DraftAttachment> = {}): DraftAttachment => ({
  id,
  kind: "image",
  mediaType: "image/png",
  name: `${id}.png`,
  n: 1,
  url: `/uploads/${id}.png`,
  ...over,
});

describe("sameFiles", () => {
  test("the same files in another order are the same files", () => {
    expect(sameFiles([file("a"), file("b", { n: 2 })], [file("b", { n: 2 }), file("a")])).toBe(true);
    expect(sameFiles([], [])).toBe(true);
  });

  test("one more, one fewer or another one is not", () => {
    expect(sameFiles([file("a")], [file("a"), file("b")])).toBe(false);
    expect(sameFiles([file("a"), file("b")], [file("a")])).toBe(false);
    expect(sameFiles([file("a")], [file("b")])).toBe(false);
  });

  test("a new number, or a box drawn on one, is a change", () => {
    expect(sameFiles([file("a")], [file("a", { n: 2 })])).toBe(false);
    const boxed = file("a", { regions: [{ x: 0, y: 0, w: 0.5, h: 0.5, n: 1 }] });
    expect(sameFiles([file("a")], [boxed])).toBe(false);
    expect(sameFiles([boxed], [boxed])).toBe(true);
    // no boxes is no boxes, said or not
    expect(sameFiles([file("a")], [file("a", { regions: [] })])).toBe(true);
  });
});

describe("a file added a moment ago", () => {
  test("is not taken out by a list from a device that cannot have heard of it", () => {
    let now = 1_000;
    const fresh = new FreshFiles(() => now);
    fresh.note("x", "phone");
    const held = [file("a"), file("x")];
    // a window's save, on its way when the phone added x
    expect(fresh.keep(held, [file("a")], "window").map((att) => att.id)).toEqual(["a", "x"]);
    // the phone itself leaving it off has taken it out
    expect(fresh.keep(held, [file("a")], "phone").map((att) => att.id)).toEqual(["a"]);
    // and so has a window whose own list had it: it heard
    expect(fresh.keep(held, held, "other window")).toBe(held);
    expect(fresh.keep(held, [file("a")], "other window").map((att) => att.id)).toEqual(["a"]);
    // and once the news has had time to arrive, so has anyone
    now += 3_001;
    expect(fresh.keep(held, [file("a")], "window").map((att) => att.id)).toEqual(["a"]);
  });

  test("a file nobody added lately goes when it is left off", () => {
    const fresh = new FreshFiles(() => 0);
    expect(fresh.keep([file("a"), file("b")], [file("b")], "window").map((att) => att.id)).toEqual(["b"]);
  });

  test("a list that has it is left as it is", () => {
    const fresh = new FreshFiles(() => 0);
    fresh.note("x", "phone");
    const next = [file("x"), file("a")];
    expect(fresh.keep([file("a"), file("x")], next, "window")).toBe(next);
  });
});
