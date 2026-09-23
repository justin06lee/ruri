import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ProjectMemory, TranscriptEvent } from "../shared/protocol.js";
import { architectureText, BriefStore, catchupText, writeBriefFiles } from "./brief.js";
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
