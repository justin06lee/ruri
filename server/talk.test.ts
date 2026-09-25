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
import {
  answerTalk,
  listSeats,
  restoreTalk,
  sendLetter,
  talkChatsClosed,
  talkDropped,
  talkTurnEnded,
  waitAnswer,
} from "./handlers/talk.js";
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
      text: "?",
      ts: 1,
      stage: "queued",
      waiters: new Set(),
    });
    book.pending.set("1", wait("a", "b"));
    book.pending.set("2", wait("b", "c"));
    // between two waits of its slices a chat still counts as waiting
    expect(book.waitsOn("a", "c")).toBe(true);
    expect(book.waitsOn("c", "a")).toBe(false);
    expect(book.waitsOn("b", "a")).toBe(false);
    // once its turn is over it waits on nobody
    book.pending.get("2")!.released = true;
    expect(book.waitsOn("a", "c")).toBe(false);
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

  test("a message asking for nothing back says nobody is waiting", () => {
    const text = letterPrompt(
      { agent: "a", project: "api", title: "Backend", letter: "l", reply: "none", depth: 1 },
      "abcd1234",
      "fix the flaky test",
    );
    expect(text).toContain("nobody is waiting on you");
    expect(text).toContain("nothing you say goes back");
  });
});

/* ── the flow, against a server made of just what it touches ─────── */

function world(
  modes: Record<string, PermissionMode> = {},
  /** Another run's archive, for a relaunch: transcripts outlive the process. */
  events: Record<string, TranscriptEvent[]> = {},
) {
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
  // a message landing in a chat, as dispatch would put it there: in its
  // archive, and the book told it has gone in
  const arrive = (chat: string) => {
    const entry = ctx.queues.entries.get(chat)?.shift();
    if (!entry) throw new Error(`nothing queued for ${chat}`);
    if (ctx.queues.entries.get(chat)?.length === 0) ctx.queues.entries.delete(chat);
    const prompt: TranscriptEvent = {
      kind: "user",
      id: `u-${entry.id}`,
      text: entry.text,
      ...(entry.from ? { from: entry.from } : {}),
      ts: 1,
    };
    events[chat] = [...(events[chat] ?? []), prompt];
    if (entry.from) ctx.talk.arrived(entry.from);
    return prompt;
  };
  const speak = (chat: string, text: string) => {
    events[chat] = [...(events[chat] ?? []), { kind: "assistant", id: `s-${text}`, text, ts: 2 }];
  };
  const answer = (
    chat: string,
    text: string,
    result: Partial<Extract<TranscriptEvent, { kind: "result" }>> = {},
  ) => {
    speak(chat, text);
    talkTurnEnded(ctx, chat, { kind: "result", id: "r", ok: true, ts: 3, ...result });
  };
  return { ctx, said, events, statuses, arrive, speak, answer };
}

describe("a message", () => {
  test("in bypass mode it goes straight into the other chat's line, marked as whose", async () => {
    const { ctx } = world();
    const sent = await sendLetter(ctx, "a", { to: "api · backend", message: "hello", reply: "later" });
    expect(sent.text).toContain("Sent to api · Backend");
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
    expect((await going).text).toContain("did not let");
    expect(ctx.queues.entries.get("b")).toBeUndefined();
    expect(ctx.permissions.size).toBe(0);
    expect(ctx.talk.pending.size).toBe(0);

    const again = sendLetter(ctx, "a", { to: "Backend", message: "now?", reply: "later" });
    const second = said.filter((m) => m.type === "permission_request").at(-1);
    answerTalk(ctx, second?.type === "permission_request" ? second.request.requestId : "", true);
    expect((await again).text).toContain("Sent to");
    expect(ctx.queues.entries.get("b")).toHaveLength(1);
  });

  test("the user's limits are held to", async () => {
    const { ctx } = world();
    ctx.talk.setPolicy({
      everyone: { to: "anyone", projects: [], chats: [] },
      projects: {},
      chats: { a: { to: "listed", projects: [], chats: ["c"] } },
    });
    expect((await sendLetter(ctx, "a", { to: "Backend", message: "x" })).text).toContain("has not let you");
    expect(listSeats(ctx, "a")).toContain("1 other agent is off limits");
    expect(listSeats(ctx, "a")).not.toContain("Backend");
    ctx.talk.setPolicy(defaultPolicy());
  });

  test("waiting, the answer is the other chat's last word at the end of its turn", async () => {
    const { ctx, arrive, answer } = world();
    const going = sendLetter(ctx, "a", { to: "Backend", message: "what port?" });
    arrive("b");
    answer("b", "It listens on 8080.");
    expect(await going).toMatchObject({
      text: "api · Backend answered:\n\nIt listens on 8080.",
      answered: true,
    });
    expect(ctx.talk.letters()[0]!.status).toBe("answered");
    expect(ctx.talk.pending.size).toBe(0);
    // handed to the call, so not sent again as a message
    expect(ctx.queues.entries.get("a")).toBeUndefined();
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
    // until it goes in, it is still the book's: then it is done with
    expect(ctx.talk.pending.size).toBe(1);
    arrive("a");
    expect(ctx.talk.pending.size).toBe(0);
  });

  test("a stopped turn, or one taken out of the queue, answers with what happened", async () => {
    const { ctx, arrive, speak, answer } = world();
    const stopped = sendLetter(ctx, "a", { to: "Backend", message: "1" });
    arrive("b");
    speak("b", "Looking into it.");
    answer("b", "half", { ok: false, stopped: true });
    const text = (await stopped).text;
    expect(text).toContain("stopped");
    expect(text).toContain("Looking into it.");

    const dropped = sendLetter(ctx, "a", { to: "Backend", message: "2" });
    talkDropped(ctx, ctx.queues.entries.get("b")![0]!.from);
    expect((await dropped).text).toContain("took your message out");
  });

  test("two chats waiting on each other is refused", async () => {
    const { ctx, arrive } = world();
    void sendLetter(ctx, "a", { to: "Backend", message: "q" });
    arrive("b");
    const text = (await sendLetter(ctx, "b", { to: "Frontend", message: "q back?" })).text;
    expect(text).toContain("waiting on your answer");
    // later is fine: nobody holds anybody
    expect((await sendLetter(ctx, "b", { to: "Frontend", message: "fyi", reply: "later" })).text).toContain(
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
    expect((await sendLetter(ctx, "a", { to: "Backend", message: "pass it on" })).text).toContain(
      "agents deep",
    );
  });

  test("the sender's turn ending takes down its cards", async () => {
    const { ctx, said } = world({ a: "default" });
    void sendLetter(ctx, "a", { to: "Docs", message: "may I?" });
    expect(ctx.permissions.size).toBe(1);
    talkTurnEnded(ctx, "a", { kind: "result", id: "r", ok: false, stopped: true, ts: 1 });
    expect(ctx.permissions.size).toBe(0);
    expect(said.some((m) => m.type === "permission_resolved")).toBe(true);
  });
});

describe("an answer always comes back — unless none was asked for", () => {
  test("a wait that runs out of its slice hands back the letter, and waiting again gets the answer", async () => {
    const { ctx, arrive, answer } = world();
    const first = await sendLetter(ctx, "a", { to: "Backend", message: "slow one" }, { waitMs: 20 });
    expect(first.answered).toBe(false);
    expect(first.text).toContain("No answer yet: api · Backend has yet to start on your message");
    expect(first.text).toContain(`wait_for_answer with letter "${first.letter}"`);
    const again = waitAnswer(ctx, "a", first.letter!, { waitMs: 5_000 });
    arrive("b");
    answer("b", "Here it is.");
    expect(await again).toMatchObject({ text: "api · Backend answered:\n\nHere it is.", answered: true });
    expect(ctx.queues.entries.get("a")).toBeUndefined();
    expect(ctx.talk.pending.size).toBe(0);
    // a wait after that is told where it went
    expect((await waitAnswer(ctx, "a", first.letter!)).text).toContain("handed to an earlier wait");
  });

  test("an answer landing between two waits goes into the sender's line, and the next wait takes it out", async () => {
    const { ctx, arrive, answer } = world();
    const first = await sendLetter(
      ctx,
      "a",
      { to: "Backend", message: "slow one" },
      { waitMs: 10, via: "http" },
    );
    expect(first.text).toContain(`{"do": "wait", "letter": "${first.letter}"}`);
    arrive("b");
    answer("b", "Between waits.");
    // nobody holding: on its way to the chat as a message
    expect(ctx.queues.entries.get("a")).toHaveLength(1);
    const got = await waitAnswer(ctx, "a", first.letter!, { via: "http" });
    expect(got).toMatchObject({ answered: true, letter: first.letter });
    expect(got.text).toContain("Between waits.");
    // and so not a message as well
    expect(ctx.queues.entries.get("a")).toBeUndefined();
    expect(ctx.talk.pending.size).toBe(0);
  });

  test("a wait whose call goes away — the curl cut off, the tool call cancelled — lets the answer go to the chat", async () => {
    const { ctx, arrive, answer } = world();
    const gone = new AbortController();
    const going = sendLetter(ctx, "a", { to: "Backend", message: "q" }, { signal: gone.signal });
    gone.abort();
    expect((await going).answered).toBe(false);
    arrive("b");
    answer("b", "Nobody holding.");
    const back = ctx.queues.entries.get("a")!;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ text: "Nobody holding.", from: { agent: "b", answer: true } });
  });

  test("the sender stopped while it waits: its call lets go, and the answer still comes to its chat", async () => {
    const { ctx, arrive, answer } = world();
    const held = sendLetter(ctx, "a", { to: "Backend", message: "q" });
    talkTurnEnded(ctx, "a", { kind: "result", id: "r", ok: false, stopped: true, ts: 1 });
    // a call the harness left holding (a curl in the background) is let go
    expect((await held).text).toContain("Your turn ended before the answer came");
    // and no longer counts as waiting: b may wait on a now
    expect(ctx.talk.waitsOn("a", "b")).toBe(false);
    arrive("b");
    answer("b", "an answer after the stop");
    const back = ctx.queues.entries.get("a")!;
    expect(back[0]).toMatchObject({ text: "an answer after the stop", from: { answer: true } });
  });

  test("a failed turn, or a message taken out of the line, is reported to a sender that is not waiting", async () => {
    const { ctx, arrive, answer } = world();
    await sendLetter(ctx, "a", { to: "Backend", message: "1" }, { waitMs: 5 });
    arrive("b");
    answer("b", "", { ok: false, error: "the API fell over" });
    await sendLetter(ctx, "a", { to: "Docs", message: "2", reply: "later" });
    talkDropped(ctx, ctx.queues.entries.get("c")![0]!.from);
    const back = ctx.queues.entries.get("a")!.map((entry) => entry.text);
    expect(back).toEqual([
      "api · Backend's turn on your message failed: the API fell over.",
      "The user took your message out of api · Docs's queue before it was read.",
    ]);
  });

  test('"none" sends nothing back, and the other chat is told nobody is waiting', async () => {
    const { ctx, arrive, answer } = world();
    const sent = await sendLetter(ctx, "a", {
      to: "Backend",
      message: "fix the flaky test",
      reply: "none",
    });
    expect(sent.text).toContain("nothing will come back");
    const prompt = arrive("b");
    expect(prompt.kind === "user" && prompt.from?.reply).toBe("none");
    // waiting on it is pointless, and says so
    expect((await waitAnswer(ctx, "a", sent.letter!)).text).toContain("no answer");
    answer("b", "Fixed it.");
    expect(ctx.queues.entries.get("a")).toBeUndefined();
    expect(ctx.talk.pending.size).toBe(0);
    // nor when its turn fails
    const failing = await sendLetter(ctx, "a", { to: "Backend", message: "again", reply: "none" });
    arrive("b");
    answer("b", "", { ok: false, error: "boom" });
    expect(ctx.queues.entries.get("a")).toBeUndefined();
    expect((await waitAnswer(ctx, "a", failing.letter!)).text).toContain("so none is coming");
  });

  test("an answer the user takes out of the sender's line is gone for good", async () => {
    const { ctx, arrive, answer } = world();
    await sendLetter(ctx, "a", { to: "Backend", message: "q", reply: "later" });
    arrive("b");
    answer("b", "unwanted");
    talkDropped(ctx, ctx.queues.entries.get("a")![0]!.from);
    expect(ctx.talk.pending.size).toBe(0);
  });

  test("a chat closing: whoever it owed an answer hears it never will, and what it sent is no one's", async () => {
    const { ctx } = world();
    const waiting = sendLetter(ctx, "a", { to: "Backend", message: "q" });
    await sendLetter(ctx, "c", { to: "Backend", message: "later q", reply: "later" });
    await sendLetter(ctx, "b", { to: "Docs", message: "from b", reply: "later" });
    talkChatsClosed(ctx, ["b"]);
    expect((await waiting).text).toBe("api · Backend was closed before it answered your message.");
    expect(ctx.queues.entries.get("c")!.at(-1)).toMatchObject({
      text: "api · Backend was closed before it answered your message.",
      from: { answer: true },
    });
    // b's own message is still c's to read, but nobody waits on its answer
    expect([...ctx.talk.pending.values()].map((p) => p.from)).toEqual(["c"]);
  });

  test("only the chat that sent a message may wait on it", async () => {
    const { ctx } = world();
    const sent = await sendLetter(ctx, "a", { to: "Backend", message: "q", reply: "later" });
    expect((await waitAnswer(ctx, "c", sent.letter!)).text).toContain("not one this chat sent");
    expect((await waitAnswer(ctx, "a", "nope")).text).toContain("No message of yours");
  });
});

describe("letters in flight outlive a relaunch", () => {
  test("one still in line goes in again, a landed answer goes back, and an unfinished turn is reported", async () => {
    const lettersFile = path.join(dir, "talk-letters.json");
    fs.rmSync(lettersFile, { force: true });
    const before = world();
    // a waits on b, which has yet to start on it when ruri stops
    const queued = await sendLetter(
      before.ctx,
      "a",
      { to: "Backend", message: "still in line" },
      { waitMs: 5 },
    );
    // c is halfway through a's other message
    const halfway = await sendLetter(before.ctx, "a", { to: "Docs", message: "halfway", reply: "later" });
    before.arrive("c");
    before.speak("c", "Half of it is done.");
    // and b's message to a has been answered, the answer still in b's line
    const landed = await sendLetter(before.ctx, "b", { to: "Frontend", message: "q", reply: "later" });
    before.arrive("a");
    before.answer("a", "answer three");
    expect(before.ctx.queues.entries.get("b")!.at(-1)!.from).toMatchObject({
      letter: landed.letter,
      answer: true,
    });
    const kept = JSON.parse(fs.readFileSync(lettersFile, "utf8")) as { letters: Array<{ id: string }> };
    expect(kept.letters.map((l) => l.id).sort()).toEqual(
      [queued.letter, halfway.letter, landed.letter].sort() as string[],
    );

    // the process goes, and with it every queue and every call; the
    // transcripts stay
    const after = world({}, before.events);
    restoreTalk(after.ctx);
    const inB = after.ctx.queues.entries.get("b")!;
    expect(inB.map((entry) => entry.from?.letter)).toEqual([queued.letter, landed.letter]);
    // nobody holds a call on it any more: it is told the answer comes as a message
    expect(inB[0]!.from).toMatchObject({ reply: "later", project: "web", title: "Frontend" });
    expect(inB[1]).toMatchObject({ text: "answer three", from: { answer: true } });
    const inA = after.ctx.queues.entries.get("a")!;
    expect(inA).toHaveLength(1);
    expect(inA[0]!.text).toContain("ruri was restarted while api · Docs was working on your message");
    expect(inA[0]!.text).toContain("Half of it is done.");
    expect(after.ctx.talk.letters()).toHaveLength(3);

    // a wait coming back for the landed answer still collects it
    expect((await waitAnswer(after.ctx, "b", landed.letter!)).text).toContain("answer three");
    // the re-sent one is answered like any other, into a's chat
    after.arrive("b");
    after.answer("b", "done at last");
    expect(after.ctx.queues.entries.get("a")!.at(-1)!.text).toBe("done at last");
    after.arrive("a");
    after.arrive("a");
    expect(after.ctx.talk.pending.size).toBe(0);
    expect(JSON.parse(fs.readFileSync(lettersFile, "utf8"))).toEqual({ letters: [] });
  });

  test("a turn that did finish before ruri stopped is taken as the answer", () => {
    fs.rmSync(path.join(dir, "talk-letters.json"), { force: true });
    const before = world();
    void sendLetter(before.ctx, "a", { to: "Backend", message: "q", reply: "later" });
    const prompt = before.arrive("b");
    before.speak("b", "It finished.");
    // the result is in the transcript, but ruri stopped before it was read
    before.events["b"]!.push({ kind: "result", id: "r", ok: true, ts: 3 });
    const after = world({}, before.events);
    restoreTalk(after.ctx);
    expect(prompt.kind).toBe("user");
    expect(after.ctx.queues.entries.get("a")![0]).toMatchObject({
      text: "It finished.",
      from: { answer: true },
    });
  });
});
