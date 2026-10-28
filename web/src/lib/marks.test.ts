import { describe, expect, test } from "bun:test";
import { labFromName, markFor } from "./marks";

const lab = (model: string, choice?: { provider?: string; displayName: string }) =>
  markFor(model, choice).lab;

describe("markFor", () => {
  test("Claude's bare ids and aliases are Anthropic's, on Claude's harness", () => {
    for (const id of [
      "claude-opus-5-5",
      "claude-opus-5-5[1m]",
      "claude-sonnet-5",
      "opus",
      "sonnet",
      "haiku",
      "fable",
    ]) {
      expect(markFor(id)).toMatchObject({ lab: "anthropic", harness: "claude" });
    }
    expect(markFor("claude-fable-5-1", { displayName: "Fable 5.1" })).toEqual({
      lab: "anthropic",
      harness: "claude",
      name: "Fable 5.1",
    });
  });

  test("Codex's models are OpenAI's, whatever they are called", () => {
    expect(markFor("codex:gpt-6-astra", { provider: "codex", displayName: "GPT-6-Astra" })).toEqual({
      lab: "openai",
      harness: "codex",
      name: "GPT-6-Astra",
    });
    expect(lab("codex:gpt-5.6-sol")).toBe("openai");
    expect(lab("codex:o3")).toBe("openai");
    // a name that gives nothing away still runs on OpenAI's own harness
    expect(lab("codex:astra-preview", { provider: "codex", displayName: "Astra Preview" })).toBe("openai");
    // the harness's bare entry, when it named no models
    expect(markFor("codex", { provider: "codex", displayName: "Codex CLI" })).toMatchObject({
      lab: "openai",
      harness: "codex",
    });
  });

  test("OpenCode's provider segment names the lab when it is one", () => {
    expect(lab("opencode:anthropic/claude-sonnet-5")).toBe("anthropic");
    expect(lab("opencode:google/gemini-3-pro")).toBe("google");
    expect(lab("opencode:openai/gpt-6")).toBe("openai");
    expect(lab("opencode:xai/grok-5")).toBe("xai");
    expect(lab("opencode:zai-coding-plan/glm-5")).toBe("zhipu");
    expect(lab("opencode:moonshotai/kimi-k3")).toBe("moonshot");
    expect(lab("opencode:mistral/devstral-2")).toBe("mistral");
    // a provider that names the lab beats a name that looks like another's
    expect(lab("opencode:google-vertex-anthropic/sonnet-5")).toBe("anthropic");
    // routers put the lab one segment further in
    expect(lab("opencode:openrouter/deepseek/deepseek-v4")).toBe("deepseek");
  });

  test("a gateway serving other labs' models is read by the model's name", () => {
    expect(
      markFor("opencode:opencode/muse-spark-1.3-contributor-free", {
        provider: "opencode",
        displayName: "Muse Spark 1.3 Contributor Free",
      }),
    ).toEqual({ lab: "meta", harness: "opencode", name: "Muse Spark 1.3 Contributor Free" });
    expect(lab("opencode:opencode/qwen3.5-coder")).toBe("alibaba");
    expect(lab("opencode:github-copilot/claude-opus-5")).toBe("anthropic");
    expect(lab("opencode:groq/llama-4-scout")).toBe("meta");
    expect(lab("opencode:opencode/minimax-m3")).toBe("minimax");
  });

  test("gemini and goose, and the harnesses that only run their maker's models", () => {
    expect(markFor("gemini:gemini-3-pro")).toMatchObject({ lab: "google", harness: "gemini" });
    expect(lab("gemini:auto", { provider: "gemini", displayName: "Auto" })).toBe("google");
    expect(lab("goose:claude-sonnet-5")).toBe("anthropic");
    expect(lab("goose:gpt-6")).toBe("openai");
    expect(lab("qwen:coder-model", { provider: "qwen", displayName: "Coder Model" })).toBe("alibaba");
    expect(lab("kimi:default", { provider: "kimi", displayName: "Default" })).toBe("moonshot");
    expect(lab("grok:build", { provider: "grok", displayName: "Build" })).toBe("xai");
  });

  test("nothing to go on: no lab, the harness and the name to letter", () => {
    expect(
      markFor("opencode:opencode/big-pickle", { provider: "opencode", displayName: "Big Pickle" }),
    ).toEqual({
      harness: "opencode",
      name: "Big Pickle",
    });
    expect(markFor("goose", { provider: "goose", displayName: "Goose" })).toEqual({
      harness: "goose",
      name: "Goose",
    });
    // before the catalog lands: the harness from the value itself
    expect(markFor("goose")).toEqual({ harness: "goose", name: "goose" });
    expect(markFor("cursor:auto")).toEqual({ harness: "cursor", name: "auto" });
  });
});

describe("labFromName", () => {
  test("each lab's families", () => {
    const cases: Array<[string, string | undefined]> = [
      ["Claude Opus 5.5", "anthropic"],
      ["gpt-oss-120b", "openai"],
      ["chatgpt-5-latest", "openai"],
      ["o4-mini", "openai"],
      ["gpt-5.1-codex-max", "openai"],
      ["gemini-3-flash", "google"],
      ["gemma-4-27b", "google"],
      ["grok-code-fast-2", "xai"],
      ["deepseek-r2", "deepseek"],
      ["kimi-k2-thinking", "moonshot"],
      ["moonshot-v1-128k", "moonshot"],
      ["qwen3-coder-480b", "alibaba"],
      ["qwq-32b", "alibaba"],
      ["glm-4.6", "zhipu"],
      ["z-ai-glm", "zhipu"],
      ["mistral-large-3", "mistral"],
      ["codestral-2", "mistral"],
      ["magistral-medium", "mistral"],
      ["llama-4-maverick", "meta"],
      ["muse-spark-1.3", "meta"],
      ["MiniMax-M2", "minimax"],
      ["big-pickle", undefined],
      ["auto", undefined],
      // an o and a digit inside a word is not OpenAI's o-series
      ["phi-4-reasoning-pro4", undefined],
    ];
    for (const [name, want] of cases) expect([name, labFromName(name)]).toEqual([name, want as never]);
  });
});
