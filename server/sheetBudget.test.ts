import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LayerSheet } from "../shared/protocol.js";
import { BriefStore } from "./brief.js";
import { repairSheets } from "./catchupBrief.js";
import type { ServerContext } from "./context.js";
import { describeJob, placeholderJob, sheetWords, withinBudget } from "./sheetBudget.js";

let dir: string;
let config: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-sheet-"));
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-sheet-config-"));
  process.env["RURI_CONFIG_DIR"] = config;
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(config, { recursive: true, force: true });
  delete process.env["RURI_CONFIG_DIR"];
});

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

const sheet = (extra: Partial<LayerSheet> = {}): LayerSheet => ({
  summary: "The chat window.",
  map: [],
  flows: [],
  files: [],
  rules: [],
  edges: [],
  ...extra,
});

describe("a sheet's budget", () => {
  test("is words across the sheet, and a long one gives up the last lines of its fullest sections", () => {
    const rules = Array.from({ length: 30 }, (_, i) => `rule ${i} ${"word ".repeat(20)}`.trim());
    const files = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts — does thing ${i}`);
    const big = sheet({ rules, files });
    expect(sheetWords(big)).toBeGreaterThan(600);
    const kept = withinBudget(big, 400);
    expect(sheetWords(kept)).toBeLessThanOrEqual(400);
    // the rules had the most to give; the first lines — the central ones — stay
    expect(kept.rules[0]).toBe(rules[0]);
    expect(kept.rules.length).toBeLessThan(rules.length);
    expect(kept.files.length).toBeGreaterThanOrEqual(6);
  });
});

describe("a key file's job", () => {
  test("the format's own words are no job", () => {
    for (const job of ["its job", "What it is for", "TBD", "…", "--"]) expect(placeholderJob(job)).toBe(true);
    expect(placeholderJob("the chat pane")).toBe(false);
  });

  test("what a file says it does, from its opening comment — not a licence, not code", () => {
    write(
      "a.ts",
      "/**\n * The conversations as the window shows them: messages built from turns.\n * More.\n */\nexport {};\n",
    );
    write("b.ts", '/** The main process, as the window sees it. */\nimport x from "y";\n');
    write("c.py", '"""Trains the policy with PPO. Second sentence."""\nimport torch\n');
    write("d.rs", "//! The scene graph, flattened for the renderer.\nuse bevy::prelude::*;\n");
    write("e.ts", 'import { a } from "b";\nexport const x = 1;\n');
    write("f.ts", "// Copyright 2026 Someone. MIT licence.\nexport {};\n");
    expect(describeJob(dir, "a.ts")).toBe(
      "The conversations as the window shows them: messages built from turns",
    );
    expect(describeJob(dir, "b.ts")).toBe("The main process, as the window sees it");
    expect(describeJob(dir, "c.py")).toBe("Trains the policy with PPO");
    expect(describeJob(dir, "d.rs")).toBe("The scene graph, flattened for the renderer");
    expect(describeJob(dir, "e.ts")).toBeUndefined();
    expect(describeJob(dir, "f.ts")).toBeUndefined();
    expect(describeJob(dir, "missing.ts")).toBeUndefined();
  });

  test("a sheet's placeholder lines are filled — from the file, then the model — or let go", async () => {
    write("web/chat.ts", "/** The chat pane: messages and the composer. */\nexport {};\n");
    write("web/App.tsx", 'import { Chat } from "./chat";\nexport function App() {}\n');
    write("web/gone.ts", 'import x from "y";\n');
    const briefs = new BriefStore();
    briefs.write(
      "p",
      {
        description: "demo",
        features: [],
        layers: [{ name: "UI", what: "the window", slug: "ui", paths: ["web/"] }],
      },
      true,
    );
    briefs.writeLayer(
      "p",
      "ui",
      sheet({
        files: [
          "web/chat.ts — its job",
          "web/App.tsx — its job",
          "web/gone.ts — its job",
          "web/x.ts — the real one",
        ],
      }),
    );
    const project = { id: "p", name: "demo", path: dir, sessions: [] };
    const ctx = {
      store: { get: () => project },
      briefs,
      clients: { broadcast: () => {} },
      manager: { statuses: () => ({}) },
      archive: { exchangeNo: () => undefined },
    } as unknown as ServerContext;
    let asked = "";
    const filled = await repairSheets(ctx, "p", async (_system, prompt) => {
      asked = prompt;
      return JSON.stringify({ jobs: { "web/App.tsx": "the window's frame: sidebar, chat and studio" } });
    });
    expect(filled).toBe(2);
    expect(asked).toContain("=== web/App.tsx");
    expect(asked).not.toContain("=== web/chat.ts");
    expect(briefs.get("p").layerSheets!["ui"]!.files).toEqual([
      "web/chat.ts — The chat pane: messages and the composer",
      "web/App.tsx — the window's frame: sidebar, chat and studio",
      "web/x.ts — the real one",
    ]);
  });
});
