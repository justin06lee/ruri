import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { blankProject, clearRuriDir, removeRuriFile, ruriDir } from "./ruriDir.js";

let project: string;

beforeEach(() => {
  project = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-dir-"));
});
afterEach(() => {
  fs.rmSync(project, { recursive: true, force: true });
});

const touch = (rel: string) => {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), "");
};
const ruri = () => path.join(project, ".ruri");

describe("blankProject", () => {
  test("an empty folder, or one holding only what a scaffolder builds around, is blank", () => {
    expect(blankProject(project)).toBe(true);
    for (const name of [".git/HEAD", ".gitignore", "LICENSE", ".DS_Store", ".claude/settings.json", "app.iml"]) {
      touch(name);
    }
    expect(blankProject(project)).toBe(true);
  });

  test("ruri's own folder doesn't make a project any less blank", () => {
    touch(".ruri/catchup.md");
    expect(blankProject(project)).toBe(true);
  });

  test("anything a scaffolder would refuse makes it a project", () => {
    touch("README.md");
    expect(blankProject(project)).toBe(false);
  });

  test("a folder that isn't there is nowhere to write", () => {
    expect(blankProject(path.join(project, "gone"))).toBe(true);
  });
});

describe("ruriDir", () => {
  test("a blank project gets no folder", () => {
    expect(ruriDir(project)).toBeUndefined();
    expect(fs.existsSync(ruri())).toBe(false);
  });

  test("a blank project loses the folder ruri left there before", () => {
    touch(".ruri/.gitignore");
    touch(".ruri/catchup.md");
    touch(".ruri/components.md");
    expect(ruriDir(project)).toBeUndefined();
    expect(fs.existsSync(ruri())).toBe(false);
  });

  test("a real project gets the folder, ignoring itself", () => {
    touch("package.json");
    expect(ruriDir(project)).toBe(ruri());
    expect(fs.readFileSync(path.join(ruri(), ".gitignore"), "utf8")).toBe("*\n");
  });

  test("a project whose folder is gone is not recreated", () => {
    const gone = path.join(project, "gone");
    expect(ruriDir(gone)).toBeUndefined();
    expect(fs.existsSync(gone)).toBe(false);
  });
});

describe("clearRuriDir", () => {
  test("leaves what isn't ruri's to take", () => {
    touch(".ruri/.gitignore");
    touch(".ruri/catchup.md");
    touch(".ruri/components.jsonl");
    clearRuriDir(project);
    expect(fs.readdirSync(ruri())).toEqual(["components.jsonl"]);
  });
});

describe("removeRuriFile", () => {
  test("takes the folder along once only its .gitignore is left", () => {
    touch("package.json");
    ruriDir(project);
    touch(".ruri/catchup.md");
    touch(".ruri/components.md");
    removeRuriFile(project, "catchup.md");
    expect(fs.readdirSync(ruri()).sort()).toEqual([".gitignore", "components.md"]);
    removeRuriFile(project, "components.md");
    expect(fs.existsSync(ruri())).toBe(false);
  });
});
