import { describe, expect, test } from "bun:test";
import type { ProjectStatus } from "../../../shared/protocol";
import { lineOf, type LineProject } from "./rapid";

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
