import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../../../shared/protocol";
import { overlay, reuse } from "./transcript";

const user = (id: string, text = id): TranscriptEvent => ({ kind: "user", id, text, ts: 1 });

describe("reuse", () => {
  test("nothing held: the new list as it came", () => {
    const next = [user("a")];
    expect(reuse(undefined, next)).toBe(next);
    expect(reuse([], next)).toBe(next);
  });

  test("nothing changed: the very list already on screen", () => {
    const held = [user("a"), user("b")];
    expect(reuse(held, [user("a"), user("b")])).toBe(held);
  });

  test("unchanged events keep their identity; changed ones are the new object", () => {
    const held = [user("a"), user("b")];
    const changed = user("b", "edited");
    const out = reuse(held, [user("a"), changed, user("c")]);
    expect(out).not.toBe(held);
    expect(out[0]).toBe(held[0]!);
    expect(out[1]).toBe(changed);
    expect(out[2]).toEqual(user("c"));
  });

  test("a shorter list is a new list, even if every event in it is held", () => {
    const held = [user("a"), user("b")];
    const out = reuse(held, [user("a")]);
    expect(out).not.toBe(held);
    expect(out).toEqual([held[0]!]);
    expect(out[0]).toBe(held[0]!);
  });

  test("the same events in a new order are a new list", () => {
    const held = [user("a"), user("b")];
    const out = reuse(held, [user("b"), user("a")]);
    expect(out).not.toBe(held);
    expect(out[0]).toBe(held[1]!);
  });
});

describe("overlay", () => {
  test("what the tail has replaces, what is new is added, the rest stays", () => {
    const held = [user("a"), user("b"), user("c")];
    const out = overlay(held, [user("c", "edited"), user("d")]);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c", "d"]);
    expect(out[0]).toBe(held[0]!);
    expect(out[2]).toEqual(user("c", "edited"));
  });

  test("an empty tail changes nothing", () => {
    const held = [user("a")];
    expect(overlay(held, [])).toEqual(held);
  });

  test("the held list itself is not modified", () => {
    const held = [user("a")];
    overlay(held, [user("b")]);
    expect(held).toHaveLength(1);
  });
});
