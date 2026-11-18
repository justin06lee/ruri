import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AskAnswers,
  LetterFrom,
  PermissionMode,
  PermissionRequest,
  Project,
  ServerMessage,
  TranscriptEvent,
} from "../shared/protocol.js";
import type { ClientConn, ServerContext } from "./context.js";
import { promptHandlers } from "./handlers/prompts.js";
import { listSeats, sendLetter, talkTurnEnded } from "./handlers/talk.js";
import {
  answerCard,
  askTrusted,
  isTrusted,
  listCards,
  readChat,
  routeCard,
  setTrusted,
  stopChat,
  trustedChats,
  trustedTurnEnded,
} from "./handlers/trusted.js";
import { promptedBy } from "./origin.js";
import { phoneFrame } from "./phoneChat.js";
import { noticeFor } from "./phonePush.js";
import { SendQueues } from "./queue.js";
import { TalkBook } from "./talk.js";
import { TeamGovernor } from "./team.js";
import { cardPrompt, parseTrusted, TrustedBook } from "./trusted.js";

let dir: string;
const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ["RURI_CONFIG_DIR", "RURI_TRUSTED_WAIT_MS"]) saved[key] = process.env[key];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-trusted-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const nobody = { readyState: 3, send() {} } as unknown as ClientConn;
const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The sidebar as the user has it: one chat a project. midna is the agent
 * they trust; web and api are projects at work; every chat idle unless a
 * test says otherwise.
 */
function world(modes: Record<string, PermissionMode> = {}, trusted: string[] = ["m"]) {
  const projects: Project[] = [
    {
      id: "m",
      name: "midna",
      path: "/tmp/midna",
      sessions: [{ id: "midna-chat", title: "Lead", lead: true }],
    },
    { id: "p", name: "web", path: "/tmp/web", sessions: [{ id: "web-chat", title: "Lead", lead: true }] },
    { id: "q", name: "api", path: "/tmp/api", sessions: [{ id: "api-chat", title: "Lead", lead: true }] },
  ];
  const said: ServerMessage[] = [];
  // every chat busy — at a card, where a message waits in its line — until
  // a prompt sets it working (the stand-in has no dispatcher to start one)
  const held: Record<string, string> = {};
  const statuses = new Proxy(held, { get: (all, id: string) => all[id] ?? "permission" });
  const events: Record<string, TranscriptEvent[]> = {};
  const interrupted: string[] = [];
  const disposed: string[] = [];
  const allowed: Array<{ id: string; allow: boolean; always: boolean }> = [];
  const answered: Array<{ id: string; answers?: AskAnswers }> = [];
  const broadcast = (message: ServerMessage) => said.push(message);
  const ctx = {
    prefs: { all: () => ({}) },
    store: {
      list: () => projects,
      workspaceDir: () => "/tmp",
      get: (id: string) => projects.find((p) => p.id === id),
      findByQuery: (q: string) => projects.find((p) => p.id === q || p.name === q),
      findByPath: (at: string) => projects.find((p) => p.path === at),
      sessionIds: () => projects.flatMap((p) => p.sessions.map((s) => s.id)),
      isMember: () => false,
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
    clients: {
      broadcast,
      pushEvent: (chat: string, event: TranscriptEvent) => {
        events[chat] = [...(events[chat] ?? []), event];
      },
    },
    queues: new SendQueues(broadcast),
    manager: {
      statuses: () => statuses,
      interrupt: (id: string) => interrupted.push(id),
      live: () => false,
      backgroundWork: () => ({ agents: 0, scripts: 0 }),
      dispose: (id: string) => disposed.push(id),
      // as a session answers a card: it comes down
      respondPermission: (id: string, allow: boolean, always: boolean) => {
        if (!ctx.permissions.delete(id)) return false;
        allowed.push({ id, allow, always });
        return true;
      },
      respondQuestion: (id: string, answers?: AskAnswers) => {
        if (!ctx.permissions.delete(id)) return "none";
        answered.push({ id, ...(answers ? { answers } : {}) });
        return "answered";
      },
    },
    crewManager: { respondPermission: () => false, respondQuestion: () => "none" },
    governor: new TeamGovernor({ cap: 4 }),
    archive: { events: (id: string) => events[id] ?? [], append: () => {} },
    turns: { work: new Map(), progress: new Map(), gates: new Map() },
    drafts: { get: () => undefined },
    retries: { has: () => false, cancelRetry: () => {} },
  } as unknown as ServerContext;
  setTrusted(ctx, trusted);
  /** A prompt landing in a chat: the user's own, or — with `from` — the
   *  message at the head of its line, as dispatch would put it there. */
  const prompt = (chat: string, from?: LetterFrom | "queued", text = "go") => {
    const entry = from === "queued" ? ctx.queues.entries.get(chat)?.shift() : undefined;
    if (from === "queued" && !entry) throw new Error(`nothing queued for ${chat}`);
    if (ctx.queues.entries.get(chat)?.length === 0) ctx.queues.entries.delete(chat);
    const whose = entry?.from ?? (from === "queued" ? undefined : from);
    const event: TranscriptEvent = {
      kind: "user",
      id: `u-${Math.random()}`,
      text: entry?.text ?? text,
      ...(whose ? { from: whose } : {}),
      ts: 1,
    };
    events[chat] = [...(events[chat] ?? []), event];
    statuses[chat] = "working";
    if (whose) ctx.talk.arrived(whose);
    return event;
  };
  /** A harness card coming up in a chat, as chats.ts raises one. */
  const card = (chat: string, id: string, extra: Partial<PermissionRequest> = {}) => {
    const request = routeCard(ctx, {
      requestId: id,
      projectId: chat,
      toolName: "Bash",
      input: { command: "git push" },
      ts: Date.now(),
      ...extra,
    });
    ctx.permissions.set(id, request);
    statuses[chat] = "permission";
    return request;
  };
  const infos = (chat: string) =>
    (events[chat] ?? []).flatMap((event) => (event.kind === "info" ? [event.text] : []));
  return {
    ctx,
    said,
    statuses,
    events,
    interrupted,
    disposed,
    allowed,
    answered,
    prompt,
    card,
    infos,
    projects,
  };
}

describe("the list of trusted agents", () => {
  test("is kept on disk, in the user's order, each with the day it was registered", () => {
    const book = new TrustedBook();
    book.set(["m", "p"], 100);
    expect(new TrustedBook().list()).toEqual([
      { project: "m", since: 100 },
      { project: "p", since: 100 },
    ]);
    // set again: one already there keeps its day, a new one gets today's
    book.set(["p", "q"], 200);
    expect(new TrustedBook().list()).toEqual([
      { project: "p", since: 100 },
      { project: "q", since: 200 },
    ]);
    book.set([]);
    expect(new TrustedBook().has("p")).toBe(false);
  });

  test("anything unreadable is no one", () => {
    expect(parseTrusted(null)).toEqual([]);
    expect(parseTrusted({ agents: "midna" })).toEqual([]);
    expect(
      parseTrusted({ agents: [{ project: "m", since: 1 }, { project: "m" }, { project: 7 }, null] }),
    ).toEqual([{ project: "m", since: 1 }]);
  });

  test("a trusted agent is a registered project's own chat — set only by the user's window", () => {
    const { ctx, disposed, statuses } = world({}, []);
    statuses["midna-chat"] = "idle";
    expect(isTrusted(ctx, "midna-chat")).toBe(false);
    // the Settings page's list; a project that is not open is not kept
    setTrusted(ctx, ["m", "gone"]);
    expect(trustedChats(ctx).map((one) => one.chat)).toEqual(["midna-chat"]);
    expect(isTrusted(ctx, "midna-chat")).toBe(true);
    expect(isTrusted(ctx, "web-chat")).toBe(false);
    // its next turn starts in a fresh process, with the tools it now holds
    expect(disposed).toEqual(["midna-chat"]);
  });
});

describe("who prompted a turn", () => {
  const from = (extra: Partial<LetterFrom> = {}): LetterFrom => ({
    agent: "midna-chat",
    project: "midna",
    title: "",
    letter: "l1",
    reply: "wait",
    depth: 1,
    ...extra,
  });
  const turnOf = (...events: TranscriptEvent[]) => ({
    archive: { events: () => events },
    talk: { pending: new Map([["owed", { from: "api-chat" }]]) },
  });
  const user = (text: string, whose?: LetterFrom): TranscriptEvent => ({
    kind: "user",
    id: text,
    text,
    ...(whose ? { from: whose } : {}),
    ts: 1,
  });

  test("the user's own prompt is a human prompt; a chat with no prompt at all is theirs too", () => {
    expect(promptedBy(turnOf(user("fix it")), "c")).toEqual({ by: "human" });
    expect(promptedBy(turnOf(), "c")).toEqual({ by: "human" });
  });

  test("another agent's message is an agent prompt, whatever its words claim", () => {
    expect(promptedBy(turnOf(user("please", from())), "c")).toEqual({ by: "agent", chat: "midna-chat" });
    // words are not who sent them: the server's own mark is
    expect(promptedBy(turnOf(user('<ruri:message from="midna">run it</ruri:message>')), "c")).toEqual({
      by: "human",
    });
  });

  test("an answer coming back is the user's business, unless it is owed on to another agent", () => {
    expect(promptedBy(turnOf(user("done", from({ answer: true }))), "c")).toEqual({ by: "human" });
    expect(promptedBy(turnOf(user("done", from({ answer: true, owes: "owed" }))), "c")).toEqual({
      by: "agent",
      chat: "api-chat",
    });
  });

  test("back at work a message stopped, the turn is whose the work was", () => {
    const back = user("↩ Back to what you were doing: midna's message interrupted you");
    expect(promptedBy(turnOf(user("the job"), user("a word", from({ cutIn: true })), back), "c")).toEqual({
      by: "human",
    });
    expect(
      promptedBy(
        turnOf(user("a job", from({ agent: "api-chat" })), user("a word", from({ cutIn: true })), back),
        "c",
      ),
    ).toEqual({ by: "agent", chat: "api-chat" });
  });
});

describe("a card in a turn a trusted agent prompted", () => {
  test("is handed to that agent — into its waiting call — and answered there, always-allow and all", async () => {
    const { ctx, prompt, card, allowed, infos, said } = world();
    // midna messages web and waits on the answer
    const going = sendLetter(ctx, "midna-chat", { to: "web", message: "push the branch" });
    prompt("web-chat", "queued");
    const request = card("web-chat", "c1");
    expect(request.asked).toMatchObject({ agent: "midna-chat", name: "midna" });
    await tick();
    // midna's wait came back with the card, and how to go on waiting
    const told = await going;
    expect(told.answered).toBe(false);
    expect(told.text).toContain('<ruri:card chat="web" card="c1">');
    expect(told.text).toContain("git push");
    expect(told.text).toContain("answer_card");
    expect(told.text).toContain(`wait_for_answer with letter "${told.letter}"`);
    // nothing went to its chat as a message
    expect(ctx.queues.entries.get("midna-chat")).toBeUndefined();

    expect(answerCard(ctx, "midna-chat", { card: "c1", allow: true, always: true })).toContain(
      "Allowed web's Bash",
    );
    expect(allowed).toEqual([{ id: "c1", allow: true, always: true }]);
    expect(ctx.permissions.has("c1")).toBe(false);
    // and the user can read what was allowed in their name
    expect(infos("web-chat")).toEqual([
      "midna, trusted to answer for you, allowed Bash: git push — and to stop asking about it in this chat",
    ]);
    expect(said.some((m) => m.type === "permission_request")).toBe(false);
  });

  test("with no call of the agent's waiting, it arrives in its chat as a message", async () => {
    const { ctx, prompt, card } = world();
    await sendLetter(ctx, "midna-chat", { to: "web", message: "push the branch", reply: "later" });
    talkTurnEnded(ctx, "midna-chat", { kind: "result", id: "r", ok: true, ts: 1 });
    prompt("web-chat", "queued");
    card("web-chat", "c1");
    await tick();
    const entry = ctx.queues.entries.get("midna-chat")![0]!;
    expect(entry.text).toContain('card="c1"');
    expect(entry.text).toContain("in the turn your message started");
    expect(entry.from).toMatchObject({ agent: "web-chat", project: "web", carried: true, reply: "none" });
  });

  test("between two waits, the agent's next wait comes back with it", async () => {
    const { ctx, prompt, card } = world();
    const first = await sendLetter(ctx, "midna-chat", { to: "web", message: "push" }, { waitMs: 5 });
    expect(first.answered).toBe(false);
    prompt("web-chat", "queued");
    card("web-chat", "c1");
    await tick();
    expect(ctx.queues.entries.get("midna-chat")).toBeUndefined();
    const { waitAnswer } = await import("./handlers/talk.js");
    const next = await waitAnswer(ctx, "midna-chat", first.letter!, { waitMs: 5_000 });
    expect(next.answered).toBe(false);
    expect(next.text).toContain('card="c1"');
  });

  test("a question card is answered by what it picks; a message card is allowed or refused", async () => {
    const { ctx, prompt, card, answered, infos } = world({ "web-chat": "default" });
    void sendLetter(ctx, "midna-chat", { to: "web", message: "ask api its port", reply: "later" });
    prompt("web-chat", "queued");
    card("web-chat", "q1", {
      toolName: "AskUserQuestion",
      kind: "question",
      input: {
        questions: [
          {
            question: "Which port?",
            header: "Port",
            options: [
              { label: "8080", description: "" },
              { label: "3000", description: "" },
            ],
            multiSelect: false,
          },
        ],
      },
    });
    expect(listCards(ctx, "midna-chat")).toContain("Which port?");
    expect(answerCard(ctx, "midna-chat", { card: "q1", answers: [{ picked: ["8080"] }] })).toBe(
      "Answered web's question.",
    );
    expect(answered[0]!.answers!.answers).toEqual({ "Which port?": "8080" });
    expect(infos("web-chat").at(-1)).toBe("midna, trusted to answer for you, answered the question: 8080");

    // web, outside bypass mode, asks leave to message api: midna's to give
    const sending = sendLetter(ctx, "web-chat", { to: "api", message: "what port?", reply: "later" });
    const up = [...ctx.permissions.values()].find((r) => r.kind === "message")!;
    expect(up.asked?.agent).toBe("midna-chat");
    expect(answerCard(ctx, "midna-chat", { card: up.requestId, allow: true })).toContain(
      "Allowed web's message",
    );
    expect((await sending).text).toContain("Sent to api");
  });

  test("left unanswered, it becomes the user's, and says so", async () => {
    process.env["RURI_TRUSTED_WAIT_MS"] = "30";
    try {
      const { ctx, prompt, card, said, infos } = world();
      void sendLetter(ctx, "midna-chat", { to: "web", message: "push", reply: "later" });
      prompt("web-chat", "queued");
      card("web-chat", "c1");
      expect(ctx.permissions.get("c1")!.asked).toBeDefined();
      // not the user's yet: the phone's chat is not "needs you"
      expect(phoneFrame(ctx, "web-chat")?.state).toBe("working");
      await tick(80);
      expect(ctx.permissions.get("c1")!.asked).toBeUndefined();
      const again = said.findLast((m) => m.type === "permission_request");
      expect(again?.type === "permission_request" && again.request).toMatchObject({ requestId: "c1" });
      expect(again?.type === "permission_request" && again.request.asked).toBeUndefined();
      expect(infos("web-chat")[0]).toContain("midna left this card unanswered");
      expect(phoneFrame(ctx, "web-chat")?.state).toBe("needs-you");
    } finally {
      delete process.env["RURI_TRUSTED_WAIT_MS"];
    }
  });

  test("an agent that ends its turn without answering has had its say: the card is the user's at once", async () => {
    const { ctx, prompt, card, infos } = world();
    await sendLetter(ctx, "midna-chat", { to: "web", message: "push", reply: "later" });
    talkTurnEnded(ctx, "midna-chat", { kind: "result", id: "r", ok: true, ts: 1 });
    prompt("web-chat", "queued");
    card("web-chat", "c1");
    await tick();
    // its turn on something else ending, the card's message still in its
    // line, is not it leaving the card: it has not read it yet
    trustedTurnEnded(ctx, "midna-chat");
    expect(ctx.permissions.get("c1")!.asked).toBeDefined();
    // the message's own turn, ended with the card still up
    prompt("midna-chat", "queued");
    trustedTurnEnded(ctx, "midna-chat");
    expect(ctx.permissions.get("c1")!.asked).toBeUndefined();
    expect(infos("web-chat")).toEqual([
      "midna ended its turn without answering this card — it is yours to answer now",
    ]);
  });

  test("a turn the user prompted, or an agent they do not trust, asks the user", async () => {
    const { ctx, prompt, card } = world();
    prompt("web-chat");
    expect(card("web-chat", "c1").asked).toBeUndefined();
    // api is not trusted: its message's cards are the user's
    await sendLetter(ctx, "api-chat", { to: "web", message: "do it", reply: "later" });
    ctx.permissions.clear();
    prompt("web-chat", "queued");
    expect(card("web-chat", "c2").asked).toBeUndefined();
    // and a card of one of the user's own agents is never handed on
    void sendLetter(ctx, "midna-chat", { to: "web", message: "do it", reply: "later" });
    prompt("web-chat", "queued");
    expect(card("web-chat", "c3", { agent: "crew-1" }).asked).toBeUndefined();
  });
});

describe("what only a trusted chat may do", () => {
  test("no one else answers cards, lists them, reads chats or stops turns", () => {
    const { ctx, prompt, card, allowed } = world();
    prompt("web-chat");
    card("web-chat", "c1");
    for (const said of [
      answerCard(ctx, "api-chat", { card: "c1", allow: true }),
      listCards(ctx, "api-chat"),
      readChat(ctx, "api-chat", { chat: "web" }),
      stopChat(ctx, "api-chat", { chat: "web" }),
    ])
      expect(said).toContain("Only a chat the user has registered as a trusted agent");
    expect(allowed).toEqual([]);
    expect(ctx.permissions.has("c1")).toBe(true);
  });

  test("a trusted chat answers any card but its own, and it is written down", () => {
    const { ctx, prompt, card, allowed, infos } = world();
    // a card in a turn the user prompted: not handed over, but midna may answer it
    prompt("web-chat");
    expect(card("web-chat", "c1").asked).toBeUndefined();
    expect(listCards(ctx, "midna-chat")).toContain('card "c1" — waiting on the user');
    expect(answerCard(ctx, "midna-chat", { card: "c1", allow: false })).toContain("Refused web's Bash");
    expect(allowed).toEqual([{ id: "c1", allow: false, always: false }]);
    expect(infos("web-chat")).toEqual(["midna, trusted to answer for you, refused Bash: git push"]);
    // its own chat's card is the user's
    prompt("midna-chat");
    card("midna-chat", "own");
    expect(answerCard(ctx, "midna-chat", { card: "own", allow: true })).toContain("the user's to answer");
    expect(ctx.permissions.has("own")).toBe(true);
    expect(answerCard(ctx, "midna-chat", { card: "nope", allow: true })).toContain('No card "nope" is up');
  });

  test("it reads any chat and stops any turn, and the chat is told who stopped it", () => {
    const { ctx, prompt, events, interrupted, infos, statuses } = world();
    prompt("web-chat", undefined, "fix the build");
    events["web-chat"]!.push(
      { kind: "tool", id: "t", name: "Bash", summary: "make build", ts: 2 },
      { kind: "assistant", id: "a", text: "Building.", ts: 3 },
    );
    const read = readChat(ctx, "midna-chat", { chat: "web" });
    expect(read).toContain("fix the build");
    expect(read).toContain("1 step: Bash: make build");
    expect(read).toContain("Building.");
    expect(readChat(ctx, "midna-chat", { chat: "nowhere" })).toContain("No chat answers");

    expect(stopChat(ctx, "midna-chat", { chat: "web" })).toContain("Stopped web's turn");
    expect(interrupted).toEqual(["web-chat"]);
    expect(ctx.talk.stopNotes.get("web-chat")).toMatchObject({ who: "midna", call: "Bash: make build" });
    expect(infos("web-chat")).toEqual(["midna, trusted to act for you, stopped this turn"]);
    statuses["api-chat"] = "idle";
    expect(stopChat(ctx, "midna-chat", { chat: "api" })).toContain("isn't at work");
  });

  test("its messages go without the user's card, whatever the talk limits say", async () => {
    const { ctx, said } = world({ "midna-chat": "default", "web-chat": "default" });
    ctx.talk.setPolicy({ everyone: { to: "nobody", projects: [] }, projects: {} });
    try {
      const sent = await sendLetter(ctx, "midna-chat", { to: "web", message: "status?", reply: "later" });
      expect(sent.text).toContain("Sent to web");
      expect(said.some((m) => m.type === "permission_request")).toBe(false);
      expect(listSeats(ctx, "midna-chat")).toContain("api — /tmp/api");
      // anyone else is held to the limits
      expect((await sendLetter(ctx, "web-chat", { to: "api", message: "x" })).text).toContain(
        "has not let you",
      );
    } finally {
      ctx.talk.setPolicy({ everyone: { to: "anyone", projects: [] }, projects: {} });
    }
  });

  test("struck from the list, it is trusted no more, and its cards are the user's", () => {
    const { ctx, prompt, card, infos } = world();
    void sendLetter(ctx, "midna-chat", { to: "web", message: "push", reply: "later" });
    prompt("web-chat", "queued");
    card("web-chat", "c1");
    setTrusted(ctx, []);
    expect(ctx.permissions.get("c1")!.asked).toBeUndefined();
    expect(infos("web-chat")[0]).toContain("midna is no longer trusted");
    expect(answerCard(ctx, "midna-chat", { card: "c1", allow: true })).toContain("Only a chat the user");
  });
});

describe("asking the trusted agent", () => {
  test("the question goes to it on a card, and its answer comes back to the call", async () => {
    const { ctx, prompt, said, infos } = world();
    prompt("web-chat");
    const asking = askTrusted(ctx, "web-chat", { question: "May codex use the deploy password?" });
    const up = said.find((m) => m.type === "permission_request");
    const request = up?.type === "permission_request" ? up.request : undefined;
    expect(request).toMatchObject({ kind: "question", projectId: "web-chat", toolName: "ask_trusted" });
    expect(request!.asked).toMatchObject({ agent: "midna-chat", name: "midna" });
    await tick();
    // midna is told, in its chat, and how to answer
    const told = ctx.queues.entries.get("midna-chat")?.[0]?.text ?? "";
    expect(told).toContain("May codex use the deploy password?");
    expect(told).toContain('"Approve", "Deny"');
    expect(told).toContain("as the agent the user trusts to decide in their place");

    const done = answerCard(ctx, "midna-chat", {
      card: request!.requestId,
      answers: [{ picked: ["approve"], other: "it is the deploy job" }],
    });
    expect(done).toBe("Answered web: Approve — it is the deploy job");
    expect(await asking).toMatchObject({
      answered: true,
      by: "agent",
      answer: "Approve — it is the deploy job",
      text: "midna, whom the user trusts to decide in their place, answered: Approve — it is the deploy job",
    });
    expect(ctx.permissions.size).toBe(0);
    expect(infos("web-chat")).toEqual([
      "midna, trusted to answer for you, answered what this chat asked: Approve — it is the deploy job",
    ]);
  });

  test("with no trusted agent, or one that leaves it, the user is asked — and may always answer first", async () => {
    // nobody registered: the card is the user's from the start
    const alone = world({}, []);
    alone.prompt("web-chat");
    const asking = askTrusted(alone.ctx, "web-chat", {
      question: "Delete the old branch?",
      options: ["Yes", "No"],
    });
    const card = [...alone.ctx.permissions.values()][0]!;
    expect(card.asked).toBeUndefined();
    void promptHandlers.question_response(alone.ctx, nobody, {
      type: "question_response",
      requestId: card.requestId,
      answers: { answers: { "Delete the old branch?": "No" } },
    });
    expect(await asking).toMatchObject({
      answered: true,
      by: "user",
      answer: "No",
      text: "The user answered: No",
    });
    expect(alone.ctx.permissions.size).toBe(0);

    // midna cannot tell: it leaves it, and the card is the user's at once
    const { ctx, prompt } = world();
    prompt("web-chat");
    const second = askTrusted(ctx, "web-chat", { question: "Rotate the key?" });
    const up = [...ctx.permissions.values()][0]!;
    expect(answerCard(ctx, "midna-chat", { card: up.requestId, dismiss: true })).toContain(
      "Left to the user",
    );
    expect(ctx.permissions.get(up.requestId)!.asked).toBeUndefined();
    void promptHandlers.question_response(ctx, nobody, {
      type: "question_response",
      requestId: up.requestId,
    });
    expect((await second).text).toContain("waved the question away");
  });

  test("a wait that runs out hands back the ask's id; asking again by it collects the answer", async () => {
    const { ctx, prompt } = world();
    prompt("web-chat");
    const first = await askTrusted(ctx, "web-chat", { question: "Ship it?" }, { via: "http", waitMs: 5 });
    expect(first.answered).toBe(false);
    expect(first.text).toContain(`{"do": "trusted", "ask": "${first.ask}"}`);
    answerCard(ctx, "midna-chat", { card: first.ask!, allow: false });
    expect(await askTrusted(ctx, "web-chat", { ask: first.ask! })).toMatchObject({
      answered: true,
      answer: "Deny",
    });
    // once collected, it is gone; and another chat's ask is not this one's
    expect((await askTrusted(ctx, "web-chat", { ask: first.ask! })).text).toContain(
      "No question of this chat's",
    );
  });

  test("a turn that ends takes its unanswered question down with it", async () => {
    const { ctx, prompt } = world();
    prompt("web-chat");
    const asking = askTrusted(ctx, "web-chat", { question: "Ship it?" });
    expect(ctx.permissions.size).toBe(1);
    trustedTurnEnded(ctx, "web-chat");
    expect(ctx.permissions.size).toBe(0);
    expect((await asking).answered).toBe(false);
  });

  test("the trusted agent's own question goes to the user: it does not ask itself", () => {
    const { ctx, prompt } = world();
    prompt("midna-chat");
    void askTrusted(ctx, "midna-chat", { question: "Am I sure?" });
    expect([...ctx.permissions.values()][0]!.asked).toBeUndefined();
  });
});

describe("the words a card arrives in", () => {
  test("say what it asks, how to answer, and that leaving it sends it to the user", () => {
    const text = cardPrompt(
      { id: "c1", chat: "web", kind: "permission", title: "It wants to use Bash:", detail: "rm -rf build" },
      "http",
      180_000,
    );
    expect(text).toContain("rm -rf build");
    expect(text).toContain('{"do": "answer", "card": "c1", "allow": true}');
    expect(text).toContain("unanswered for 3 minutes, or when your turn ends, it goes to the user instead");
    expect(text).toContain("saying your answer in words answers nothing");
  });
});

describe("work only agents prompted", () => {
  test("is not told to the phone", () => {
    const { ctx } = world();
    expect(noticeFor(ctx, { kind: "project.idle", projectId: "p", busySince: 0, at: 1 })).toMatchObject({
      kind: "finished",
    });
    expect(
      noticeFor(ctx, { kind: "project.idle", projectId: "p", busySince: 0, prompted: "agent", at: 1 }),
    ).toBeUndefined();
  });
});
