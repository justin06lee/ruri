import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Yagami } from "@justin06lee/yagami";
import { quietCodex, sessionRoleTitle, setCompletionClient, summarizePrompt } from "./smallmodel.js";

describe("the small model's codex", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-small-"));
  const saved = { path: process.env["PATH"], config: process.env["RURI_CONFIG_DIR"] };

  beforeAll(() => {
    // a codex that says what it was asked to do
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), '#!/bin/sh\necho "$@"\n', { mode: 0o755 });
    process.env["PATH"] = `${bin}:${saved.path ?? ""}`;
    process.env["RURI_CONFIG_DIR"] = path.join(root, "config");
  });

  afterAll(() => {
    process.env["PATH"] = saved.path;
    if (saved.config === undefined) delete process.env["RURI_CONFIG_DIR"];
    else process.env["RURI_CONFIG_DIR"] = saved.config;
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("a completion runs without the user's config — none of its MCP servers start", () => {
    const wrapper = quietCodex()!;
    expect(wrapper.startsWith(path.join(root, "config"))).toBe(true);
    const said = execFileSync(wrapper, ["exec", "--json", "-m", "gpt-5.6-luna", "-"], { encoding: "utf8" });
    expect(said.trim().startsWith("exec --ignore-user-config ")).toBe(true);
    expect(said.trim().endsWith(" --json -m gpt-5.6-luna -")).toBe(true);
  });

  test("a completion has no tools, thinks briefly, and leaves no session file behind", () => {
    const said = execFileSync(quietCodex()!, ["exec", "-"], { encoding: "utf8" });
    expect(said).toContain(" --ephemeral ");
    expect(said).toContain('-c model_reasoning_effort="low"');
    expect(said).toContain("-c features.shell_tool=false");
    expect(said).toContain("-c features.unified_exec=false");
    // as config, not --disable, which a Codex that has retired the name refuses
    expect(said).not.toContain("--disable");
  });

  test("anything else goes to codex as it was", () => {
    const said = execFileSync(quietCodex()!, ["app-server"], { encoding: "utf8" });
    expect(said.trim()).toBe("app-server");
  });

  test("arguments with spaces arrive whole", () => {
    const said = execFileSync(quietCodex()!, ["exec", "-c", 'model_reasoning_effort="low"', "a b"], {
      encoding: "utf8",
    });
    expect(said.trim().endsWith(' -c model_reasoning_effort="low" a b')).toBe(true);
  });
});

describe("the small model's queue", () => {
  afterAll(() => setCompletionClient(null));

  test("what someone waits on goes first, and the background work takes one slot at most", async () => {
    // every call waits until let go, so what is running at once can be seen
    const started: string[] = [];
    const release: Array<() => void> = [];
    setCompletionClient({
      messages: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          started.push(messages[0]!.content.includes("FIRST PROMPT") ? "title" : "note");
          await new Promise<void>((resolve) => release.push(resolve));
          return { content: [{ type: "text", text: "Fine" }] };
        },
      },
    } as unknown as Yagami);
    const tick = () => new Promise((r) => setTimeout(r, 10));
    const notes = [summarizePrompt("one"), summarizePrompt("two"), summarizePrompt("three")];
    await tick();
    // three notes waiting: only one of them runs
    expect(started).toEqual(["note"]);
    const title = sessionRoleTitle({ turnId: "t", user: "fix the header", assistant: "", tools: [] });
    await tick();
    // the title doesn't wait behind the notes
    expect(started).toEqual(["note", "title"]);
    let done = false;
    const all = Promise.all([...notes, title]).then(() => {
      done = true;
    });
    for (let i = 0; i < 200 && !done; i++) {
      release.shift()?.();
      await tick();
    }
    await all;
    expect(started.filter((kind) => kind === "note").length).toBeGreaterThanOrEqual(3);
  });
});
