import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionArchive } from "./archive.js";
import { BriefStore } from "./brief.js";
import type { ServerContext } from "./context.js";
import { memoryUpdate } from "./handoff.js";
import { MemoryBook } from "./memoryLog.js";

let dir: string;
let ctx: ServerContext;
let archive: SessionArchive;
const ME = "me000000-chat";
const OTHER = "other000-chat";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-update-"));
  process.env["RURI_CONFIG_DIR"] = dir;
  archive = new SessionArchive();
  const briefs = new BriefStore();
  briefs.write(
    "p",
    {
      description: "demo",
      features: [],
      layers: [
        { name: "UI", what: "the window", slug: "ui", paths: ["web/"] },
        { name: "Server", what: "the backend", slug: "server", paths: ["server/"] },
      ],
    },
    true,
  );
  const sessions = [
    { id: ME, title: "Mine" },
    { id: OTHER, title: "Theirs" },
  ];
  const project = { id: "p", name: "demo", path: dir, sessions };
  ctx = {
    store: {
      get: (id: string) => (id === "p" ? project : undefined),
      findSession: (id: string) => {
        const session = sessions.find((s) => s.id === id);
        return session ? { project, session } : undefined;
      },
    },
    archive,
    briefs,
    memory: new MemoryBook(briefs),
  } as unknown as ServerContext;
  // this chat has been working in the window's layer
  archive.append(ME, { kind: "user", id: "u1", text: "fix the sidebar", ts: 1 });
  archive.setTurnFiles(ME, "u1", ["web/src/Sidebar.tsx"]);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env["RURI_CONFIG_DIR"];
});

const other = { by: "agent" as const, chat: OTHER };

describe("what a running session hears of the memory changing under it", () => {
  test("nothing the first time — it starts counting — and nothing when nothing changed", () => {
    ctx.memory.apply("p", [{ op: "add", part: "gotchas", text: "an old trap" }], other);
    expect(memoryUpdate(ctx, ME, "claude")).toBe("");
    expect(memoryUpdate(ctx, ME, "claude")).toBe("");
  });

  test("what other chats wrote across the project and in its layers — not elsewhere, not its own", () => {
    memoryUpdate(ctx, ME, "claude");
    ctx.memory.apply(
      "p",
      [
        { op: "add", part: "decisions", text: "Use bun for every script", why: "one tool" },
        { op: "add", part: "gotchas", text: "Sidebar rows must not animate height", layer: "ui" },
        { op: "add", part: "gotchas", text: "Sockets close on sleep", layer: "server" },
      ],
      other,
    );
    ctx.memory.apply(
      "p",
      [{ op: "add", part: "worked", text: "my own lesson about the sidebar", layer: "ui" }],
      {
        by: "agent",
        chat: ME,
      },
    );
    const update = memoryUpdate(ctx, ME, "claude");
    expect(update).toStartWith("<memory-update>");
    expect(update).toContain("- new — decision: Use bun for every script — one tool");
    expect(update).toContain("- new — trap (ui): Sidebar rows must not animate height");
    expect(update).not.toContain("Sockets close on sleep");
    expect(update).not.toContain("my own lesson");
    // told once
    expect(memoryUpdate(ctx, ME, "claude")).toBe("");
    // each harness's session is told for itself
    expect(memoryUpdate(ctx, ME, "codex")).toBe("");
  });

  test("a line replaced, taken out, or found stale says so", () => {
    const [kept, gone, stale] = ctx.memory.apply(
      "p",
      [
        { op: "add", part: "decisions", text: "Build on Godot" },
        { op: "add", part: "open", text: "Godot go/no-go" },
        { op: "add", part: "gotchas", text: "LIFT is 9 in icon.html" },
      ],
      other,
    ).added;
    memoryUpdate(ctx, ME, "claude");
    ctx.memory.apply(
      "p",
      [
        { op: "supersede", line: kept!.id, text: "Build on a fork of Bevy", reason: "moved engines" },
        { op: "retire", line: gone!.id, reason: "decided for Bevy" },
      ],
      { by: "agent", chat: OTHER },
    );
    ctx.memory.apply("p", [{ op: "flag", line: stale!.id, reason: "icon.html has LIFT = 10" }], {
      by: "system",
    });
    const update = memoryUpdate(ctx, ME, "claude");
    expect(update).toContain("- replaced — decision: Build on Godot → now: Build on a fork of Bevy");
    expect(update).toContain("- no longer holds — still open: Godot go/no-go [decided for Bevy]");
    expect(update).toContain("- may be stale — trap: LIFT is 9 in icon.html [icon.html has LIFT = 10]");
  });
});
