import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { knownCommands, listCommands, splitCommands } from "./commands.js";

const known = new Set(["compact", "clear", "review", "context", "my-skill", "bmo:install"]);

describe("splitCommands", () => {
  test("a prompt with no command in it is left alone", () => {
    expect(splitCommands("fix the flaky test\n\nthen tell me", known)).toEqual({
      commands: [],
      rest: "fix the flaky test\n\nthen tell me",
    });
  });

  test("a command on a line of its own is lifted out, the rest is the prompt", () => {
    expect(splitCommands("/compact\nnow fix the bug", known)).toEqual({
      commands: ["/compact"],
      rest: "now fix the bug",
    });
    expect(splitCommands("/clear", known)).toEqual({ commands: ["/clear"], rest: "" });
  });

  test("commands run in the order written, wherever they sit", () => {
    const { commands, rest } = splitCommands("look at this\n/clear\n/compact\nthen carry on", known);
    expect(commands).toEqual(["/clear", "/compact"]);
    // a harness command's line goes with it; ruri's own is lifted out of
    // its line as a word, so the line it stood on stays, empty
    expect(rest).toBe("look at this\n\nthen carry on");
  });

  test("a harness command keeps its arguments, as one line", () => {
    expect(splitCommands("/review this branch carefully\nthanks", known)).toEqual({
      commands: ["/review this branch carefully"],
      rest: "thanks",
    });
  });

  test("ruri's own take no arguments: the words after /compact are the prompt", () => {
    expect(splitCommands("/compact now go and read the provider layer", known)).toEqual({
      commands: ["/compact"],
      rest: "now go and read the provider layer",
    });
  });

  test("ruri's own work as a word in the middle of a line", () => {
    expect(splitCommands("read it, and /compact before you start", known)).toEqual({
      commands: ["/compact"],
      rest: "read it, and before you start",
    });
  });

  test("a harness command is only a command on its own line", () => {
    const text = "please /clear the way and go";
    expect(splitCommands(text, known)).toEqual({ commands: [], rest: text });
  });

  test("a quoted command is a mention of it, not a use", () => {
    for (const text of [
      "'/compact' is what to type",
      '"/compact" is what to type',
      "`/compact` is what to type",
    ]) {
      expect(splitCommands(text, known)).toEqual({ commands: [], rest: text });
    }
  });

  test("a slash word that is not a command stays: a path, a typo", () => {
    expect(splitCommands("/tmp\nis where it is", known)).toEqual({
      commands: [],
      rest: "/tmp\nis where it is",
    });
    expect(splitCommands("/compact/other", known)).toEqual({ commands: [], rest: "/compact/other" });
    expect(splitCommands("/nonsense", known)).toEqual({ commands: [], rest: "/nonsense" });
  });

  test("case does not matter, and the command is recorded lowercased", () => {
    expect(splitCommands("/COMPACT\nhi", known)).toEqual({ commands: ["/compact"], rest: "hi" });
  });

  test("skill and namespaced names count", () => {
    expect(splitCommands("/my-skill do the thing", known).commands).toEqual(["/my-skill do the thing"]);
    expect(splitCommands("/bmo:install foo", known).commands).toEqual(["/bmo:install foo"]);
  });

  test("the same command twice is run twice", () => {
    expect(splitCommands("/compact and /compact", known)).toEqual({
      commands: ["/compact", "/compact"],
      rest: "and",
    });
  });

  test("the lines it leaves behind are tidied: no trailing space, no triple newline", () => {
    const { rest } = splitCommands("a\n\n\n/compact\n\n\nb   ", known);
    expect(rest).toBe("a\n\nb");
    expect(splitCommands("   /compact   ", known)).toEqual({ commands: ["/compact"], rest: "" });
  });

  test("with nothing else known, only ruri's own are lifted", () => {
    // ruri's commands are always there; the rest have to be known
    expect(splitCommands("/compact", new Set())).toEqual({ commands: ["/compact"], rest: "" });
    expect(splitCommands("/clear", new Set())).toEqual({ commands: [], rest: "/clear" });
  });
});

describe("the catalog of commands", () => {
  // Only the project's own folder is set up: the home folder is the real
  // one (bun's os.homedir() does not follow $HOME), so nothing here
  // asserts on what it holds.
  let project: string;

  beforeAll(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-commands-project-"));
    fs.mkdirSync(path.join(project, ".claude", "commands"), { recursive: true });
    fs.writeFileSync(path.join(project, ".claude", "commands", "ruri-test-local.md"), "# local");
    fs.writeFileSync(path.join(project, ".claude", "commands", "ruri-test-notes.txt"), "not a command");
    // a custom command named like a built-in is the built-in, listed once
    fs.writeFileSync(path.join(project, ".claude", "commands", "clear.md"), "# clear");
  });
  afterAll(() => {
    fs.rmSync(project, { recursive: true, force: true });
  });

  test("knownCommands: ruri's, the harness's, and every .md in the project's folder", () => {
    const names = knownCommands(project);
    expect(names.has("compact")).toBe(true);
    expect(names.has("clear")).toBe(true);
    expect(names.has("ruri-test-local")).toBe(true);
    expect(names.has("ruri-test-notes")).toBe(false);
    expect(names.has("tmp")).toBe(false);
  });

  test("knownCommands is held for a moment per project", () => {
    const first = knownCommands(project);
    fs.writeFileSync(path.join(project, ".claude", "commands", "ruri-test-later.md"), "# later");
    expect(knownCommands(project)).toBe(first);
    expect(first.has("ruri-test-later")).toBe(false);
  });

  test("listCommands describes each one, sorted, and never twice", () => {
    const listed = listCommands(project);
    const names = listed.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(names.filter((n) => n === "clear")).toHaveLength(1);
    expect(listed.find((c) => c.name === "compact")).toEqual({
      name: "compact",
      kind: "ruri",
      description: expect.stringContaining("compacts"),
    });
    expect(listed.find((c) => c.name === "clear")?.kind).toBe("harness");
    expect(listed.find((c) => c.name === "ruri-test-local")).toEqual({
      name: "ruri-test-local",
      kind: "custom",
    });
  });
});
