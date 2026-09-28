import { describe, expect, test } from "bun:test";
import type { ServerMessage } from "../../../shared/protocol";
import { Held } from "./held";

const status = (projectId: string, value: string) =>
  ({ type: "status", projectId, status: value }) as ServerMessage;
const usage = (n: number) => ({ type: "usage", limits: { n } }) as unknown as ServerMessage;
const finished = (projectId: string, id: string) =>
  ({ type: "event", projectId, event: { kind: "result", id } }) as unknown as ServerMessage;
const out = (termId: string, data: string, replay?: boolean) =>
  ({ type: "terminal_data", projectId: "p", termId, data, ...(replay ? { replay } : {}) }) as ServerMessage;

describe("what a sleeping window holds", () => {
  test("hands back what came, in order, and holds nothing after", () => {
    const held = new Held();
    held.hold(finished("a", "r1"));
    held.hold(status("a", "idle"));
    expect(held.take()).toEqual([finished("a", "r1"), status("a", "idle")]);
    expect(held.take()).toEqual([]);
  });

  test("keeps only the newest of what says what something now is", () => {
    const held = new Held();
    held.hold(status("a", "working"));
    held.hold(usage(1));
    held.hold(status("b", "working"));
    held.hold(status("a", "idle"));
    held.hold(usage(2));
    expect(held.take()).toEqual([status("b", "working"), status("a", "idle"), usage(2)]);
  });

  test("the newest lands where it came, after what came between", () => {
    const held = new Held();
    held.hold(status("a", "working"));
    held.hold(finished("a", "r1"));
    held.hold(status("a", "idle"));
    expect(held.take()).toEqual([finished("a", "r1"), status("a", "idle")]);
  });

  test("never folds away an event", () => {
    const held = new Held();
    held.hold(finished("a", "r1"));
    held.hold(finished("a", "r2"));
    expect(held.take()).toHaveLength(2);
  });

  test("joins a shell's output into one message", () => {
    const held = new Held();
    held.hold(out("t1", "make: "));
    held.hold(out("t2", "other"));
    held.hold(out("t1", "done\n"));
    expect(held.take()).toEqual([out("t1", "make: done\n"), out("t2", "other")]);
  });

  test("keeps the newest of a shell's output past its cap", () => {
    const held = new Held(4000, 5);
    held.hold(out("t1", "abc"));
    held.hold(out("t1", "defgh"));
    expect(held.take()).toEqual([out("t1", "defgh")]);
  });

  test("a replay starts a fresh stretch rather than joining the one before", () => {
    const held = new Held();
    held.hold(out("t1", "old"));
    held.hold(out("t1", "screen", true));
    expect(held.take()).toEqual([out("t1", "old"), out("t1", "screen", true)]);
  });

  test("a fresh snapshot makes everything before it moot", () => {
    const held = new Held();
    held.hold(finished("a", "r1"));
    const snapshot = { type: "snapshot" } as unknown as ServerMessage;
    held.hold(snapshot);
    held.hold(status("a", "idle"));
    expect(held.take()).toEqual([snapshot, status("a", "idle")]);
  });

  test("too much gone by is given up, for a fresh snapshot instead", () => {
    const held = new Held(3);
    for (const id of ["r1", "r2", "r3", "r4"]) held.hold(finished("a", id));
    held.hold(finished("a", "r5"));
    expect(held.take()).toBe("overflow");
    // and it starts over after
    held.hold(finished("a", "r6"));
    expect(held.take()).toEqual([finished("a", "r6")]);
  });
});
