import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";

let saved: { home?: string; config?: string };
beforeAll(() => {
  saved = { home: process.env["CLAUDE_CONFIG_DIR"], config: process.env["RURI_CONFIG_DIR"] };
});
afterAll(() => {
  for (const [key, value] of [
    ["CLAUDE_CONFIG_DIR", saved.home],
    ["RURI_CONFIG_DIR", saved.config],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const CHAT = "chat-1";
let project: string;
let transcripts: string;
let ctx: ServerContext;
let archive: InstanceType<typeof import("./archive.js").SessionArchive>;
let checkResumable: typeof import("./handoff.js").checkResumable;
let recoverLostStart: typeof import("./handoff.js").recoverLostStart;
let catchUp: typeof import("./handoff.js").catchUp;
let harnessOfSession: typeof import("./archive.js").harnessOfSession;
let pushed: TranscriptEvent[];
let disposed: string[];
let sent: Array<{ text: string; images?: unknown; silent?: boolean; eventId?: string }>;
/** The harness the chat's next prompt goes to, as the manager would say. */
let harness: string;
/** Whether a process is up on that harness. */
let live: boolean;

/** An exchange, as the transcript holds one. Mid-day timestamps: bun's
 *  tests run in UTC. */
function exchange(id: string, prompt: string, reply: string): void {
  const ts = Date.UTC(2026, 8, 20, 12, 0, 0);
  archive.append(CHAT, { kind: "user", id, text: prompt, ts } as TranscriptEvent);
  archive.append(CHAT, { kind: "assistant", id: `r-${id}`, text: reply, ts: ts + 1 } as TranscriptEvent);
  archive.append(CHAT, { kind: "result", id: `x-${id}`, ok: true, ts: ts + 2 } as TranscriptEvent);
}

/** A turn that ran on `session` for the prompt `id`, start to finish. */
function ranOn(session: string, id: string): void {
  archive.setLastSessionId(CHAT, session);
  archive.noteSent(CHAT, harnessOfSession(session), id);
  archive.noteSeen(CHAT, session, id);
}

beforeEach(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-claude-"));
  process.env["CLAUDE_CONFIG_DIR"] = home;
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-handoff-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-handoff-project-"));
  // filed the way the CLI files it: under the real path (/var is /private/var)
  transcripts = path.join(home, "projects", fs.realpathSync(project).replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(
    path.join(transcripts, "S1.jsonl"),
    '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n',
  );
  const { SessionArchive } = await import("./archive.js");
  ({ harnessOfSession } = await import("./archive.js"));
  ({ checkResumable, recoverLostStart, catchUp } = await import("./handoff.js"));
  archive = new SessionArchive();
  archive.append(CHAT, { kind: "user", id: "p1", text: "build the ledger", ts: 1 } as TranscriptEvent);
  archive.append(CHAT, { kind: "assistant", id: "r1", text: "built it", ts: 2 } as TranscriptEvent);
  pushed = [];
  disposed = [];
  sent = [];
  harness = "claude";
  live = false;
  const owner = { id: "p", name: "demo", path: project, sessions: [{ id: CHAT }] };
  ctx = {
    manager: {
      live: (_: string, on?: string) => live && (on === undefined || on === harness),
      harnessFor: () => harness,
      dispose: (id: string) => disposed.push(id),
      send: (_: unknown, text: string, images?: unknown, __?: unknown, silent?: boolean, eventId?: string) =>
        sent.push({ text, images, silent, eventId }),
    },
    archive,
    store: {
      findSession: (id: string) => (id === CHAT ? { project: owner, session: owner.sessions[0] } : undefined),
    },
    briefs: { get: () => ({}) },
    clients: { pushEvent: (_: string, event: TranscriptEvent) => pushed.push(event) },
  } as unknown as ServerContext;
});

describe("before a prompt resumes a session", () => {
  test("a session and fork point Claude has are left alone", () => {
    archive.setLastSessionId(CHAT, "S1");
    archive.setResumeAt(CHAT, "S1", "a1");
    checkResumable(ctx, CHAT);
    expect(archive.sessionOn(CHAT, "claude")).toBe("S1");
    expect(archive.resumePoint(CHAT)).toEqual({ session: "S1", uuid: "a1" });
    expect(pushed).toEqual([]);
  });

  test("a fork point that isn't in the session: a fresh one, told the whole conversation", () => {
    archive.setLastSessionId(CHAT, "S1");
    archive.setResumeAt(CHAT, "S1", "3fffb460");
    checkResumable(ctx, CHAT);
    expect(archive.sessionOn(CHAT, "claude")).toBeUndefined();
    expect(archive.lastSessionId(CHAT)).toBeUndefined();
    expect(archive.resumePoint(CHAT)).toBeUndefined();
    expect(catchUp(ctx, CHAT, "and now?").brief).toContain("build the ledger");
    expect(pushed[0]).toMatchObject({ kind: "info" });
  });

  test("a session Claude doesn't have — a fork that failed as it started — is let go of", () => {
    archive.setLastSessionId(CHAT, "753d7328");
    checkResumable(ctx, CHAT);
    expect(archive.sessionOn(CHAT, "claude")).toBeUndefined();
    expect(catchUp(ctx, CHAT, "and now?").brief).toContain("<compacted-history>");
    expect((pushed[0] as { text: string }).text).toContain("is gone");
  });

  test("and so is a dead process still holding it, or the next build resumes it again", () => {
    archive.setLastSessionId(CHAT, "753d7328");
    checkResumable(ctx, CHAT);
    expect(disposed).toEqual([CHAT]);
  });

  test("where Claude's transcripts can't be seen, or a process is up, nothing is decided", () => {
    fs.rmSync(transcripts, { recursive: true, force: true });
    archive.setLastSessionId(CHAT, "S1");
    checkResumable(ctx, CHAT);
    expect(archive.lastSessionId(CHAT)).toBe("S1");
    fs.mkdirSync(transcripts, { recursive: true });
    archive.setLastSessionId(CHAT, "S9");
    live = true;
    checkResumable(ctx, CHAT);
    expect(archive.lastSessionId(CHAT)).toBe("S9");
    expect(pushed).toEqual([]);
  });

  test("a chat on another harness leaves its Claude session for when it comes back", () => {
    archive.setLastSessionId(CHAT, "753d7328");
    archive.setLastSessionId(CHAT, "codex:t1");
    harness = "codex";
    checkResumable(ctx, CHAT);
    expect(archive.sessionOn(CHAT, "claude")).toBe("753d7328");
    expect(archive.sessionOn(CHAT, "codex")).toBe("codex:t1");
    expect(pushed).toEqual([]);
  });
});

describe("a resume that fails as it starts", () => {
  test("its prompts go again to a fresh session, the first briefed on the conversation", () => {
    archive.setLastSessionId(CHAT, "28c0b0cb");
    recoverLostStart(ctx, CHAT, "28c0b0cb", "session", [
      { text: "make the icon", images: [{ data: "iVBOR", mediaType: "image/png" }], eventId: "p2" },
      { text: "then the readme" },
    ]);
    expect(disposed).toEqual([CHAT]);
    expect(archive.lastSessionId(CHAT)).toBeUndefined();
    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain("build the ledger");
    expect(sent[0]!.text.endsWith("make the icon")).toBe(true);
    expect(sent[0]).toMatchObject({
      images: [{ data: "iVBOR", mediaType: "image/png" }],
      silent: true,
      eventId: "p2",
    });
    expect(sent[1]).toMatchObject({ text: "then the readme", silent: true });
    // the brief went with the prompt, not left for the next one
    expect(archive.hasPendingBrief(CHAT)).toBe(false);
    // and the prompt is on record as sent to the fresh one
    expect(archive.harnessSession(CHAT, "claude")).toEqual({ sent: "p2" });
    expect((pushed[0] as { text: string }).text).toContain("is gone");
  });

  test("a fork point it couldn't find says so", () => {
    archive.setLastSessionId(CHAT, "S1");
    recoverLostStart(ctx, CHAT, "S1", "point", [{ text: "go on" }]);
    expect((pushed[0] as { text: string }).text).toContain("rewound to isn't in its Claude session");
    expect(sent[0]!.text.endsWith("go on")).toBe(true);
  });

  test("a Codex thread that's gone is let go of alone — the chat's Claude session stays", () => {
    ranOn("S1", "p1");
    exchange("p2", "switch the ledger to sqlite", "switched it");
    ranOn("codex:t1", "p2");
    harness = "codex";
    recoverLostStart(ctx, CHAT, "codex:t1", "session", [{ text: "and the tests?", eventId: "p3" }]);
    expect(archive.sessionOn(CHAT, "codex")).toBeUndefined();
    expect(archive.sessionOn(CHAT, "claude")).toBe("S1");
    expect((pushed[0] as { text: string }).text).toContain("the Codex session this chat was on is gone");
    // the fresh thread is told the whole conversation, both harnesses' parts
    expect(sent[0]!.text).toContain("build the ledger");
    expect(sent[0]!.text).toContain("switch the ledger to sqlite");
  });
});

describe("what rides in ahead of a prompt", () => {
  test("a harness the chat has never run on is told the whole conversation", () => {
    ranOn("S1", "p1");
    harness = "codex";
    const { brief, harness: to } = catchUp(ctx, CHAT, "and now?");
    expect(to).toBe("codex");
    expect(brief).toContain("<compacted-history>");
    expect(brief).toContain("build the ledger");
  });

  test("a session that was there for everything is told nothing", () => {
    ranOn("S1", "p1");
    expect(catchUp(ctx, CHAT, "and now?").brief).toBe("");
  });

  test("a session the chat comes back to is told only what it missed", () => {
    ranOn("S1", "p1");
    exchange("p2", "switch the ledger to sqlite", "switched it to sqlite");
    ranOn("codex:t1", "p2");
    exchange("p3", "add an index on the date column", "added the index");
    ranOn("codex:t1", "p3");
    // back to Claude: its session resumes, and hears about p2 and p3 only
    const { brief } = catchUp(ctx, CHAT, "and the migrations?");
    expect(brief).toContain("<while-you-were-away>");
    expect(brief).toContain("switch the ledger to sqlite");
    expect(brief).toContain("add an index on the date column");
    expect(brief).not.toContain("build the ledger");
    // and back to Codex after a Claude turn: it hears about that one
    exchange("p4", "write the migrations", "wrote them");
    ranOn("S1", "p4");
    harness = "codex";
    const again = catchUp(ctx, CHAT, "run them").brief;
    expect(again).toContain("write the migrations");
    expect(again).not.toContain("add an index on the date column");
  });

  test("a turn that never finished is told again, not assumed", () => {
    ranOn("S1", "p1");
    exchange("p2", "rename the ledger table", "renaming…");
    // sent, then the app quit before the turn ended: nothing confirmed it
    archive.noteSent(CHAT, "claude", "p2");
    expect(catchUp(ctx, CHAT, "did it work?").brief).toContain("rename the ledger table");
  });

  test("a fresh start that never said its id is told everything again", () => {
    ranOn("S1", "p1");
    harness = "codex";
    // the Codex start failed before it had a thread: sent, and no session
    archive.noteSent(CHAT, "codex", "p1");
    expect(catchUp(ctx, CHAT, "try again").brief).toContain("build the ledger");
  });

  test("the prompt going out is never told about itself", () => {
    ranOn("S1", "p1");
    archive.append(CHAT, { kind: "user", id: "p2", text: "split me up", ts: 3 } as TranscriptEvent);
    expect(catchUp(ctx, CHAT, "the first half", "p2").brief).toBe("");
  });

  test("a brief waiting for a fresh start goes to one — and a session that exists drops it as stale", () => {
    archive.setPendingBrief(CHAT, "<the compaction's brief>");
    expect(catchUp(ctx, CHAT, "carry on").brief).toContain("<the compaction's brief>");
    expect(archive.hasPendingBrief(CHAT)).toBe(false);
    ranOn("S1", "p1");
    archive.setPendingBrief(CHAT, "<stale>");
    expect(catchUp(ctx, CHAT, "carry on").brief).toBe("");
    expect(archive.hasPendingBrief(CHAT)).toBe(false);
  });

  test("a new chat's first prompt is told nothing", () => {
    archive.remove(CHAT);
    expect(catchUp(ctx, CHAT, "hello")).toEqual({ brief: "", harness: "claude" });
  });
});
