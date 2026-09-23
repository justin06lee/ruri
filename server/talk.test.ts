import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  PermissionMode,
  PermissionRequest,
  Project,
  ServerMessage,
  TranscriptEvent,
} from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { answerTalk, listSeats, sendLetter, talkDropped, talkTurnEnded } from "./handlers/talk.js";
import { SendQueues } from "./queue.js";
import {
  defaultPolicy,
  letterPrompt,
  MAX_DEPTH,
  mayMessage,
  parsePolicy,
  ruleFor,
  TalkBook,
  type Pending,
} from "./talk.js";

let dir: string;
let saved: string | undefined;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-talk-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("who may message whom", () => {
  test("anyone may message anyone until the user says otherwise — never themselves", () => {
    const policy = defaultPolicy();
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "b", project: "q" })).toBe(true);
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "a", project: "p" })).toBe(false);
  });

  test("a chat's own rule beats its project's, which beats everyone's", () => {
    const policy = parsePolicy({
      everyone: { to: "nobody", projects: [], chats: [] },
      projects: { p: { to: "listed", projects: ["q"], chats: [] } },
      chats: { a2: { to: "anyone", projects: [], chats: [] } },
    });
    expect(ruleFor(policy, "x", "other").by).toBe("everyone");
    expect(ruleFor(policy, "a", "p").by).toBe("project");
    expect(ruleFor(policy, "a2", "p").by).toBe("chat");
    // everyone else: no one
    expect(mayMessage(policy, { chat: "x", project: "other" }, { chat: "b", project: "q" })).toBe(false);
    // p's chats: anything in q, and nothing else
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "b", project: "q" })).toBe(true);
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "c", project: "r" })).toBe(false);
    // a2 is let off
    expect(mayMessage(policy, { chat: "a2", project: "p" }, { chat: "c", project: "r" })).toBe(true);
  });

  test("a listed chat is reachable even when its project is not", () => {
    const policy = parsePolicy({
      everyone: { to: "listed", projects: [], chats: ["b"] },
      projects: {},
      chats: {},
    });
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "b", project: "q" })).toBe(true);
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "b2", project: "q" })).toBe(false);
  });

  test("anything unreadable falls back: the default, or no rule for that chat", () => {
    expect(parsePolicy(null)).toEqual(defaultPolicy());
    expect(parsePolicy("nope")).toEqual(defaultPolicy());
    const policy = parsePolicy({
      everyone: { to: "sideways" },
      projects: { p: { to: "nobody", projects: "q", chats: [1, "", "c", "c"] } },
      chats: { a: 7 },
    });
    expect(policy.everyone.to).toBe("anyone");
    expect(policy.projects["p"]).toEqual({ to: "nobody", projects: [], chats: ["c"] });
    expect(policy.chats).toEqual({});
  });
});

describe("the book", () => {
  test("a handle is short, stable, and not the chat's id", () => {
    const book = new TalkBook();
    const handle = book.handleOf("chat-1");
    expect(handle).toMatch(/^[0-9a-f]{8}$/);
    expect(book.handleOf("chat-1")).toBe(handle);
    expect(book.handleOf("chat-2")).not.toBe(handle);
    // another run, another salt
    expect(new TalkBook().handleOf("chat-1")).not.toBe(handle);
  });

  test("waiting on a chat that waits on you is caught, however far round", () => {
    const book = new TalkBook();
    const wait = (from: string, to: string): Pending => ({
      id: `${from}>${to}`,
      from,
      to,
      reply: "wait",
      depth: 1,
      resolve: () => {},
    });
    book.pending.set("1", wait("a", "b"));
    book.pending.set("2", wait("b", "c"));
    expect(book.waitsOn("a", "c")).toBe(true);
    expect(book.waitsOn("c", "a")).toBe(false);
    expect(book.waitsOn("b", "a")).toBe(false);
  });

  test("the limits are kept on disk", () => {
    const book = new TalkBook();
    const policy = parsePolicy({
      everyone: { to: "nobody", projects: [], chats: [] },
      projects: {},
      chats: {},
    });
    book.setPolicy(policy);
    expect(new TalkBook().policy()).toEqual(policy);
    book.setPolicy(defaultPolicy());
  });

  test("the message says whose it is, how to answer, and how to write back", () => {
    const text = letterPrompt(
      { agent: "a", project: "api", title: "Backend", letter: "l", reply: "wait", depth: 1 },
      "abcd1234",
      "what does /users return?",
    );
    expect(text).toContain('from="api · Backend"');
    expect(text).toContain("what does /users return?");
    expect(text).toContain("not from the user");
    expect(text).toContain("waiting on your answer");
    expect(text).toContain('"abcd1234"');
  });
});

/* ── the flow, against a server made of just what it touches ─────── */

function world(modes: Record<string, PermissionMode> = {}) {
  const projects: Project[] = [
    { id: "p", name: "web", path: "/tmp/web", sessions: [{ id: "a", title: "Frontend" }] },
    {
      id: "q",
      name: "api",
      path: "/tmp/api",
      sessions: [
        { id: "b", title: "Backend" },
        { id: "c", title: "Docs" },
      ],
    },
  ];
  const said: ServerMessage[] = [];
  const events: Record<string, TranscriptEvent[]> = {};
  const statuses: Record<string, string> = { a: "working", b: "working", c: "working" };
  const broadcast = (message: ServerMessage) => said.push(message);
  const ctx = {
    store: {
      list: () => projects,
      sessionIds: () => projects.flatMap((p) => p.sessions.map((s) => s.id)),
      defaultModel: () => "sonnet",
      findSession: (id: string) => {
        for (const project of projects) {
          const session = project.sessions.find((s) => s.id === id);
          if (session)
            return { project, session: { ...session, permissionMode: modes[id] ?? "bypassPermissions" } };
        }
        return undefined;
      },
    },
    talk: new TalkBook(),
    permissions: new Map<string, PermissionRequest>(),
    clients: { broadcast },
    queues: new SendQueues(broadcast),
    manager: { statuses: () => statuses },
    archive: { events: (id: string) => events[id] ?? [] },
    turns: { work: new Map() },
    retries: { has: () => false },
  } as unknown as ServerContext;
  // a message landing in a chat, as the chat's archive would then read
  const arrive = (chat: string) => {
    const entry = ctx.queues.entries.get(chat)?.shift();
    if (!entry) throw new Error(`nothing queued for ${chat}`);
    const prompt: TranscriptEvent = {
      kind: "user",
      id: `u-${entry.id}`,
      text: entry.text,
      ...(entry.from ? { from: entry.from } : {}),
      ts: 1,
    };
    events[chat] = [...(events[chat] ?? []), prompt];
    return prompt;
  };
  const answer = (
    chat: string,
    text: string,
    result: Partial<Extract<TranscriptEvent, { kind: "result" }>> = {},
  ) => {
    events[chat] = [...(events[chat] ?? []), { kind: "assistant", id: `s-${text}`, text, ts: 2 }];
    talkTurnEnded(ctx, chat, { kind: "result", id: "r", ok: true, ts: 3, ...result });
  };
  return { ctx, said, events, statuses, arrive, answer };
}

describe("a message", () => {
  test("in bypass mode it goes straight into the other chat's line, marked as whose", async () => {
    const { ctx } = world();
    const text = await sendLetter(ctx, "a", { to: "api · backend", message: "hello", reply: "later" });
    expect(text).toContain("Sent to api · Backend");
    const queued = ctx.queues.entries.get("b")!;
    expect(queued).toHaveLength(1);
    expect(queued[0]!.from).toMatchObject({
      agent: "a",
      project: "web",
      title: "Frontend",
      reply: "later",
      depth: 1,
    });
    expect(ctx.queues.visibleQueue("b")[0]!.from).toBe("web · Frontend");
    expect(ctx.talk.letters()[0]).toMatchObject({ from: "a", to: "b", status: "queued" });
  });

  test("it finds the other chat by its handle too", async () => {
    const { ctx } = world();
    const handle = ctx.talk.handleOf("c");
    expect(listSeats(ctx, "a")).toContain(`${handle}  Docs`);
    await sendLetter(ctx, "a", { to: handle, message: "hi", reply: "none" });
    expect(ctx.queues.entries.get("c")).toHaveLength(1);
  });

  test("outside bypass mode it waits on the user's card", async () => {
    const { ctx, said } = world({ a: "default" });
    const going = sendLetter(ctx, "a", { to: "Backend", message: "may I?", reply: "later" });
    const card = said.find((m) => m.type === "permission_request");
    expect(card?.type === "permission_request" && card.request.kind).toBe("message");
    expect(ctx.queues.entries.get("b")).toBeUndefined();
    const requestId = card?.type === "permission_request" ? card.request.requestId : "";
    expect(answerTalk(ctx, requestId, false)).toBe(true);
    expect(await going).toContain("did not let");
    expect(ctx.queues.entries.get("b")).toBeUndefined();
    expect(ctx.permissions.size).toBe(0);

    const again = sendLetter(ctx, "a", { to: "Backend", message: "now?", reply: "later" });
    const second = said.filter((m) => m.type === "permission_request").at(-1);
    answerTalk(ctx, second?.type === "permission_request" ? second.request.requestId : "", true);
    expect(await again).toContain("Sent to");
    expect(ctx.queues.entries.get("b")).toHaveLength(1);
  });

  test("the user's limits are held to", async () => {
    const { ctx } = world();
    ctx.talk.setPolicy({
      everyone: { to: "anyone", projects: [], chats: [] },
      projects: {},
      chats: { a: { to: "listed", projects: [], chats: ["c"] } },
    });
    expect(await sendLetter(ctx, "a", { to: "Backend", message: "x" })).toContain("has not let you");
    expect(listSeats(ctx, "a")).toContain("1 other agent is off limits");
    expect(listSeats(ctx, "a")).not.toContain("Backend");
    ctx.talk.setPolicy(defaultPolicy());
  });

  test("waiting, the answer is the other chat's last word at the end of its turn", async () => {
    const { ctx, arrive, answer } = world();
    const going = sendLetter(ctx, "a", { to: "Backend", message: "what port?" });
    arrive("b");
    answer("b", "It listens on 8080.");
    expect(await going).toBe("api · Backend answered:\n\nIt listens on 8080.");
    expect(ctx.talk.letters()[0]!.status).toBe("answered");
    expect(ctx.talk.pending.size).toBe(0);
  });

  test("asked for later, the answer comes to the sender's chat as a message", async () => {
    const { ctx, arrive, answer } = world();
    await sendLetter(ctx, "a", { to: "Backend", message: "tell me when done", reply: "later" });
    arrive("b");
    answer("b", "Done.");
    const back = ctx.queues.entries.get("a")!;
    expect(back).toHaveLength(1);
    expect(back[0]!.text).toBe("Done.");
    expect(back[0]!.from).toMatchObject({ agent: "b", answer: true });
  });

  test("a stopped turn, or one taken out of the queue, answers with what happened", async () => {
    const { ctx, arrive, answer } = world();
    const stopped = sendLetter(ctx, "a", { to: "Backend", message: "1" });
    arrive("b");
    answer("b", "half", { ok: false, stopped: true });
    expect(await stopped).toContain("stopped");

    const dropped = sendLetter(ctx, "a", { to: "Backend", message: "2" });
    talkDropped(ctx, ctx.queues.entries.get("b")![0]!.from);
    expect(await dropped).toContain("took your message out");
  });

  test("two chats waiting on each other is refused", async () => {
    const { ctx, arrive } = world();
    void sendLetter(ctx, "a", { to: "Backend", message: "q" });
    arrive("b");
    const text = await sendLetter(ctx, "b", { to: "Frontend", message: "q back?" });
    expect(text).toContain("waiting on your answer");
    // later is fine: nobody holds anybody
    expect(await sendLetter(ctx, "b", { to: "Frontend", message: "fyi", reply: "later" })).toContain(
      "Sent to",
    );
  });

  test("it stops being passed on past the depth cap", async () => {
    const { ctx, events } = world();
    events["a"] = [
      {
        kind: "user",
        id: "deep",
        text: "…",
        from: { agent: "c", project: "api", title: "Docs", letter: "x", reply: "none", depth: MAX_DEPTH },
        ts: 1,
      },
    ];
    expect(await sendLetter(ctx, "a", { to: "Backend", message: "pass it on" })).toContain("agents deep");
  });

  test("the sender's turn ending lets go of its wait and its cards", async () => {
    const { ctx, said } = world({ a: "default" });
    void sendLetter(ctx, "a", { to: "Docs", message: "may I?" });
    expect(ctx.permissions.size).toBe(1);
    talkTurnEnded(ctx, "a", { kind: "result", id: "r", ok: false, stopped: true, ts: 1 });
    expect(ctx.permissions.size).toBe(0);
    expect(said.some((m) => m.type === "permission_resolved")).toBe(true);

    const { ctx: bypass, arrive: land, answer: done } = world();
    void sendLetter(bypass, "a", { to: "Backend", message: "q" });
    talkTurnEnded(bypass, "a", { kind: "result", id: "r", ok: false, stopped: true, ts: 1 });
    land("b");
    done("b", "an answer nobody waits for");
    // not waited on, not asked for later: it stays where it landed
    expect(bypass.queues.entries.get("a")).toBeUndefined();
  });
});
