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
let pushed: TranscriptEvent[];

beforeEach(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-claude-"));
  process.env["CLAUDE_CONFIG_DIR"] = home;
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-handoff-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-handoff-project-"));
  transcripts = path.join(home, "projects", project.replace(/[^A-Za-z0-9]/g, "-"));
  fs.mkdirSync(transcripts, { recursive: true });
  fs.writeFileSync(
    path.join(transcripts, "S1.jsonl"),
    '{"type":"user","uuid":"u1"}\n{"type":"assistant","uuid":"a1"}\n',
  );
  const { SessionArchive } = await import("./archive.js");
  ({ checkResumable } = await import("./handoff.js"));
  archive = new SessionArchive();
  archive.append(CHAT, { kind: "user", id: "p1", text: "build the ledger", ts: 1 } as TranscriptEvent);
  archive.append(CHAT, { kind: "assistant", id: "r1", text: "built it", ts: 2 } as TranscriptEvent);
  pushed = [];
  const owner = { id: "p", name: "demo", path: project, sessions: [{ id: CHAT }] };
  ctx = {
    manager: { live: () => false },
    archive,
    store: {
      findSession: (id: string) => (id === CHAT ? { project: owner, session: owner.sessions[0] } : undefined),
    },
    clients: { pushEvent: (_: string, event: TranscriptEvent) => pushed.push(event) },
  } as unknown as ServerContext;
});

describe("before a prompt resumes a session", () => {
  test("a session and fork point Claude has are left alone", () => {
    archive.setLastSessionId(CHAT, "S1");
    archive.setResumeAt(CHAT, "S1", "a1");
    checkResumable(ctx, CHAT);
    expect(archive.lastSessionId(CHAT)).toBe("S1");
    expect(archive.resumePoint(CHAT)).toEqual({ session: "S1", uuid: "a1" });
    expect(pushed).toEqual([]);
  });

  test("a fork point that isn't in the session: a fresh one, with a brief", () => {
    archive.setLastSessionId(CHAT, "S1");
    archive.setResumeAt(CHAT, "S1", "3fffb460");
    checkResumable(ctx, CHAT);
    expect(archive.lastSessionId(CHAT)).toBeUndefined();
    expect(archive.resumePoint(CHAT)).toBeUndefined();
    expect(archive.takePendingBrief(CHAT)).toContain("build the ledger");
    expect(pushed[0]).toMatchObject({ kind: "info" });
  });

  test("a session Claude doesn't have — a fork that failed as it started — is let go of", () => {
    archive.setLastSessionId(CHAT, "753d7328");
    checkResumable(ctx, CHAT);
    expect(archive.lastSessionId(CHAT)).toBeUndefined();
    expect(archive.hasPendingBrief(CHAT)).toBe(true);
    expect((pushed[0] as { text: string }).text).toContain("is gone");
  });

  test("where Claude's transcripts can't be seen, or a process is up, nothing is decided", () => {
    fs.rmSync(transcripts, { recursive: true, force: true });
    archive.setLastSessionId(CHAT, "S1");
    checkResumable(ctx, CHAT);
    expect(archive.lastSessionId(CHAT)).toBe("S1");
    fs.mkdirSync(transcripts, { recursive: true });
    archive.setLastSessionId(CHAT, "S9");
    checkResumable({ ...ctx, manager: { live: () => true } } as unknown as ServerContext, CHAT);
    expect(archive.lastSessionId(CHAT)).toBe("S9");
    expect(pushed).toEqual([]);
  });
});
