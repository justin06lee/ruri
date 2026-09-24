import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ownsSummary, type LayerSheet, type StackLayer, type TranscriptEvent } from "../shared/protocol.js";
import {
  architectureText,
  BriefStore,
  layerOfFile,
  layerText,
  slugLayers,
  stackBriefing,
  writeBriefFiles,
} from "./brief.js";
import { sessionBriefing } from "./briefing.js";
import { placeUnowned } from "./catchup.js";
import { foldLayers } from "./events.js";
import { setCompletionClient } from "./smallmodel.js";
import type { ServerContext } from "./context.js";
import { runMemoryCommand } from "./memoryCli.js";
import type { SecretStore } from "./secrets.js";
import type { Yagami } from "@justin06lee/yagami";

let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-layers-"));
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

const stack: StackLayer[] = [
  { name: "UI", what: "React + Vite", paths: ["web/src/"] },
  { name: "Bridge", what: "hidden browser and native apps", paths: ["server/bridge.ts", "server/cdp.ts"] },
  { name: "Backend", what: "Node server", paths: ["server/"] },
  { name: "Runtime", what: "macOS, Bun" },
];

const bridgeSheet: LayerSheet = {
  summary: "Drives a hidden browser over CDP and native apps over Accessibility.",
  map: [{ name: "screenshots", files: ["server/bridge.ts"] }],
  flows: [{ name: "a click", steps: ["web_click", "server/bridge.ts", "CDP"] }],
  files: ["server/bridge.ts — the tools a session holds"],
  rules: ["never show the window unless the user takes it over"],
  edges: ["Backend — every call arrives through the session's MCP server"],
};

describe("the stack as an index", () => {
  test("every layer gets a handle, and keeps it when the model renames it", () => {
    const first = slugLayers(stack);
    expect(first.map((l) => l.slug)).toEqual(["ui", "bridge", "backend", "runtime"]);
    const renamed = slugLayers(
      [{ name: "Browser bridge", what: "", paths: ["server/bridge.ts", "server/cdp.ts"] }, ...first.slice(2)],
      first,
    );
    expect(renamed[0]!.slug).toBe("bridge");
    // two layers wanting one handle don't share it
    expect(
      slugLayers([
        { name: "UI", what: "" },
        { name: "ui", what: "" },
      ]).map((l) => l.slug),
    ).toEqual(["ui", "ui-2"]);
  });

  test("a file belongs to the layer owning it by the longest path", () => {
    expect(layerOfFile(stack, "server/bridge.ts")?.name).toBe("Bridge");
    expect(layerOfFile(stack, "server/sessions.ts")?.name).toBe("Backend");
    expect(layerOfFile(stack, "web/src/components/App.tsx")?.name).toBe("UI");
    expect(layerOfFile(stack, "server/bridge.tsx")?.name).toBe("Backend");
    expect(layerOfFile(stack, "docs/features.md")).toBeUndefined();
  });

  test("a layer's sheet is kept by its handle, corrected line by line, and goes when its layer does", () => {
    const briefs = new BriefStore();
    briefs.write("p", { description: "d", features: [], layers: stack }, true);
    briefs.writeLayer("p", "bridge", bridgeSheet);
    expect(briefs.get("p").layerSheets?.["bridge"]?.updated).toBeGreaterThan(0);
    // no layer, no sheet
    briefs.writeLayer("p", "nothing-here", bridgeSheet);
    expect(Object.keys(briefs.get("p").layerSheets ?? {})).toEqual(["bridge"]);

    briefs.correctLayer("p", "bridge", "rules", 0, "the window stays hidden");
    briefs.correctLayer("p", "bridge", "map", 0, "clicks — server/bridge.ts, server/cdp.ts");
    briefs.correctLayer("p", "bridge", "summary", 0, "The bridge.");
    const sheet = briefs.get("p").layerSheets!["bridge"]!;
    expect(sheet.rules).toEqual(["the window stays hidden"]);
    expect(sheet.map).toEqual([{ name: "clicks", files: ["server/bridge.ts", "server/cdp.ts"] }]);
    expect(sheet.summary).toBe("The bridge.");
    expect(briefs.correctLayer("p", "bridge", "map", 0, "no dash here")).toBeNull();

    // a reload keeps it
    expect(new BriefStore().get("p").layerSheets?.["bridge"]?.summary).toBe("The bridge.");

    // the model's next index drops the bridge layer: its sheet goes with it
    briefs.write("p", { description: "d", features: [], layers: stack.filter((l) => l.name !== "Bridge") });
    expect(briefs.get("p").layerSheets).toBeUndefined();
  });

  test("architecture.md becomes the index: layers point at their sheets, the map is theirs", () => {
    const briefs = new BriefStore();
    briefs.write(
      "p",
      {
        description: "A desktop app.",
        features: [],
        layers: stack,
        map: [{ name: "old map entry", files: ["server/x.ts"] }],
      },
      true,
    );
    const older = architectureText("demo", briefs.get("p"));
    expect(older).toContain("## Where to change what");
    expect(stackBriefing(briefs.get("p"))).toBe("");

    const brief = briefs.writeLayer("p", "bridge", bridgeSheet);
    const index = architectureText("demo", brief);
    expect(index).not.toContain("## Where to change what");
    expect(index).toContain("This is the index");
    expect(index).toContain(
      "2. **Bridge** — hidden browser and native apps (`server/ · 2 files`) → `.ruri/layers/bridge.md`",
    );
    // a layer without a sheet points nowhere
    expect(index).toContain("1. **UI** — React + Vite (`web/src/`)\n");
    expect(stackBriefing(brief)).toBe(
      "1. UI — React + Vite\n2. Bridge (bridge) — hidden browser and native apps\n3. Backend — Node server\n4. Runtime — macOS, Bun",
    );
  });

  test("a layer's sheet reads where to change what first, then how it works, files, rules, edges", () => {
    const text = layerText("demo", { ...stack[1]!, slug: "bridge" }, bridgeSheet);
    expect(text).toContain("# demo — Bridge");
    expect(text).toContain("owning `server/bridge.ts, server/cdp.ts`");
    const order = [
      "## Where to change what",
      "## How it works",
      "## Key files",
      "## Rules and traps",
      "## What it talks to",
    ];
    const at = order.map((h) => text.indexOf(h));
    expect(at.every((i) => i > 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(text).toContain("- **a click:** web_click → server/bridge.ts → CDP");
  });

  test("each layer's sheet lands in .ruri/layers/, and a layer that went takes its file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-layers-project-"));
    fs.mkdirSync(path.join(dir, "server"), { recursive: true });
    fs.writeFileSync(path.join(dir, "server", "bridge.ts"), "x");
    const briefs = new BriefStore();
    briefs.write("p", { description: "d", features: [], layers: stack }, true);
    briefs.writeLayer("p", "backend", { ...bridgeSheet, map: [] });
    writeBriefFiles(dir, "demo", briefs.writeLayer("p", "bridge", bridgeSheet));
    expect(fs.readdirSync(path.join(dir, ".ruri", "layers")).sort()).toEqual(["backend.md", "bridge.md"]);
    // the map only names files still there
    expect(fs.readFileSync(path.join(dir, ".ruri", "layers", "bridge.md"), "utf8")).toContain(
      "**screenshots:** server/bridge.ts",
    );
    const without = briefs.write("p", {
      description: "d",
      features: [],
      layers: stack.filter((l) => l.name !== "Backend"),
    });
    writeBriefFiles(dir, "demo", without);
    expect(fs.readdirSync(path.join(dir, ".ruri", "layers"))).toEqual(["bridge.md"]);
  });
});

describe("a layer's line in the stack", () => {
  test("says its folders and how many files, not every path", () => {
    expect(ownsSummary(["web/src/"])).toBe("web/src/");
    expect(ownsSummary(["server/bridge.ts"])).toBe("server/bridge.ts");
    expect(ownsSummary(["server/a.ts", "server/b.ts", "server/handlers/c.ts"])).toBe(
      "server/, server/handlers/ · 3 files",
    );
    expect(ownsSummary(["a/x.ts", "b/x.ts", "c/x.ts", "d/x.ts", "e/"])).toBe("a/, b/, c/ +2 · 4 files");
  });
});

describe("what a session is shown", () => {
  test("the stack rides in the briefing, with how to read a layer", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-layers-brief-"));
    fs.mkdirSync(path.join(dir, ".ruri"));
    fs.writeFileSync(path.join(dir, ".ruri", "catchup.md"), "x");
    const secrets = { briefing: () => "" } as unknown as SecretStore;
    const briefs = new BriefStore();
    briefs.write("p", { description: "d", features: [], layers: stack }, true);
    const brief = briefs.writeLayer("p", "bridge", bridgeSheet);
    const text = (stackText: string) =>
      sessionBriefing({
        projectDir: dir,
        projectName: "demo",
        secrets,
        claude: true,
        naming: "",
        stack: stackText,
      });
    const shown = text(stackBriefing(brief));
    expect(shown).toContain("demo's stack, top to bottom");
    expect(shown).toContain("`ruri layer <handle>`");
    expect(shown).toContain(`${path.join(dir, ".ruri", "layers")}/<handle>.md`);
    expect(shown).toContain("2. Bridge (bridge) — hidden browser and native apps");
    expect(text("")).not.toContain("stack, top to bottom. Each layer");
  });
});

describe("ruri layer", () => {
  const CHAT = "c0ffee11-2222-3333-4444-555566667777";
  let ctx: ServerContext;
  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-layers-cli-"));
    const session = { id: CHAT, title: "Bridge work" };
    const project = { id: "p", name: "demo", path: dir, sessions: [session] };
    const briefs = new BriefStore();
    briefs.write("p", { description: "d", features: [], layers: stack }, true);
    briefs.writeLayer("p", "bridge", bridgeSheet);
    ctx = {
      store: {
        findSession: (id: string) => (id === CHAT ? { project, session } : undefined),
        get: (id: string) => (id === "p" ? project : undefined),
      },
      archive: { events: (): TranscriptEvent[] => [] },
      briefs,
      clients: { broadcast: () => {} },
    } as unknown as ServerContext;
  });
  const run = (...argv: string[]) => runMemoryCommand(ctx, CHAT, argv);

  test("lists the stack with each handle, and says which have no sheet", async () => {
    const out = (await run("layer"))!;
    expect(out.ok).toBe(true);
    expect(out.text).toContain("2. bridge — Bridge: hidden browser and native apps");
    expect(out.text).toContain("1. ui — UI: React + Vite (no sheet)");
  });

  test("prints one layer's sheet by handle, name or the start of either", async () => {
    for (const asked of ["bridge", "Bridge", "brid"]) {
      const out = (await run("layer", asked))!;
      expect(out.ok).toBe(true);
      expect(out.text).toContain("# demo — Bridge");
      expect(out.text).toContain("(also at .ruri/layers/bridge.md)");
    }
    expect((await run("layer", "runtime"))!.text).toContain("no code of its own");
    const missing = (await run("layer", "database"))!;
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("ui, bridge, backend, runtime");
  });
});

describe("a turn folds into the layers it changed", () => {
  test("only the touched layers are rewritten, each with only its own turns", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-layers-fold-"));
    for (const rel of ["server/bridge.ts", "server/cdp.ts", "server/sessions.ts", "web/src/App.tsx"]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), "x");
    }
    const project = { id: "p", name: "demo", path: dir, sessions: [] };
    const briefs = new BriefStore();
    briefs.write("p", { description: "d", features: [], layers: stack }, true);
    briefs.writeLayer("p", "bridge", bridgeSheet);
    briefs.writeLayer("p", "ui", { ...bridgeSheet, summary: "the UI", map: [] });
    const asked: string[] = [];
    setCompletionClient({
      messages: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          const prompt = messages[0]!.content;
          asked.push(prompt);
          const reply = {
            ...bridgeSheet,
            // a file the turn changed is mapped; one nobody has is dropped
            map: [
              { name: "screenshots", files: ["server/bridge.ts"] },
              { name: "clicks", files: ["server/cdp.ts", "server/invented.ts"] },
            ],
          };
          return { content: [{ type: "text", text: JSON.stringify(reply) }] };
        },
      },
    } as unknown as Yagami);
    try {
      const ctx = {
        store: { get: (id: string) => (id === "p" ? project : undefined) },
        briefs,
        clients: { broadcast: () => {} },
      } as unknown as ServerContext;
      foldLayers(ctx, "p", [
        { text: "[a] clicks now go over CDP", files: ["server/cdp.ts", "server/sessions.ts"] },
        { text: "[b] the backend queue", files: ["server/queue.ts"] },
      ]);
      for (let i = 0; i < 50 && !briefs.get("p").layerSheets?.["bridge"]?.map[1]; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      // the bridge was touched and has a sheet; the backend was touched but
      // has none; the UI wasn't touched
      expect(asked).toHaveLength(1);
      expect(asked[0]).toContain("THE LAYER: Bridge");
      expect(asked[0]).toContain("[a] clicks now go over CDP");
      expect(asked[0]).not.toContain("[b] the backend queue");
      expect(briefs.get("p").layerSheets!["bridge"]!.map).toEqual([
        { name: "screenshots", files: ["server/bridge.ts"] },
        { name: "clicks", files: ["server/cdp.ts"] },
      ]);
      expect(briefs.get("p").layerSheets!["ui"]!.summary).toBe("the UI");
    } finally {
      setCompletionClient(null);
    }
  });
});

describe("every file has a layer", () => {
  test("the model places what no layer owns; what it won't goes beside its neighbours", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-layers-place-"));
    const files = [
      "server/bridge.ts",
      "server/cdp.ts",
      "server/talk.ts",
      "server/queue.ts",
      "web/src/App.tsx",
      "notes.ts",
    ];
    for (const rel of files) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), "// what it is for\nexport const x = 1;\n");
    }
    const layers = slugLayers([
      { name: "UI", what: "", paths: ["web/src/"] },
      { name: "Bridge", what: "", paths: ["server/bridge.ts", "server/cdp.ts"] },
      { name: "Talk", what: "", paths: ["server/relay.ts"] },
    ]);
    let asked = "";
    setCompletionClient({
      messages: {
        create: async ({ messages }: { messages: Array<{ content: string }> }) => {
          asked = messages[0]!.content;
          // talk placed by the model; queue left out; a stray marked none
          const reply = { files: { "server/talk.ts": "talk", "notes.ts": "none" } };
          return { content: [{ type: "text", text: JSON.stringify(reply) }] };
        },
      },
    } as unknown as Yagami);
    try {
      const out = await placeUnowned(
        { id: "p", name: "demo", path: dir, sessions: [] } as never,
        layers,
        () => {},
      );
      expect(asked).toContain("server/talk.ts — what it is for");
      expect(asked).not.toContain("server/bridge.ts —");
      const owner = (rel: string) => layerOfFile(out, rel)?.slug;
      expect(owner("server/talk.ts")).toBe("talk");
      // nobody placed it: the layer owning most of server/ takes it
      expect(owner("server/queue.ts")).toBe("bridge");
      expect(owner("notes.ts")).toBeUndefined();
    } finally {
      setCompletionClient(null);
    }
  });
});
