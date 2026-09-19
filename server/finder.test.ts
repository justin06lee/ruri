import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findProjects } from "./finder.js";

let root: string;

/** A folder under the workspace; `mark` makes it look like a project. */
function folder(rel: string, mark?: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(full, { recursive: true });
  if (mark === ".git") fs.mkdirSync(path.join(full, ".git"));
  else if (mark) fs.writeFileSync(path.join(full, mark), "");
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-finder-"));
  folder("github.com/me/hifz", ".git");
  folder("github.com/me/hifz-app", "package.json");
  folder("github.com/me/my_hifz_notes", "README.md");
  folder("github.com/me/hifz/packages/inner-hifz", "package.json"); // inside a matched project
  folder("github.com/me/other/node_modules/hifz", "package.json"); // skipped folder
  folder("github.com/me/.hidden/hifz", "package.json"); // dot folder
  folder("scratch/hifz"); // a plain folder, no marks
  folder("github.com/me/Frontend UI", "package.json");
  folder("github.com/me/hifzy", "package.json");
  folder("github.com/me/ruri", ".git");
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const names = (query: string, limit?: number) =>
  findProjects([root], query, limit).map((f) => path.relative(root, f.path));

describe("findProjects", () => {
  test("the exact name first, a project ahead of a plain folder of the same name", () => {
    const found = findProjects([root], "hifz");
    expect(found[0]).toMatchObject({
      name: "hifz",
      score: 100,
      project: true,
      path: path.join(root, "github.com/me/hifz"),
    });
    expect(found[1]).toMatchObject({ name: "hifz", score: 100, project: false });
  });

  test("then prefixes, then whole words, then substrings", () => {
    const found = findProjects([root], "hifz");
    const score = (name: string) => found.find((f) => f.name === name)?.score;
    expect(score("hifz-app")).toBe(80);
    expect(score("hifzy")).toBe(80);
    expect(score("my_hifz_notes")).toBe(75);
  });

  test("never inside a project it matched, a skipped folder, or a dot folder", () => {
    const found = names("hifz");
    expect(found).not.toContain("github.com/me/hifz/packages/inner-hifz");
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    expect(found.some((p) => p.includes(".hidden"))).toBe(false);
  });

  test("punctuation and case do not matter", () => {
    expect(names("frontend-ui")[0]).toBe("github.com/me/Frontend UI");
    expect(names("FRONTENDUI")[0]).toBe("github.com/me/Frontend UI");
  });

  test("letters in order find a name, from three on", () => {
    const found = findProjects([root], "rri");
    expect(found.find((f) => f.name === "ruri")?.score).toBe(25);
    expect(findProjects([root], "ri").find((f) => f.name === "ruri")?.score).toBe(60);
  });

  test("an empty query or no match finds nothing; the limit is kept", () => {
    expect(findProjects([root], "  ")).toEqual([]);
    expect(findProjects([root], "zzzz")).toEqual([]);
    expect(findProjects([root], "hifz", 2)).toHaveLength(2);
  });

  test("a root that is not there is no error", () => {
    expect(findProjects([path.join(root, "missing")], "hifz")).toEqual([]);
  });
});
