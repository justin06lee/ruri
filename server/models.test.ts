import { describe, expect, test } from "bun:test";
import type { ModelChoice, ServerMessage } from "../shared/protocol.js";
import { Models } from "./models.js";

/** A Models whose probe answers with `claude` rather than asking the CLIs. */
function models(claude: ModelChoice[]): { models: Models; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const m = new Models((message) => sent.push(message));
  m.registry = {
    modelChoices: async () => ({ claude, harnesses: [] }),
  } as unknown as Models["registry"];
  return { models: m, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Claude's model names", () => {
  test("a live session's bare family names take the catalog's versions when it lands after them", async () => {
    const { models: m, sent } = models([
      { value: "opus", displayName: "Opus 5.5" },
      { value: "haiku", displayName: "Haiku 4.5" },
    ]);
    // the Home session reports first, as it does when a slow harness holds
    // the probe up
    m.report([
      { value: "opus", displayName: "Opus" },
      { value: "haiku", displayName: "Haiku" },
    ]);
    expect(m.claudeModels.map((x) => x.displayName)).toEqual(["Opus", "Haiku"]);
    m.probeModels();
    await settle();
    expect(m.claudeModels.map((x) => x.displayName)).toEqual(["Opus 5.5", "Haiku 4.5"]);
    const last = sent.at(-1);
    expect(last?.type === "models" && last.models.find((x) => x.value === "opus")?.displayName).toBe(
      "Opus 5.5",
    );
  });

  test("a live list landing after the catalog borrows its names", async () => {
    const { models: m } = models([{ value: "opus", displayName: "Opus 5.5" }]);
    m.probeModels();
    await settle();
    m.report([{ value: "opus", displayName: "Opus" }]);
    expect(m.claudeModels.map((x) => x.displayName)).toEqual(["Opus 5.5"]);
  });

  test("a model the catalog doesn't know keeps the name it came with", async () => {
    const { models: m } = models([{ value: "opus", displayName: "Opus 5.5" }]);
    m.report([
      { value: "opus", displayName: "Opus" },
      { value: "claude-opus-4-8", displayName: "Opus 4.8" },
    ]);
    m.probeModels();
    await settle();
    expect(m.claudeModels.map((x) => x.displayName)).toEqual(["Opus 5.5", "Opus 4.8"]);
  });
});
