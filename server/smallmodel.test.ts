import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { quietCodex } from "./smallmodel.js";

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
    expect(said.trim()).toBe("exec --ignore-user-config --json -m gpt-5.6-luna -");
  });

  test("anything else goes to codex as it was", () => {
    const said = execFileSync(quietCodex()!, ["app-server"], { encoding: "utf8" });
    expect(said.trim()).toBe("app-server");
  });

  test("arguments with spaces arrive whole", () => {
    const said = execFileSync(quietCodex()!, ["exec", "-c", 'model_reasoning_effort="low"', "a b"], {
      encoding: "utf8",
    });
    expect(said.trim()).toBe('exec --ignore-user-config -c model_reasoning_effort="low" a b');
  });
});
