import { afterEach, beforeEach, expect, test } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { configDir, configPath } from "./configDir.js";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
afterEach(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

test("RURI_CONFIG_DIR is where everything goes", () => {
  process.env["RURI_CONFIG_DIR"] = "/tmp/ruri-elsewhere";
  expect(configDir()).toBe("/tmp/ruri-elsewhere");
  expect(configPath("sessions", "a.json")).toBe("/tmp/ruri-elsewhere/sessions/a.json");
});

test("without it, ~/.config/ruri", () => {
  delete process.env["RURI_CONFIG_DIR"];
  expect(configDir()).toBe(path.join(os.homedir(), ".config", "ruri"));
  expect(configPath("prefs.json")).toBe(path.join(os.homedir(), ".config", "ruri", "prefs.json"));
});

test("read on every call, so a variable set after import still counts", () => {
  delete process.env["RURI_CONFIG_DIR"];
  const before = configDir();
  process.env["RURI_CONFIG_DIR"] = "/tmp/ruri-later";
  expect(configDir()).toBe("/tmp/ruri-later");
  expect(configDir()).not.toBe(before);
});
