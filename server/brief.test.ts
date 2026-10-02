import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectMemory, TranscriptEvent } from "../shared/protocol.js";
import {
  architectureText,
  BriefStore,
  catchupText,
  layerNotes,
  sharedSheet,
  writeBriefFiles,
} from "./brief.js";
import type { ServerContext } from "./context.js";
import { memoryMaterial } from "./memory.js";

let config: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-brief-"));
  process.env["RURI_CONFIG_DIR"] = config;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

const memory: ProjectMemory = {
  now: [{ id: "n001", text: "Library page done; architecture page next", by: "model" }],
  decisions: [
    {
      id: "d001",
      text: "Each project keeps its own library",
      why: "the user wants projects apart",
      date: "2026-09-22",
      by: "agent",
    },
  ],
  worked: [
    {
      id: "w001",
      text: "Check UI on an isolated server, never the live app",
      date: "2026-09-22",
      by: "model",
    },
  ],
  failed: [
    {
      id: "f001",
      text: "Polling the cursor for the band's hover",
      why: "cost battery",
      date: "2026-09-10",
      by: "model",
    },
  ],
  gotchas: [
    {
      id: "g001",
      text: "`make update` quits the app hosting the session",
      date: "2026-09-01",
      by: "user",
      pinned: true,
    },
  ],
  open: [{ id: "o001", text: "Merge feat/self-update once subaru is published", by: "model" }],
};

describe("the sheet", () => {
  test("the shape and the memory are kept apart, and both survive a reload", () => {
    const store = new BriefStore();
    store.write(
      "p",
      {
        description: "A desktop app for parallel coding sessions.",
        features: ["Parallel sessions per project"],
        layers: [{ name: "UI", what: "React 19 + Vite", where: "web/src/" }],
        flows: [{ name: "A prompt", steps: ["composer", "WebSocket", "server"] }],
      },
      true,
    );
    store.remember("p", memory, true);
    // a change is written a moment later; a quit flushes it
    store.flush();
    const again = new BriefStore().get("p");
    expect(again.layers?.[0]?.name).toBe("UI");
    expect(again.flows?.[0]?.steps).toEqual(["composer", "WebSocket", "server"]);
    expect(again.memory).toEqual(memory);
    expect(typeof again.built).toBe("number");
    expect(typeof again.recalled).toBe("number");
    // a fold of the shape leaves the memory alone, and the memory the shape
    store.write("p", { description: "Still a desktop app.", features: ["Parallel sessions"] });
    expect(store.get("p").memory).toEqual(memory);
    store.remember("p", { ...memory, now: [{ id: "n002", text: "something else", by: "model" }] });
    expect(store.get("p").description).toBe("Still a desktop app.");
  });

  test("a whole build with layers retires an older sheet's one-line stack", () => {
    const file = path.join(config, "briefs.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ p: { description: "old", features: ["a"], stack: ["TypeScript"], shots: [] } }),
    );
    const store = new BriefStore();
    expect(store.get("p").stack).toEqual(["TypeScript"]);
    store.write("p", { description: "new", features: ["a"], layers: [{ name: "UI", what: "React" }] }, true);
    expect(store.get("p").stack).toBeUndefined();
    expect(store.get("p").layers?.length).toBe(1);
  });

  test("architecture.md numbers the stack from the top and draws each flow as arrows", () => {
    const text = architectureText("ruri", {
      description: "A desktop app.",
      features: ["Parallel sessions"],
      layers: [
        { name: "UI", what: "React 19 + Vite", where: "web/src/" },
        { name: "Engine", what: "the claude CLI" },
      ],
      flows: [{ name: "A prompt", steps: ["composer", "WebSocket", "server/dispatch.ts"] }],
      run: ["make — build and install"],
      shots: [],
    });
    expect(text).toContain("1. **UI** — React 19 + Vite (`web/src/`)");
    expect(text).toContain("2. **Engine** — the claude CLI");
    expect(text).toContain("- **A prompt:** composer → WebSocket → server/dispatch.ts");
    expect(text).toContain("## How to run it");
    expect(text).toContain("catchup.md");
  });

  test("an older sheet without layers still shows its stack", () => {
    const text = architectureText("x", { description: "d", features: [], stack: ["Go 1.23"], shots: [] });
    expect(text).toContain("## Stack");
    expect(text).toContain("- Go 1.23");
  });

  test("catchup.md is the memory, with the reasons, the dates, the sources and git, and points at the shape", () => {
    const text = catchupText(
      "ruri",
      { description: "A desktop app.", features: [], memory, shots: [] },
      {
        refs: { d001: "7a3637b4#16" },
        facts: { o001: "[git: feat/self-update is not merged yet]" },
        git: ["Branch: on master (abc1234)"],
        asOf: "20:53",
      },
    );
    expect(text).toContain("## Decisions, and why");
    expect(text).toContain(
      "Each project keeps its own library — the user wants projects apart (2026-09-22 · 7a3637b4#16 · by an agent)",
    );
    expect(text).toContain("## What didn't, and why");
    expect(text).toContain("Polling the cursor for the band's hover — cost battery (2026-09-10)");
    expect(text).toContain("## Gotchas and rules");
    expect(text).toContain("(2026-09-01 · by the user)");
    expect(text).toContain("once subaru is published [git: feat/self-update is not merged yet]");
    expect(text).toContain("From git at 20:53");
    expect(text).toContain("- Branch: on master (abc1234)");
    expect(text).toContain("ruri note decision");
    expect(text).toContain("ruri recall show 7a3637b4#16");
    expect(text).toContain("architecture.md");
    expect(catchupText("x", { description: "d", features: [], shots: [] })).toContain(
      "Nothing has been gathered from the work yet.",
    );
  });

  test("catchup.md keeps what holds across the project; a layer's lines go with its sheet", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-brief-layered-"));
    fs.writeFileSync(path.join(project, "main.ts"), "x");
    const layered = {
      description: "A desktop app.",
      features: [],
      shots: [],
      layers: [{ name: "Bridge", what: "hidden browser", slug: "bridge", paths: ["server/bridge.ts"] }],
      layerSheets: {
        bridge: { summary: "Drives a browser.", map: [], flows: [], files: [], rules: [], edges: [] },
      },
      memory: {
        ...memory,
        gotchas: [
          ...memory.gotchas,
          {
            id: "g002",
            text: "CDP targets die on sleep",
            by: "agent" as const,
            layer: "bridge",
            date: "2026-09-27",
          },
        ],
      },
    };
    const extra = { chats: ['"Bridge work" (c0ffee11) — working now · on: fix the click · in: bridge'] };
    const text = catchupText("ruri", layered, extra);
    expect(text).toContain("`make update` quits the app");
    expect(text).not.toContain("CDP targets die on sleep");
    expect(text).toContain("## Kept with their layers");
    expect(text).toContain("- bridge (Bridge) — 1 line");
    expect(text).toContain("The chats at work in the last day");
    expect(text).toContain('- "Bridge work" (c0ffee11) — working now · on: fix the click · in: bridge');
    expect(text).toContain("--layer <handle>");
    writeBriefFiles(project, "ruri", layered, extra);
    // the layer's file is committed with the project: the sheet alone — what
    // sessions learned there comes from this person's chats, and
    // `ruri layer` prints it beside the sheet
    const sheet = fs.readFileSync(path.join(project, ".ruri", "layers", "bridge.md"), "utf8");
    expect(sheet).not.toContain("CDP targets die on sleep");
    expect(sheet).toContain("what sessions learned working here");
    expect(sheet).toContain("`ruri layer bridge add|set|drop <section> …`");
    expect(layerNotes(layered, "bridge")).toContain(
      "trap: CDP targets die on sleep (2026-09-27 · by an agent)",
    );
  });

  test("the shape travels with the project as data a clone takes in; the memory and git stay home", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-brief-shared-"));
    fs.writeFileSync(path.join(project, "main.ts"), "x");
    const sheet = {
      description: "A desktop app.",
      features: ["Chats per project"],
      shots: [],
      layers: [{ name: "Bridge", what: "hidden browser", slug: "bridge", paths: ["server/bridge.ts"] }],
      layerSheets: {
        bridge: {
          summary: "Drives a browser.",
          map: [],
          flows: [],
          files: [],
          rules: ["CDP needs a target"],
          edges: [],
          updated: 5,
          stamp: { at: 5, by: "repo" as const },
        },
      },
      run: ["make dev"],
      builtAt: "abc1234",
      memory,
    };
    writeBriefFiles(project, "ruri", sheet, {
      git: ["Branch: on master (abc1234)"],
      asOf: "12:00",
      sinceRead: 3,
    });
    const architecture = fs.readFileSync(path.join(project, ".ruri", "architecture.md"), "utf8");
    // what moves with every commit is the catch-up's, which stays out of git
    expect(architecture).toContain("Read from the repo at abc1234;");
    expect(architecture).not.toContain("commits ago");
    expect(fs.readFileSync(path.join(project, ".ruri", "catchup.md"), "utf8")).toContain(
      "architecture.md was read from the repo at abc1234, 3 commits ago",
    );
    const json = fs.readFileSync(path.join(project, ".ruri", "architecture.json"), "utf8");
    expect(json).not.toContain("make update");
    expect(json).not.toContain('"stamp"');
    const shared = sharedSheet(project)!;
    expect(shared.description).toBe("A desktop app.");
    expect(shared.layers?.[0]?.paths).toEqual(["server/bridge.ts"]);
    expect(shared.layerSheets?.["bridge"]?.rules).toEqual(["CDP needs a target"]);
    expect(shared.run).toEqual(["make dev"]);
    expect(shared.builtAt).toBe("abc1234");
    expect(sharedSheet(path.join(project, "nowhere"))).toBeUndefined();
  });

  test("both files land in the project's .ruri/, and an empty sheet takes them away", () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-brief-project-"));
    fs.writeFileSync(path.join(project, "main.go"), "package main\n");
    writeBriefFiles(project, "x", { description: "d", features: ["f"], memory, shots: [] });
    expect(fs.existsSync(path.join(project, ".ruri", "architecture.md"))).toBe(true);
    expect(fs.readFileSync(path.join(project, ".ruri", "catchup.md"), "utf8")).toContain("What worked");
    writeBriefFiles(project, "x", { description: "", features: [], shots: [] });
    expect(fs.existsSync(path.join(project, ".ruri", "architecture.md"))).toBe(false);
    expect(fs.existsSync(path.join(project, ".ruri", "catchup.md"))).toBe(false);
  });
});

describe("the memory's reading of the chats", () => {
  const at = (day: number) => Date.UTC(2026, 8, day, 12);
  let n = 0;
  const user = (text: string, ts: number): TranscriptEvent =>
    ({ kind: "user", id: `u${++n}`, text, ts }) as TranscriptEvent;
  const reply = (text: string, ts: number): TranscriptEvent =>
    ({ kind: "assistant", id: `a${++n}`, text, ts }) as TranscriptEvent;
  const done = (ts: number): TranscriptEvent =>
    ({ kind: "result", id: `r${++n}`, ok: true, ts }) as TranscriptEvent;

  test("each chat's notes and last replies, the chat most recently at work last", () => {
    const events: Record<string, TranscriptEvent[]> = {
      old: [
        user("make the band hover", at(1)),
        reply("Tried polling the cursor; it cost battery.", at(1)),
        done(at(1)),
      ],
      recent: [
        user("build the library", at(20)),
        reply("Built it; register goes through the card.", at(20)),
        done(at(20)),
      ],
      empty: [],
    };
    const firstOld = events["old"]![0]!.id;
    const ctx = {
      store: {
        get: () => ({
          id: "p",
          sessions: [
            { id: "recent", title: "Library" },
            { id: "old", title: "Band" },
            { id: "empty", title: "Idle" },
          ],
        }),
      },
      archive: {
        allEvents: (id: string) => events[id] ?? [],
        summaries: (id: string) =>
          id === "old" ? { [firstOld]: { user: "band hover", reply: "polling failed: battery" } } : {},
        digest: () => undefined,
      },
    } as unknown as ServerContext;
    const text = memoryMaterial(ctx, "p");
    expect(text.indexOf("CHAT: Band")).toBeLessThan(text.indexOf("CHAT: Library"));
    expect(text).not.toContain("CHAT: Idle");
    expect(text).toContain("[old#1 · 2026-09-01] user: band hover\n   agent: polling failed: battery");
    expect(text).toContain("refs start old");
    expect(text).toContain("user: build the library");
    expect(text).toContain("Tried polling the cursor; it cost battery.");
  });
});
