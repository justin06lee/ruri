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
  now: ["Library page done; architecture page next"],
  decisions: ["Each project keeps its own library — the user wants projects apart (2026-09-22)"],
  worked: ["Check UI on an isolated server, never the live app (2026-09-22)"],
  failed: ["Polling the cursor for the band's hover — cost battery (2026-09-10)"],
  gotchas: ["`make update` quits the app hosting the session (2026-09-01)"],
  open: ["A cross-project library search"],
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
    store.remember("p", { ...memory, now: ["something else"] });
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

  test("catchup.md is the memory, with the reasons and the dates, and points at the shape", () => {
    const text = catchupText("ruri", { description: "A desktop app.", features: [], memory, shots: [] });
    expect(text).toContain("## Decisions, and why");
    expect(text).toContain("the user wants projects apart (2026-09-22)");
    expect(text).toContain("## What didn't, and why");
    expect(text).toContain("## Gotchas and rules");
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
  const at = (day: number) => Date.UTC(2026, 8, day);
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
    expect(text).toContain("[2026-09-01] user: band hover\n   agent: polling failed: battery");
    expect(text).toContain("user: build the library");
    expect(text).toContain("Tried polling the cursor; it cost battery.");
  });
});
