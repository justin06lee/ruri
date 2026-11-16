import { describe, expect, test } from "bun:test";
import { catalogDefault, compareVersions, modelLine, newestInLine, supersededBy } from "./modelLine.js";
import type { ModelChoice } from "./protocol.js";

/** Claude's catalog as its CLI lists it: aliases named by what they
 *  resolve to, and versioned ids beside them. */
const CATALOG: ModelChoice[] = [
  { value: "opus", displayName: "Opus 5.5", providerDefault: true },
  { value: "claude-fable-5-2", displayName: "Fable 5.2" },
  { value: "sonnet", displayName: "Sonnet 5.5" },
  { value: "haiku", displayName: "Haiku 5.5" },
  { value: "fable", displayName: "Fable 5.1" },
  { value: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  { value: "claude-opus-5", displayName: "Opus 5" },
  { value: "claude-fable-5", displayName: "Fable 5" },
  { value: "claude-opus-4-8", displayName: "Opus 4.8" },
  { value: "codex:gpt-5.6-luna", displayName: "GPT-5.6 Luna", provider: "codex", providerLabel: "Codex" },
  { value: "codex:gpt-5.6-sol", displayName: "GPT-5.6 Sol", provider: "codex", providerLabel: "Codex" },
];

describe("a model's line and its version", () => {
  test("read off the id, whatever the harness spells it like", () => {
    expect(modelLine({ value: "claude-fable-5-2", displayName: "" })).toEqual({
      line: "fable",
      version: [5, 2],
    });
    expect(modelLine({ value: "claude-opus-4-8", displayName: "" })).toEqual({
      line: "opus",
      version: [4, 8],
    });
    expect(modelLine({ value: "codex:gpt-5.6-luna", displayName: "" })).toEqual({
      line: "codex:gpt-luna",
      version: [5, 6],
    });
    expect(modelLine({ value: "gemini:gemini-3-pro", displayName: "" })).toEqual({
      line: "gemini:gemini-pro",
      version: [3],
    });
    expect(modelLine({ value: "opencode:google/gemini-3-pro", displayName: "" }).line).toBe(
      "opencode:google/gemini-pro",
    );
  });

  test("a build date is not a version, and a million-token variant is its own line", () => {
    expect(modelLine({ value: "claude-haiku-4-5-20251001", displayName: "" })).toEqual({
      line: "haiku",
      version: [4, 5],
    });
    expect(modelLine({ value: "claude-fable-5-1[1m]", displayName: "" })).toEqual({
      line: "fable[1m]",
      version: [5, 1],
    });
  });

  test("an alias takes its version from the name the catalog gives it", () => {
    expect(modelLine({ value: "opus", displayName: "Opus 5.5" })).toEqual({ line: "opus", version: [5, 5] });
    expect(modelLine({ value: "sonnet", displayName: "Sonnet" })).toEqual({ line: "sonnet", version: [] });
  });

  test("a longer version is later than the one it begins with", () => {
    expect(compareVersions([5, 2], [5, 1])).toBeGreaterThan(0);
    expect(compareVersions([5, 1], [5])).toBeGreaterThan(0);
    expect(compareVersions([4, 8], [5])).toBeLessThan(0);
    expect(compareVersions([5, 5], [5, 5])).toBe(0);
  });
});

describe("the newest of a line", () => {
  test("is whichever the catalog lists at the highest version — an alias or an id", () => {
    // the alias lags behind the id here, as Claude's `fable` did behind 5.2
    expect(newestInLine(CATALOG, "fable")).toBe("claude-fable-5-2");
    expect(newestInLine(CATALOG, "claude-fable-5")).toBe("claude-fable-5-2");
    expect(newestInLine(CATALOG, "claude-fable-5-2")).toBe("claude-fable-5-2");
    expect(newestInLine(CATALOG, "claude-opus-4-8")).toBe("opus");
    expect(newestInLine(CATALOG, "claude-haiku-4-5-20251001")).toBe("haiku");
  });

  test("never another line's, another harness's, or a guess", () => {
    expect(newestInLine(CATALOG, "codex:gpt-5.6-luna")).toBe("codex:gpt-5.6-luna");
    expect(newestInLine(CATALOG, "codex:gpt-5.6-sol")).toBe("codex:gpt-5.6-sol");
    // one the catalog doesn't hold follows its line if the line is there
    expect(newestInLine(CATALOG, "claude-fable-4-9")).toBe("claude-fable-5-2");
    expect(newestInLine(CATALOG, "codex:gpt-5.1-luna")).toBe("codex:gpt-5.6-luna");
    // and stays itself when nothing says where it stands
    expect(newestInLine(CATALOG, "mystery")).toBe("mystery");
    expect(newestInLine(CATALOG, "claude-fable-5-1[1m]")).toBe("claude-fable-5-1[1m]");
  });
});

describe("a newer model arriving", () => {
  const known = CATALOG.map((m) => m.value);
  const withNew: ModelChoice[] = [
    { value: "claude-fable-5-3", displayName: "Fable 5.3" },
    { value: "codex:gpt-5.7-luna", displayName: "GPT-5.7 Luna", provider: "codex" },
    ...CATALOG,
  ];

  test("takes the place of what was the newest of its line", () => {
    expect(supersededBy(withNew, known, "claude-fable-5-3")).toBe("claude-fable-5-2");
    expect(supersededBy(withNew, known, "codex:gpt-5.7-luna")).toBe("codex:gpt-5.6-luna");
  });

  test("but an older one listed late, or the first of a line, takes nobody's", () => {
    const late = [...withNew, { value: "claude-fable-4-9", displayName: "Fable 4.9" }];
    expect(supersededBy(late, known, "claude-fable-4-9")).toBeUndefined();
    const first = [...CATALOG, { value: "claude-mythos-1", displayName: "Mythos 1" }];
    expect(supersededBy(first, known, "claude-mythos-1")).toBeUndefined();
  });
});

describe("what the catalog itself starts a chat on", () => {
  test("the one Claude Code marks its default, else its first; another harness's only with no Claude", () => {
    expect(catalogDefault(CATALOG)).toBe("opus");
    expect(catalogDefault(CATALOG.map(({ providerDefault: _d, ...m }) => m))).toBe("opus");
    expect(catalogDefault(CATALOG.slice(1))).toBe("claude-fable-5-2");
    expect(catalogDefault(CATALOG.filter((m) => m.provider))).toBe("codex:gpt-5.6-luna");
    expect(catalogDefault([])).toBeUndefined();
  });
});
