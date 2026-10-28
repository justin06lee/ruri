import { describe, expect, test } from "bun:test";
import { CARRY_ON, type PhoneChatFrame, type TranscriptEvent } from "../shared/protocol.js";
import { nextFrame, phoneItems } from "./phoneChat.js";

const at = 1_700_000_000_000;

describe("phoneItems", () => {
  test("what was said in full, tool calls folded into steps, ruri's own prompts left out", () => {
    const events: TranscriptEvent[] = [
      { kind: "user", id: "u1", text: "fix the build", ts: at },
      { kind: "tool", id: "t1", name: "Read", summary: "Makefile", ts: at + 1 },
      { kind: "tool", id: "t2", name: "Bash", summary: "make build", ts: at + 2 },
      { kind: "assistant", id: "a1", text: "Fixed.", ts: at + 3 },
      { kind: "result", id: "r1", ok: true, ts: at + 4 },
      { kind: "user", id: "u2", text: `${CARRY_ON}: carry on`, ts: at + 5 },
      { kind: "result", id: "r2", ok: false, error: "overloaded", ts: at + 6 },
      { kind: "result", id: "r3", ok: false, stopped: true, ts: at + 7 },
    ];
    const items = phoneItems(events);
    expect(items.map((item) => [item.id, item.kind, item.text])).toEqual([
      ["u1", "user", "fix the build"],
      ["t1", "steps", "2 steps"],
      ["a1", "assistant", "Fixed."],
      ["r2", "note", "Stopped on an error: overloaded"],
      ["r3", "note", "Stopped"],
    ]);
    expect(items[1]!.steps).toEqual(["Read: Makefile", "Bash: make build"]);
  });

  test("the reply still being written comes last, marked pending", () => {
    const items = phoneItems([{ kind: "user", id: "u1", text: "hi", ts: at }], { id: "m1", text: "Hel" });
    expect(items.at(-1)).toMatchObject({ id: "draft:m1", kind: "assistant", text: "Hel", pending: true });
  });
});

describe("nextFrame", () => {
  const frame = (items: { id: string; text: string }[]): PhoneChatFrame => ({
    chat: "c",
    name: "ruri",
    project: "ruri",
    state: "working",
    queue: [],
    items: items.map((item) => ({ ...item, kind: "assistant", at: "" })),
  });

  test("the whole list first, then only what changed or is new", () => {
    const first = nextFrame(frame([{ id: "a", text: "1" }]), new Map());
    expect(first.send?.items?.length).toBe(1);
    const second = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      first.held,
    );
    expect(second.send?.items).toBeUndefined();
    expect(second.send?.upsert?.map((item) => item.id)).toEqual(["b"]);
    const same = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      second.held,
    );
    expect(same.send).toBeUndefined();
  });

  test("a draft that became the reply: removed, and the reply added", () => {
    const held = nextFrame(frame([{ id: "draft:m", text: "Hel" }]), new Map()).held;
    const next = nextFrame(frame([{ id: "a", text: "Hello" }]), held);
    expect(next.send?.remove).toEqual(["draft:m"]);
    expect(next.send?.upsert?.map((item) => item.id)).toEqual(["a"]);
  });

  test("a change of order sends the whole list again", () => {
    const held = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      new Map(),
    ).held;
    const next = nextFrame(
      frame([
        { id: "b", text: "2" },
        { id: "a", text: "1" },
      ]),
      held,
    );
    expect(next.send?.items?.map((item) => item.id)).toEqual(["b", "a"]);
  });
});
