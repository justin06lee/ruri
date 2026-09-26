import { describe, expect, test } from "bun:test";
import type { ProjectStatus } from "../../../shared/protocol";
import { lineOf, type LineProject, nextAfter, repick } from "./rapid";

const PROJECTS: LineProject[] = [
  { starred: true, sessions: [{ id: "star-1" }, { id: "star-2" }] },
  { sessions: [{ id: "plain-1" }] },
  { hidden: true, starred: true, sessions: [{ id: "hidden-starred" }] },
  { hidden: true, sessions: [{ id: "hidden-plain" }] },
];

const STATUSES: Record<string, ProjectStatus> = { "star-2": "working" };

describe("the rapid fire line", () => {
  test("never holds a hidden project, starred or not", () => {
    for (const starredOnly of [false, true]) {
      const { ids, ready } = lineOf(PROJECTS, STATUSES, starredOnly);
      expect(ids).not.toContain("hidden-starred");
      expect(ids).not.toContain("hidden-plain");
      expect(ready).not.toContain("hidden-starred");
      expect(ready).not.toContain("hidden-plain");
    }
  });

  test("holds every open project, starred first, when it is not narrowed", () => {
    expect(lineOf(PROJECTS, STATUSES).ids).toEqual(["star-1", "star-2", "plain-1"]);
  });

  test("narrowed, holds only the starred ones", () => {
    expect(lineOf(PROJECTS, STATUSES, true).ids).toEqual(["star-1", "star-2"]);
  });

  test("narrowed with nothing starred, the line is empty rather than everyone", () => {
    const plain: LineProject[] = [{ sessions: [{ id: "a" }] }, { hidden: true, sessions: [{ id: "b" }] }];
    expect(lineOf(plain, {}, true)).toEqual({ ids: [], ready: [] });
  });

  test("a session mid-turn is in the line but not ready for a prompt", () => {
    const { ids, ready } = lineOf(PROJECTS, STATUSES, true);
    expect(ids).toContain("star-2");
    expect(ready).toEqual(["star-1"]);
  });

  test("a status nobody has reported yet counts as ready", () => {
    expect(lineOf([{ sessions: [{ id: "fresh" }] }], {}).ready).toEqual(["fresh"]);
  });
});

describe("handing on down the line", () => {
  const line = { ids: ["a", "b", "c", "d"], ready: ["a", "c", "d"] };

  test("goes round to the next one ready, past the ones working", () => {
    expect(nextAfter(line, "a")).toBe("c");
    expect(nextAfter(line, "d")).toBe("a");
    expect(nextAfter(line, "b")).toBe("c");
  });

  test("never hands back to the session it is leaving", () => {
    // the prompt just sent there can still read as ready for a moment
    expect(nextAfter({ ids: ["a", "b"], ready: ["a"] }, "a")).toBeUndefined();
    expect(nextAfter({ ids: ["a"], ready: ["a"] }, "a")).toBeUndefined();
  });

  test("from outside the line, starts at the first one ready", () => {
    expect(nextAfter(line, undefined)).toBe("a");
    expect(nextAfter(line, "gone")).toBe("a");
  });

  test("nobody ready, nowhere to go", () => {
    expect(nextAfter({ ids: ["a", "b"], ready: [] }, "a")).toBeUndefined();
  });
});

describe("where the pick rests", () => {
  const line = { ids: ["a", "b", "c"], ready: ["a", "c"] };

  test("stays put while its session can take a prompt", () => {
    expect(repick(line, "c", "a")).toBe("c");
  });

  test("entering from a session that is ready starts there", () => {
    expect(repick(line, undefined, "c")).toBe("c");
  });

  test("entering from anywhere else starts at the first one ready", () => {
    expect(repick(line, undefined, "home")).toBe("a");
    expect(repick(line, undefined, null)).toBe("a");
  });

  test("moves on when its session starts a turn", () => {
    expect(repick(line, "b", null)).toBe("c");
  });

  test("everyone working: stays to watch this one finish", () => {
    expect(repick({ ids: ["a", "b"], ready: [] }, "a", null)).toBe("a");
  });

  test("lets go of a session that has left the line", () => {
    expect(repick({ ids: ["a"], ready: [] }, "gone", null)).toBeUndefined();
  });

  test("an empty line picks nobody", () => {
    expect(repick({ ids: [], ready: [] }, undefined, "a")).toBeUndefined();
  });
});
