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
let pushed: TranscriptEvent[];
let disposed: string[];
let sent: Array<{ text: string; images?: unknown; silent?: boolean; eventId?: string }>;

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
  ({ checkResumable, recoverLostStart } = await import("./handoff.js"));
  archive = new SessionArchive();
  archive.append(CHAT, { kind: "user", id: "p1", text: "build the ledger", ts: 1 } as TranscriptEvent);
  archive.append(CHAT, { kind: "assistant", id: "r1", text: "built it", ts: 2 } as TranscriptEvent);
  pushed = [];
  disposed = [];
  sent = [];
  const owner = { id: "p", name: "demo", path: project, sessions: [{ id: CHAT }] };
  ctx = {
    manager: {
      live: () => false,
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
    checkResumable({ ...ctx, manager: { live: () => true } } as unknown as ServerContext, CHAT);
    expect(archive.lastSessionId(CHAT)).toBe("S9");
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
    expect((pushed[0] as { text: string }).text).toContain("is gone");
  });

  test("a fork point it couldn't find says so", () => {
    archive.setLastSessionId(CHAT, "S1");
    recoverLostStart(ctx, CHAT, "S1", "point", [{ text: "go on" }]);
    expect((pushed[0] as { text: string }).text).toContain("rewound to isn't in its Claude session");
    expect(sent[0]!.text.endsWith("go on")).toBe(true);
  });
});
