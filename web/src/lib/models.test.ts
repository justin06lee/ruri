import { describe, expect, test } from "bun:test";
import type { ModelChoice } from "../../../shared/protocol";
import { harnessName, roughName } from "./models";

const catalog: ModelChoice[] = [
  { value: "opus", displayName: "Opus 5" },
  { value: "codex:gpt-5.6-sol", displayName: "GPT-5.6-Sol", provider: "codex", providerLabel: "Codex CLI" },
];

describe("harnessName", () => {
  test("the harness the channel's model runs on", () => {
    expect(harnessName(catalog, "codex:gpt-5.6-sol", "opus")).toBe("Codex CLI");
  });

  test("an unset model means the fallback's harness", () => {
    expect(harnessName(catalog, undefined, "codex:gpt-5.6-sol")).toBe("Codex CLI");
    expect(harnessName(catalog, "", "codex:gpt-5.6-sol")).toBe("Codex CLI");
  });

  test("a Claude model, or one the catalog has not described, is Claude", () => {
    expect(harnessName(catalog, "opus", "opus")).toBe("Claude");
    expect(harnessName(catalog, "who-knows", "opus")).toBe("Claude");
    expect(harnessName([], undefined, "opus")).toBe("Claude");
  });
});

describe("roughName", () => {
  test("family and version out of a Claude id", () => {
    expect(roughName("claude-fable-5-1[1m]")).toBe("Fable 5.1");
    expect(roughName("claude-opus-4-5-20251101")).toBe("Opus 4.5");
    expect(roughName("claude-haiku-4")).toBe("Haiku 4");
  });

  test("a bare family alias", () => {
    expect(roughName("opus")).toBe("Opus");
    expect(roughName("sonnet[1m]")).toBe("Sonnet");
  });

  test("anything it cannot read is left as the id", () => {
    expect(roughName("codex:gpt-5.6-sol")).toBe("codex:gpt-5.6-sol");
    expect(roughName("GPT-5")).toBe("GPT-5");
    expect(roughName("")).toBe("");
  });
});
