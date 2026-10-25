import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { configPath } from "./configDir.js";
import { clearResume, freezeResume, markResume } from "./resume.js";

const book = (): string[] => JSON.parse(fs.readFileSync(configPath("resume.json"), "utf8"));

describe("turns carried on after a relaunch", () => {
  test("a turn is in the book from its start until its end", () => {
    markResume("a");
    markResume("b");
    markResume("a");
    expect(book()).toEqual(["a", "b"]);
    clearResume("a");
    expect(book()).toEqual(["b"]);
  });

  test("Home is never carried on", () => {
    markResume("home");
    expect(book()).toEqual(["b"]);
  });

  test("once the server is closing, turns ending with it leave the book alone", () => {
    freezeResume();
    clearResume("b");
    markResume("c");
    expect(book()).toEqual(["b"]);
  });
});
