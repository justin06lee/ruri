import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";

let dir: string;
let SessionArchive: typeof import("./archive.js").SessionArchive;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-archive-"));
  process.env["RURI_CONFIG_DIR"] = dir;
  SessionArchive = (await import("./archive.js")).SessionArchive;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env["RURI_CONFIG_DIR"];
});

function user(id: string, text = id): TranscriptEvent {
  return { kind: "user", id, text, ts: 1 };
}
function reply(id: string, text = id): TranscriptEvent {
  return { kind: "assistant", id, text, ts: 2 };
}
function mark(id: string): TranscriptEvent {
  return { kind: "compaction", id, text: "folded", entries: [], ts: 3 };
}

const ids = (events: TranscriptEvent[]) => events.map((e) => e.id);

describe("the live transcript, indexed by id", () => {
  test("events go on the end, in order", () => {
    const archive = new SessionArchive();
    archive.append("c", user("u1"));
    archive.append("c", reply("a1"));
    expect(ids(archive.events("c"))).toEqual(["u1", "a1"]);
  });

  test("the same id again replaces where it stands, rather than appending", () => {
    const archive = new SessionArchive();
    archive.append("c", user("u1"));
    archive.append("c", reply("a1", "half"));
    archive.append("c", user("u2"));
    archive.append("c", reply("a1", "whole"));
    expect(ids(archive.events("c"))).toEqual(["u1", "a1", "u2"]);
    expect((archive.events("c")[1] as { text: string }).text).toBe("whole");
  });

  test("replace finds an event wherever it sits", () => {
    const archive = new SessionArchive();
    for (let i = 0; i < 50; i++) archive.append("c", reply(`a${i}`));
    expect(archive.replace("c", reply("a7", "moved on"))).toBe(true);
    expect((archive.events("c")[7] as { text: string }).text).toBe("moved on");
    expect(archive.replace("c", reply("nobody"))).toBe(false);
  });

  test("a turn taken out leaves the rest findable", () => {
    const archive = new SessionArchive();
    archive.append("c", user("u1"));
    archive.append("c", reply("a1"));
    archive.append("c", user("u2"));
    archive.append("c", reply("a2"));
    expect(archive.removeTurn("c", "u1")).toEqual(["u1", "a1"]);
    expect(ids(archive.events("c"))).toEqual(["u2", "a2"]);
    // the index survived the shuffle: the ones left are still found
    expect(archive.replace("c", reply("a2", "still here"))).toBe(true);
    archive.append("c", reply("a2", "and again"));
    expect(ids(archive.events("c"))).toEqual(["u2", "a2"]);
  });

  test("a fold leaves the live part findable", () => {
    const archive = new SessionArchive();
    archive.append("c", user("u1"));
    archive.append("c", reply("a1"));
    archive.append("c", mark("m1"));
    archive.append("c", user("u2"));
    // everything before the mark has gone to the history
    expect(ids(archive.events("c"))).toEqual(["m1", "u2"]);
    expect(archive.replace("c", user("u2", "changed"))).toBe(true);
    // and an event that folded away is not brought back by an update
    expect(archive.replace("c", reply("a1", "too late"))).toBe(false);
  });

  test("adding an event stays as cheap at the end of a long chat as at the start", () => {
    const archive = new SessionArchive();
    const time = (from: number, to: number) => {
      const started = performance.now();
      for (let i = from; i < to; i++) archive.append("c", reply(`a${i}`, "x".repeat(200)));
      return performance.now() - started;
    };
    const first = time(0, 4_000);
    const later = time(4_000, 8_000);
    expect(archive.events("c")).toHaveLength(8_000);
    // scanning for the id first made this grow with the conversation; a
    // fivefold allowance leaves room for noise and none for O(n) per event
    expect(later).toBeLessThan(Math.max(first, 1) * 5);
  });
});

describe("the history file", () => {
  /** Fold `count` exchanges into the history and give the archive back. */
  function folded(count: number, text = "x") {
    const archive = new SessionArchive();
    for (let i = 0; i < count; i++) {
      archive.append("c", user(`u${i}`, `${text}${i}`));
      archive.append("c", reply(`a${i}`, `${text}${i}`));
    }
    archive.append("c", mark("m"));
    return archive;
  }

  test("it reads back exactly what was folded into it, in order", () => {
    const archive = folded(40);
    const history = archive.history("c");
    expect(history).toHaveLength(80);
    expect(history[0]!.id).toBe("u0");
    expect(history.at(-1)!.id).toBe("a39");
  });

  test("a line torn by a crash mid-append is skipped, not fatal", () => {
    const archive = folded(3);
    const file = path.join(dir, "history", "c.jsonl");
    fs.appendFileSync(file, '{"kind":"assistant","id":"torn","te\n');
    fs.appendFileSync(file, JSON.stringify(reply("after")) + "\n");
    const ids_ = ids(archive.history("c"));
    expect(ids_).not.toContain("torn");
    expect(ids_.at(-1)).toBe("after");
  });

  test("an event spanning a read boundary comes back whole", () => {
    // lines far longer than the chunk the file is read in
    const archive = folded(6, "y".repeat(120_000));
    const history = archive.history("c");
    expect(history).toHaveLength(12);
    expect((history[0] as { text: string }).text.length).toBe(120_001);
    expect(history.at(-1)!.id).toBe("a5");
  });

  test("characters that straddle a read boundary survive", () => {
    const archive = folded(4, "\u{1f409}".repeat(90_000));
    const history = archive.history("c");
    expect(history).toHaveLength(8);
    for (const event of history) {
      expect((event as { text: string }).text).toContain("\u{1f409}");
      expect((event as { text: string }).text).not.toContain("�");
    }
  });

  test("no history is no events, not a throw", () => {
    expect(new SessionArchive().history("never-existed")).toEqual([]);
  });

  test("the cap trims the oldest exchanges and keeps the newest", () => {
    const archive = new SessionArchive({ historyMaxBytes: 60_000 });
    for (let i = 0; i < 60; i++) {
      archive.append("c", user(`u${i}`, "z".repeat(1_000)));
      archive.append("c", reply(`a${i}`, "z".repeat(1_000)));
    }
    archive.append("c", mark("m"));
    const history = archive.history("c");
    expect(history.length).toBeGreaterThan(0);
    expect(history.length).toBeLessThan(120);
    // what is left runs to the end, and starts where a turn starts
    expect(history.at(-1)!.id).toBe("a59");
    expect(history[0]!.kind).toBe("user");
    expect(fs.statSync(path.join(dir, "history", "c.jsonl")).size).toBeLessThanOrEqual(60_000);
  });
});

describe("a rewind's fork point, tied to its session", () => {
  test("it is handed over only to the session it was set in, and taken either way", () => {
    const archive = new SessionArchive();
    archive.setLastSessionId("c", "S1");
    archive.setResumeAt("c", "S1", "u9");
    // a build resuming some other session takes it, and gets nothing
    expect(archive.takeResumeAt("c", "S2")).toBeUndefined();
    expect(archive.takeResumeAt("c", "S1")).toBeUndefined();
    archive.setResumeAt("c", "S1", "u9");
    expect(archive.takeResumeAt("c", "S1")).toBe("u9");
    expect(archive.takeResumeAt("c", "S1")).toBeUndefined();
  });

  test("a compaction's move to a fresh session takes the pending point and tip fork with it", () => {
    const archive = new SessionArchive();
    archive.setLastSessionId("c", "S1");
    archive.setResumeAt("c", "S1", "u9");
    archive.setForkNext("c", "S1");
    archive.clearLastSessionId("c");
    expect(archive.resumePoint("c")).toBeUndefined();
    expect(archive.takeResumeAt("c", "S1")).toBeUndefined();
    expect(archive.takeForkNext("c", "S1")).toBe(false);
  });

  test("a tip fork is the session's it was set in", () => {
    const archive = new SessionArchive();
    archive.setForkNext("c", "S1");
    expect(archive.takeForkNext("c", "S2")).toBe(false);
    archive.setForkNext("c", "S1");
    expect(archive.takeForkNext("c", "S1")).toBe(true);
  });

  test("a point survives a restart, and one from before points named their session doesn't", () => {
    const archive = new SessionArchive();
    archive.append("c", user("u1"));
    archive.setResumeAt("c", "S1", "u9");
    archive.flushAll();
    expect(new SessionArchive().resumePoint("c")).toEqual({ session: "S1", uuid: "u9" });
    const file = path.join(dir, "sessions", "c.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    fs.writeFileSync(file, JSON.stringify({ ...raw, resumeAt: "860dc3e1", forkNext: true }));
    const again = new SessionArchive();
    expect(again.resumePoint("c")).toBeUndefined();
    expect(again.takeForkNext("c", "S1")).toBe(false);
  });
});

describe("the windows chats' turns reported", () => {
  test("each model's, the larger where two chats disagree, and none for a chat on another model now", () => {
    const archive = new SessionArchive();
    archive.setContextTokens("a", 48_000, 1_000_000, "opus");
    archive.setContextTokens("b", 90_000, 200_000, "opus");
    archive.setContextTokens("c", 70_000, 258_400, "codex:gpt-6-astra");
    // switched off the model that measured it: the reading no longer counts
    archive.setContextTokens("d", 30_000, 200_000, "haiku");
    archive.setContextTokens("d", 30_000, undefined, "sonnet");
    const windows = archive.reportedWindows(["a", "b", "c", "d", "never-seen"]);
    expect(Object.fromEntries(windows)).toEqual({ opus: 1_000_000, "codex:gpt-6-astra": 258_400 });
  });
});
