import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { channelOf, older, versionFromPath } from "./updater.js";

describe("how a harness was installed, from where it lives", () => {
  test("each install is updated the way it came", () => {
    expect(channelOf("/Users/a/.local/share/claude/versions/2.1.278")).toEqual({
      channel: "self",
      pkg: "@anthropic-ai/claude-code",
    });
    expect(channelOf("/Volumes/T7/Stockpile/.opencode/bin/opencode")).toEqual({
      channel: "self",
      pkg: "opencode-ai",
    });
    expect(
      channelOf("/Volumes/T7/Stockpile/.bun/install/global/node_modules/@openai/codex/bin/codex.js"),
    ).toEqual({ channel: "bun", pkg: "@openai/codex" });
    expect(channelOf("/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini.js")).toEqual({
      channel: "npm",
      pkg: "@google/gemini-cli",
    });
    expect(channelOf("/opt/homebrew/Cellar/goose/3.28.0/bin/goose")).toEqual({
      channel: "brew",
      pkg: "goose",
    });
    expect(channelOf("/usr/local/bin/some-agent")).toEqual({ channel: "other" });
  });
});

describe("its version, without running it", () => {
  test("claude's versions dir, brew's cellar", () => {
    expect(versionFromPath("self", "/Users/a/.local/share/claude/versions/2.1.278")).toBe("2.1.278");
    expect(versionFromPath("brew", "/opt/homebrew/Cellar/goose/3.28.0/bin/goose", "goose")).toBe("3.28.0");
  });

  test("a global package's own package.json", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-upd-"));
    const pkg = path.join(root, "lib", "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.154.0" }));
    expect(versionFromPath("npm", path.join(pkg, "bin", "codex.js"), "@openai/codex")).toBe("0.154.0");
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("which of two versions is older", () => {
  test("by the numbers, not the letters", () => {
    expect(older("2.1.9", "2.1.10")).toBe(true);
    expect(older("2.1.10", "2.1.9")).toBe(false);
    expect(older("1.0.0", "1.0.0")).toBe(false);
    expect(older("1.0.0-beta.1", "1.0.0")).toBe(true);
    expect(older("0.154.0", "0.160.1")).toBe(true);
  });
});
