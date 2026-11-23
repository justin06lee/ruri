import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelChoice } from "../shared/protocol.js";
import { ProjectStore } from "./projects.js";

let dir = "";
let saved: string | undefined;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-catalog-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});

afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The catalog one day, with Fable under its versioned id… */
const BEFORE: ModelChoice[] = [
  { value: "opus", displayName: "Opus 5.5", providerDefault: true },
  { value: "claude-fable-5-2", displayName: "Fable 5.2" },
  { value: "haiku", displayName: "Haiku 5.5" },
];
/** …and the next, with the same model under its alias. */
const AFTER: ModelChoice[] = [
  { value: "opus", displayName: "Opus 5.5", providerDefault: true },
  { value: "fable", displayName: "Fable 5.2" },
  { value: "haiku", displayName: "Haiku 5.5" },
];

describe("a model the catalog lists under another id", () => {
  test("keeps its star and its roles, under the id it is listed by now", () => {
    const store = new ProjectStore();
    store.setCatalog(BEFORE);
    store.cycleModelStar("claude-fable-5-2");
    store.cycleModelStar("haiku");
    store.setDefaultModel("claude-fable-5-2");
    expect(store.defaultModel()).toBe("claude-fable-5-2");

    expect(store.setCatalog(AFTER)).toBe(true);
    expect(store.defaultModel()).toBe("fable");
    expect(store.starredModels()).toEqual(["fable", "haiku"]);
    // and it holds across a restart
    expect(new ProjectStore().defaultModel()).toBe("fable");
  });

  test("and nothing moves while every star and role is still listed", () => {
    const store = new ProjectStore();
    expect(store.setCatalog(AFTER)).toBe(false);
    expect(store.starredModels()).toEqual(["fable", "haiku"]);
  });
});
