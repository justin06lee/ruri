import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import type { SessionArchive } from "./archive.js";
import type { ServerContext } from "./context.js";
import { fromMidna, midnaMixup, midnaNote, midnaPromptOf, namedMidna, written } from "./midnaPrompt.js";

const CHAT = "chat-1";
let saved: string | undefined;
let dir: string;
let archive: SessionArchive;
let ctx: ServerContext;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-midna-prompt-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { SessionArchive } = await import("./archive.js");
  archive = new SessionArchive();
  ctx = { archive } as unknown as ServerContext;
});

const user = (id: string, text: string, extra: Partial<Extract<TranscriptEvent, { kind: "user" }>> = {}) =>
  ({ kind: "user", id, text, ts: Date.now(), ...extra }) as TranscriptEvent;

describe("whose prompt a chat is on", () => {
  test("a prompt is midna's by the id midna gave it", () => {
    expect(fromMidna("midna-3f2c")).toBe(true);
    expect(fromMidna("3f2c-midna-")).toBe(false);
    expect(fromMidna(undefined)).toBe(false);
  });

  test("ruri's own words — back to work, carrying on — are nobody's prompt", () => {
    expect(written(user("a", "do the thing"))).toBe(true);
    expect(written(user("b", "↩ Back to what you were doing"))).toBe(false);
    expect(written(user("c", "↻ You compacted yourself"))).toBe(false);
    expect(written({ kind: "assistant", id: "d", text: "ok", ts: 1 })).toBe(false);
  });

  test("the latest prompt anyone wrote decides, whatever ruri said after it", () => {
    expect(midnaPromptOf(ctx, CHAT)).toBeUndefined();
    archive.append(CHAT, user("u1", "hello"));
    expect(midnaPromptOf(ctx, CHAT)).toBeUndefined();
    archive.append(CHAT, user("midna-1", "(midna, for Justin) ship it"));
    archive.append(CHAT, user("x", "↩ Back to what you were doing: carry on"));
    expect(midnaPromptOf(ctx, CHAT)).toBe("midna-1");
    // the user steps in: the turn is theirs now
    archive.append(CHAT, user("u2", "wait, not yet"));
    expect(midnaPromptOf(ctx, CHAT)).toBeUndefined();
  });

  test("another agent's letter is not midna's, whatever its id", () => {
    archive.append(
      CHAT,
      user("midna-9", "hi", {
        from: { agent: "z", project: "api", title: "", letter: "l", reply: "wait", depth: 1 },
      }),
    );
    expect(midnaPromptOf(ctx, CHAT)).toBeUndefined();
  });
});

describe("the project that shares midna's name", () => {
  test("is told by its name, however it is cased", () => {
    expect(namedMidna({ name: "midna" })).toBe(true);
    expect(namedMidna({ name: "Midna " })).toBe(true);
    expect(namedMidna({ name: "midna-site" })).toBe(false);
  });

  test("a chat midna prompted is stopped once from writing to it, then let through", () => {
    archive.append(CHAT, user("midna-1", "(midna, for Justin) add the catalog"));
    const first = midnaMixup(ctx, CHAT, { name: "midna" });
    expect(first).toContain("Not sent");
    expect(first).toContain("end your turn");
    // sent again in the same turn: the project's chat is who it meant
    expect(midnaMixup(ctx, CHAT, { name: "midna" })).toBeUndefined();
    // midna's next prompt is a new turn: told again
    archive.append(CHAT, user("midna-2", "(midna) and the favourites"));
    expect(midnaMixup(ctx, CHAT, { name: "midna" })).toContain("Not sent");
  });

  test("any other project, and any chat the user prompted, goes as ever", () => {
    archive.append(CHAT, user("midna-1", "(midna, for Justin) add the catalog"));
    expect(midnaMixup(ctx, CHAT, { name: "ghostly" })).toBeUndefined();
    archive.append(CHAT, user("u1", "ask the midna chat how it signs builds"));
    expect(midnaMixup(ctx, CHAT, { name: "midna" })).toBeUndefined();
  });
});

describe("what the model reads", () => {
  test("midna's prompt says whose it is and how it is answered; the user's says nothing", () => {
    const note = midnaNote(ctx, CHAT, "midna-77", undefined);
    expect(note).toContain("<ruri:midna>");
    expect(note).toContain("end your turn");
    expect(note).toContain("Never use message_agent or ask_project");
    expect(midnaNote(ctx, CHAT, "u-1", undefined)).toBe("");
  });

  test("another agent's letter says nothing, in a chat midna prompted or not", () => {
    archive.append(CHAT, user("midna-1", "(midna, for Justin) add the catalog"));
    expect(midnaNote(ctx, CHAT, "l-1", {})).toBe("");
  });

  test("ruri carrying midna's turn on after a compaction says it again", () => {
    expect(midnaNote(ctx, CHAT, "c-1", { carried: true })).toBe("");
    archive.append(CHAT, user("midna-1", "(midna, for Justin) add the catalog"));
    expect(midnaNote(ctx, CHAT, "c-1", { carried: true })).toContain("<ruri:midna>");
  });
});
