import { describe, expect, test } from "bun:test";
import type { ServerContext } from "./context.js";
import { autoCompactDue } from "./dispatch.js";

/** A chat on `harness` whose context holds `tokens` of a `window`. */
function chatAt(
  tokens: number,
  options: { harness?: string; window?: number; prefs?: Record<string, string>; agents?: number } = {},
): ServerContext {
  const session = { id: "c1", model: "m" };
  const project = { id: "p", name: "demo", path: "/tmp/demo", sessions: [session] };
  return {
    store: {
      findSession: (id: string) => (id === "c1" ? { project, session } : undefined),
      defaultModel: () => "m",
    },
    prefs: { all: () => options.prefs ?? {} },
    turns: { contexts: new Map([["c1", { tokens, window: options.window ?? 200_000 }]]) },
    archive: {
      contextTokens: () => tokens,
      contextWindowOf: () => options.window ?? 200_000,
    },
    models: { windows: new Map() },
    manager: {
      harnessFor: () => options.harness ?? "claude",
      backgroundWork: () => ({ agents: options.agents ?? 0, scripts: 0 }),
    },
  } as unknown as ServerContext;
}

describe("ruri compacts a chat before its harness would", () => {
  test("past its harness's share of the window, at a turn's end", () => {
    expect(autoCompactDue(chatAt(150_000), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(165_000), "c1")).toContain("reached 83% of 200k");
    // Gemini CLI compresses at seven tenths: ruri goes first
    expect(autoCompactDue(chatAt(125_000, { harness: "gemini" }), "c1")).toContain("63%");
    expect(autoCompactDue(chatAt(125_000, { harness: "codex" }), "c1")).toBeUndefined();
    // a million-token window
    expect(autoCompactDue(chatAt(500_000, { window: 1_000_000 }), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(820_000, { window: 1_000_000 }), "c1")).toContain("of 1M");
  });

  test("never while an agent the session started is still running, nor when the user turned it off", () => {
    expect(autoCompactDue(chatAt(190_000, { agents: 1 }), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(190_000, { prefs: { "ruri-auto-compact": "off" } }), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(190_000), "nobody")).toBeUndefined();
  });
});
