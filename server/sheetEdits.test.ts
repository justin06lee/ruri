import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LayerSheet, StackLayer, TranscriptEvent } from "../shared/protocol.js";
import { BriefStore } from "./brief.js";
import type { ServerContext } from "./context.js";
import { runMemoryCommand } from "./memoryCli.js";
import { editedSince, forgetReads, noteToolRead } from "./sheetEdits.js";

let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

const ME = "c0ffee11-2222-3333-4444-555566667777";
const OTHER = "beef0000-2222-3333-4444-555566667777";

const stack: StackLayer[] = [
  { name: "UI", what: "React + Vite", slug: "ui", paths: ["web/src/"] },
  { name: "Bridge", what: "hidden browser", slug: "bridge", paths: ["server/bridge.ts", "server/cdp.ts"] },
  { name: "Backend", what: "Node server", slug: "backend", paths: ["server/"] },
];

const sheet = (summary: string): LayerSheet => ({
  summary,
  map: [{ name: "screenshots", files: ["server/bridge.ts"] }],
  flows: [],
  files: ["server/bridge.ts — the tools a session holds"],
  rules: ["never show the window unless the user takes it over"],
  edges: [],
});

let ctx: ServerContext;
let briefs: BriefStore;
let dir: string;
let changed: string[];
beforeEach(() => {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-edits-"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-edits-project-"));
  for (const rel of [
    "server/bridge.ts",
    "server/cdp.ts",
    "server/queue.ts",
    "server/snap.ts",
    "web/src/App.tsx",
  ]) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), "x");
  }
  changed = [];
  const events: TranscriptEvent[] = [{ kind: "user", id: "u1", text: "fix the bridge", ts: Date.now() }];
  const sessions = [
    { id: ME, title: "Bridge work" },
    { id: OTHER, title: "Queue work" },
  ];
  const project = { id: "p", name: "demo", path: dir, sessions };
  briefs = new BriefStore();
  briefs.write("p", { description: "a demo", features: ["drives a browser"], layers: stack }, true);
  briefs.writeLayer("p", "bridge", sheet("Drives a hidden browser."), { by: "repo" });
  briefs.writeLayer("p", "backend", sheet("The server."), { by: "repo" });
  ctx = {
    store: {
      findSession: (id: string) => {
        const session = sessions.find((s) => s.id === id);
        return session ? { project, session } : undefined;
      },
      get: (id: string) => (id === "p" ? project : undefined),
    },
    archive: {
      events: () => events,
      allEvents: () => events,
      summaries: () => ({}),
      turnIds: () => ["u1"],
    },
    checkpoints: { changedSince: async () => changed },
    briefs,
    clients: { broadcast: () => {} },
  } as unknown as ServerContext;
  forgetReads(ME);
  forgetReads(OTHER);
});

const run = (...argv: string[]) => runMemoryCommand(ctx, ME, argv);
const other = (...argv: string[]) => runMemoryCommand(ctx, OTHER, argv);

describe("a session keeps a layer's sheet", () => {
  test("only once it has read it, and then by the numbers it was shown", async () => {
    const refused = (await run("layer", "bridge", "add", "rules", "CDP targets die on sleep"))!;
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain("you haven't read the bridge sheet");

    const read = (await run("layer", "bridge"))!;
    expect(read.text).toContain(
      "rules — rules and traps:\n  1. never show the window unless the user takes it over",
    );
    expect(read.text).toContain("owns: server/bridge.ts, server/cdp.ts");

    const added = (await run("layer", "bridge", "add", "rules", "CDP targets die on sleep"))!;
    expect(added.ok).toBe(true);
    expect(added.text).toContain("2. CDP targets die on sleep");
    // its own edit doesn't make it read again
    expect((await run("layer", "bridge", "set", "rules", "1", "never show the window uninvited"))!.ok).toBe(
      true,
    );
    expect((await run("layer", "bridge", "drop", "rules", "2"))!.ok).toBe(true);
    expect((await run("layer", "bridge", "set", "summary", "Drives a browser and native apps."))!.ok).toBe(
      true,
    );

    const now = briefs.get("p").layerSheets!["bridge"]!;
    expect(now.rules).toEqual(["never show the window uninvited"]);
    expect(now.summary).toBe("Drives a browser and native apps.");
    expect(now.stamp).toMatchObject({ by: "agent", chat: ME });
    expect(editedSince(ME, 0).layers.has("bridge")).toBe(true);
  });

  test("someone else's change since means reading it again", async () => {
    await run("layer", "bridge");
    await other("layer", "bridge");
    await new Promise((r) => setTimeout(r, 5));
    expect((await other("layer", "bridge", "add", "rules", "one tab per chat"))!.ok).toBe(true);
    const stale = (await run("layer", "bridge", "drop", "rules", "1"))!;
    expect(stale.ok).toBe(false);
    expect(stale.text).toContain("has changed since you read it");
    expect(stale.text).toContain('the "Queue work" chat');
    await run("layer", "bridge");
    expect((await run("layer", "bridge", "drop", "rules", "1"))!.ok).toBe(true);
  });

  test("a compact or a fresh session forgets what was read", async () => {
    await run("layer", "bridge");
    forgetReads(ME);
    expect((await run("layer", "bridge", "add", "rules", "x"))!.ok).toBe(false);
  });

  test("a sheet opened with the session's own tools counts as read", async () => {
    const read = (name: string, summary: string): TranscriptEvent =>
      ({ kind: "tool", id: "t", name, summary, ts: Date.now() }) as TranscriptEvent;
    noteToolRead(ME, read("Grep", "demo/.ruri/layers/bridge.md"));
    expect((await run("layer", "bridge", "add", "rules", "x"))!.ok).toBe(false);
    noteToolRead(ME, read("Read", "demo/.ruri/layers/bridge.md"));
    expect((await run("layer", "bridge", "add", "rules", "x"))!.ok).toBe(true);
  });

  test("lines are checked: files that exist, flows with parts, and the caps", async () => {
    await run("layer", "bridge");
    const invented = (await run("layer", "bridge", "add", "map", "clicks — server/invented.ts"))!;
    expect(invented.ok).toBe(false);
    expect(invented.text).toContain("no server/invented.ts");
    expect((await run("layer", "bridge", "add", "map", "clicks — server/cdp.ts"))!.ok).toBe(true);
    expect((await run("layer", "bridge", "add", "flows", "a click"))!.ok).toBe(false);
    expect(
      (await run("layer", "bridge", "add", "flows", "a click: web_click → server/cdp.ts -> CDP"))!.ok,
    ).toBe(true);
    expect(briefs.get("p").layerSheets!["bridge"]!.flows).toEqual([
      { name: "a click", steps: ["web_click", "server/cdp.ts", "CDP"] },
    ]);
    for (let i = 2; i <= 6; i++) await run("layer", "bridge", "add", "rules", `rule ${i}`);
    const full = (await run("layer", "bridge", "add", "rules", "rule 7"))!;
    expect(full.ok).toBe(false);
    expect(full.text).toContain("full at 6");
    expect((await run("layer", "bridge", "drop", "rules", "9"))!.text).toContain("no line 9");
  });

  test("owning a file another layer names takes reading that one too", async () => {
    await run("layer", "backend");
    const own = (await run("layer", "backend", "own", "server/snap.ts"))!;
    expect(own.ok).toBe(true);
    expect(briefs.get("p").layers!.find((l) => l.slug === "backend")!.paths).toContain("server/snap.ts");
    const taken = (await run("layer", "backend", "own", "server/cdp.ts"))!;
    expect(taken.ok).toBe(false);
    expect(taken.text).toContain("bridge");
    await run("layer", "bridge");
    expect((await run("layer", "backend", "own", "server/cdp.ts"))!.ok).toBe(true);
    const layers = briefs.get("p").layers!;
    expect(layers.find((l) => l.slug === "bridge")!.paths).toEqual(["server/bridge.ts"]);
    expect((await run("layer", "backend", "own", "server/nothing.ts"))!.text).toContain(
      "no server/nothing.ts",
    );
  });
});

describe("a session keeps the index", () => {
  test("reads it numbered, with the files no layer owns, then edits it", async () => {
    expect((await run("architecture", "add", "features", "x"))!.ok).toBe(false);
    const read = (await run("architecture"))!;
    expect(read.text).toContain("features — what it does:\n  1. drives a browser");
    expect(read.text).toContain("2. Bridge — hidden browser   [bridge · owns");
    expect((await run("arch", "add", "flows", "A click: UI → Bridge → CDP"))!.ok).toBe(true);
    expect((await run("arch", "set", "description", "A demo that drives a browser."))!.ok).toBe(true);
    expect((await run("arch", "add", "where", "no dash here"))!.ok).toBe(false);
    const brief = briefs.get("p");
    expect(brief.flows).toEqual([{ name: "A click", steps: ["UI", "Bridge", "CDP"] }]);
    expect(brief.description).toBe("A demo that drives a browser.");
    expect(brief.stamp).toMatchObject({ by: "agent", chat: ME });
  });

  test("a new layer comes with an empty sheet; one is taken out only once it owns nothing", async () => {
    await run("architecture");
    const added = (await run("architecture", "add", "stack", "Queue — prompts waiting their turn"))!;
    expect(added.ok).toBe(true);
    expect(added.text).toContain("as queue");
    expect(briefs.get("p").layerSheets!["queue"]!.summary).toBe("prompts waiting their turn");
    // the session made it, so it may fill it
    expect((await run("layer", "queue", "own", "server/queue.ts"))!.ok).toBe(true);
    await run("architecture");
    expect((await run("architecture", "drop", "stack", "4"))!.text).toContain("still owns");
    await run("layer", "queue", "disown", "server/queue.ts");
    await run("architecture");
    expect((await run("architecture", "drop", "stack", "4"))!.ok).toBe(true);
    expect(briefs.get("p").layerSheets!["queue"]).toBeUndefined();
  });
});

describe("a note about one layer is kept with it", () => {
  test("--layer files it; left off, it goes where this turn's changes are", async () => {
    const named = (await run("note", "trap", "CDP targets die on sleep", "--layer", "bridge"))!;
    expect(named.text).toContain("with the bridge layer");
    changed = ["server/bridge.ts", "server/cdp.ts"];
    const guessed = (await run("note", "decision", "One tab a chat", "--why", "tabs leak"))!;
    expect(guessed.text).toContain("with the bridge layer (where this turn's changes are");
    changed = ["server/bridge.ts", "web/src/App.tsx"];
    const spread = (await run("note", "worked", "Probing the tree first"))!;
    expect(spread.text).toContain("across the project");
    expect((await run("note", "trap", "x", "--layer", "project"))!.text).toContain("across the project");
    expect((await run("note", "trap", "x", "--layer", "nowhere"))!.ok).toBe(false);

    const memory = briefs.get("p").memory!;
    expect(memory.gotchas[0]!.layer).toBe("bridge");
    expect(memory.decisions[0]!.layer).toBe("bridge");
    expect(memory.worked[0]!.layer).toBeUndefined();
    // the layer's sheet carries it, and `ruri memory` says whose it is
    expect((await run("layer", "bridge"))!.text).toContain("trap: CDP targets die on sleep");
    expect((await run("memory"))!.text).toContain("[bridge] CDP targets die on sleep");
  });
});
