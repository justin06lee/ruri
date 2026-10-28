import { afterEach, describe, expect, test } from "bun:test";
import type { ServerContext } from "./context.js";
import { autoCompactDue, autoCompactPoint, softCompactTokens } from "./dispatch.js";

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

const savedSoft = process.env["RURI_COMPACT_SOFT_TOKENS"];
afterEach(() => {
  if (savedSoft === undefined) delete process.env["RURI_COMPACT_SOFT_TOKENS"];
  else process.env["RURI_COMPACT_SOFT_TOKENS"] = savedSoft;
});

describe("ruri compacts a chat before its harness would", () => {
  test("past its harness's share of the window, at a turn's end", () => {
    expect(autoCompactDue(chatAt(150_000), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(165_000), "c1")).toContain("reached 83% of 200k");
    // Gemini CLI compresses at seven tenths: ruri goes first
    expect(autoCompactDue(chatAt(125_000, { harness: "gemini" }), "c1")).toContain("63%");
    expect(autoCompactDue(chatAt(125_000, { harness: "codex" }), "c1")).toBeUndefined();
    // a million-token window, with the soft limit off
    process.env["RURI_COMPACT_SOFT_TOKENS"] = "off";
    expect(autoCompactDue(chatAt(500_000, { window: 1_000_000 }), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(820_000, { window: 1_000_000 }), "c1")).toContain("of 1M");
  });

  test("never while an agent the session started is still running, nor when the user turned it off", () => {
    expect(autoCompactDue(chatAt(190_000, { agents: 1 }), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(190_000, { prefs: { "ruri-auto-compact": "off" } }), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(190_000), "nobody")).toBeUndefined();
  });
});

describe("the soft limit", () => {
  test("434k unless the env or the preference says otherwise, or off", () => {
    delete process.env["RURI_COMPACT_SOFT_TOKENS"];
    expect(softCompactTokens(chatAt(0))).toBe(434_000);
    expect(softCompactTokens(chatAt(0, { prefs: { "ruri-compact-soft-tokens": "300k" } }))).toBe(300_000);
    expect(softCompactTokens(chatAt(0, { prefs: { "ruri-compact-soft-tokens": "nonsense" } }))).toBe(434_000);
    process.env["RURI_COMPACT_SOFT_TOKENS"] = "250000";
    expect(softCompactTokens(chatAt(0, { prefs: { "ruri-compact-soft-tokens": "300k" } }))).toBe(250_000);
    process.env["RURI_COMPACT_SOFT_TOKENS"] = "off";
    expect(softCompactTokens(chatAt(0))).toBeUndefined();
  });

  test("whichever comes first: within 5% of the soft limit, or the harness's share of the window", () => {
    delete process.env["RURI_COMPACT_SOFT_TOKENS"];
    // a 1M window: 412k (5% under 434k) comes before 800k
    expect(autoCompactPoint(chatAt(0, { window: 1_000_000 }), "c1")).toEqual({ tokens: 412_300, soft: 434_000 });
    // a 200k window: its 160k comes first
    expect(autoCompactPoint(chatAt(0), "c1")).toEqual({ tokens: 160_000 });
    expect(autoCompactDue(chatAt(165_000), "c1")).toContain("83% of 200k");
    expect(autoCompactDue(chatAt(400_000, { window: 1_000_000 }), "c1")).toBeUndefined();
    expect(autoCompactDue(chatAt(415_000, { window: 1_000_000 }), "c1")).toBe(
      "the context reached 415k, near ruri's 434k soft limit — handing off: ruri compacted it, keeping every prompt word for word and every exchange on file",
    );
    // still off with ruri's compaction, and never with an agent running
    expect(
      autoCompactDue(chatAt(500_000, { window: 1_000_000, prefs: { "ruri-auto-compact": "off" } }), "c1"),
    ).toBeUndefined();
    expect(autoCompactDue(chatAt(500_000, { window: 1_000_000, agents: 1 }), "c1")).toBeUndefined();
  });

  test("a chat climbing past it is compacted once, at the turn's end, and its fresh session carries on", () => {
    delete process.env["RURI_COMPACT_SOFT_TOKENS"];
    const ctx = chatAt(0, { window: 1_000_000 });
    const contexts = (ctx.turns as unknown as { contexts: Map<string, { tokens: number }> }).contexts;
    let compactions = 0;
    // each turn's end reads the context as the turn left it; a compaction
    // leaves the fresh session with its brief
    for (const tokens of [120_000, 260_000, 390_000, 420_000, 40_000, 90_000, 150_000]) {
      contexts.set("c1", { tokens });
      if (autoCompactDue(ctx, "c1")) {
        compactions += 1;
        contexts.set("c1", { tokens: 0 });
        expect(autoCompactDue(ctx, "c1")).toBeUndefined();
      }
    }
    expect(compactions).toBe(1);
  });
});
