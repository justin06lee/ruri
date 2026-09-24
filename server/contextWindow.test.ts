import { describe, expect, test } from "bun:test";
import { mainWindow } from "./sessions.js";

/**
 * The window a Claude chat's gauge measures against comes from the CLI's own
 * account of the turn — not from a "[1m]" in the id, which the plain models
 * no longer need to get the million-token window.
 */
describe("mainWindow", () => {
  test("the main loop's model, however the result spells it", () => {
    const usage = {
      "claude-opus-5-5[1m]": { contextWindow: 1_000_000 },
      "claude-haiku-4-5-20251001": { contextWindow: 200_000 },
    };
    expect(mainWindow(usage, "claude-opus-5-5")).toBe(1_000_000);
    expect(mainWindow({ "claude-opus-5-5": { contextWindow: 1_000_000 } }, "claude-opus-5-5")).toBe(
      1_000_000,
    );
    // a subagent's smaller model is not the chat's window
    expect(mainWindow(usage, "claude-haiku-4-5-20251001")).toBe(200_000);
  });

  test("with no main-loop call to go by, only a result naming one model says", () => {
    expect(mainWindow({ "claude-opus-5-5": { contextWindow: 1_000_000 } }, undefined)).toBe(1_000_000);
    expect(mainWindow({ a: { contextWindow: 1 }, b: { contextWindow: 2 } }, undefined)).toBeUndefined();
  });

  test("nothing reported is nothing", () => {
    expect(mainWindow(undefined, "claude-opus-5-5")).toBeUndefined();
    expect(mainWindow({ "claude-opus-5-5": {} }, "claude-opus-5-5")).toBeUndefined();
    expect(mainWindow({ "claude-opus-5-5": { contextWindow: 0 } }, "claude-opus-5-5")).toBeUndefined();
  });
});
