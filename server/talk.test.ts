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
  carryLetter,
  listSeats,
  restoreTalk,
  sendLetter,
  askProject,
  talkChatsClosed,
  talkDropped,
  talkTurnEnded,
  waitAnswer,
} from "./handlers/talk.js";
import { promptHandlers } from "./handlers/prompts.js";
import { SendQueues } from "./queue.js";
import { TeamGovernor } from "./team.js";
import {
  defaultPolicy,
  letterPrompt,
  resumePrompt,
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

  test("a project's own rule beats everyone's", () => {
    const policy = parsePolicy({
      everyone: { to: "nobody", projects: [] },
      projects: { p: { to: "listed", projects: ["q"] } },
    });
    expect(ruleFor(policy, "other").by).toBe("everyone");
    expect(ruleFor(policy, "p").by).toBe("project");
    // everyone else: no one
    expect(mayMessage(policy, { chat: "x", project: "other" }, { chat: "b", project: "q" })).toBe(false);
    // p's team: q, and nothing else
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "b", project: "q" })).toBe(true);
    expect(mayMessage(policy, { chat: "a", project: "p" }, { chat: "c", project: "r" })).toBe(false);
  });

  test("a team talks within its own project whatever the rules say", () => {
    const policy = parsePolicy({ everyone: { to: "nobody", projects: [] }, projects: {} });
    expect(mayMessage(policy, { chat: "lead", project: "p" }, { chat: "member", project: "p" })).toBe(true);
    expect(mayMessage(policy, { chat: "member", project: "p" }, { chat: "lead", project: "p" })).toBe(true);
    expect(mayMessage(policy, { chat: "lead", project: "p" }, { chat: "b", project: "q" })).toBe(false);
  });

  test("a rule from before teams: a chat it named is that chat's project, and a chat's own rule goes", () => {
    const projectOf = (chat: string) => ({ b: "q", c: "q", d: "r" })[chat];
    const policy = parsePolicy(
      {
        everyone: { to: "listed", projects: ["s"], chats: ["b", "c", "gone"] },
        projects: {},
        chats: { a: { to: "nobody", projects: [], chats: [] } },
      },
      projectOf,
    );
    expect(policy).toEqual({ everyone: { to: "listed", projects: ["s", "q"] }, projects: {} });
  });

  test("anything unreadable falls back: the default, or no rule for that project", () => {
    expect(parsePolicy(null)).toEqual(defaultPolicy());
    expect(parsePolicy("nope")).toEqual(defaultPolicy());
    const policy = parsePolicy({
      everyone: { to: "sideways" },
      projects: { p: { to: "nobody", projects: [1, "", "q", "q"] }, r: 7 },
    });
    expect(policy.everyone.to).toBe("anyone");
    expect(policy.projects).toEqual({ p: { to: "nobody", projects: ["q"] } });
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
    const policy = parsePolicy({ everyone: { to: "nobody", projects: [] }, projects: {} });
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
  // a and c are members; b is api's liaison — the chat other projects'
  // agents reach — and each project has its lead, the user's
  const projects: Project[] = [
    {
      id: "p",
      name: "web",
      path: "/tmp/web",
      sessions: [
        { id: "web-lead", title: "Lead", lead: true },
        { id: "a", title: "Frontend" },
      ],
    },
    {
      id: "q",
      name: "api",
      path: "/tmp/api",
      sessions: [
        { id: "api-lead", title: "Lead", lead: true },
        { id: "b", title: "Backend", liaison: true },
        { id: "c", title: "Docs" },
        { id: "d", title: "Tests" },
      ],
    },
  ];
  const said: ServerMessage[] = [];
  // every chat busy — at a card, where a message waits in its line; the
  // cut-in cases set a chat "working" to have one stopped for it
  const statuses: Record<string, string> = { a: "permission", b: "permission", c: "permission" };
  /** The chats whose running turn was stopped, in order. */
  const interrupted: string[] = [];
  const broadcast = (message: ServerMessage) => said.push(message);
  const ctx = {
    store: {
      list: () => projects,
      workspaceDir: () => "/tmp",
      findByQuery: (q: string) =>
        projects.find((p) => p.id === q || p.path === q || p.name.toLowerCase() === q.toLowerCase()),
      findByPath: (dir: string) => projects.find((p) => p.path === dir),
      sessionIds: () => projects.flatMap((p) => p.sessions.map((s) => s.id)),
      // a project's first chat is its lead; the rest are its team, but
      // for its liaison
      isMember: (id: string) =>
        projects.some((p) => p.sessions.findIndex((s) => s.id === id && !s.liaison) > 0),
      get: (id: string) => projects.find((p) => p.id === id),
      liaison: (projectId: string) => {
        const project = projects.find((p) => p.id === projectId)!;
        const had = project.sessions.find((s) => s.liaison);
        if (had) return had;
        const made = { id: `liaison-${projectId}`, title: "Liaison", liaison: true };
        project.sessions.splice(1, 0, made);
        return made;
      },
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
    manager: {
      // a chat made on the way — a project's liaison — is at a card too
      statuses: () => new Proxy(statuses, { get: (all, id: string) => all[id] ?? "permission" }),
      interrupt: (id: string) => interrupted.push(id),
      live: () => false,
    },
    governor: new TeamGovernor({ cap: 4 }),
    meters: { latest: () => undefined },
    archive: { events: (id: string) => events[id] ?? [] },
    turns: { work: new Map(), progress: new Map() },
    models: {
      allModels: () => [
        { value: "haiku", displayName: "Haiku 4.5" },
        { value: "codex:gpt-6-astra", displayName: "GPT-6-Astra", provider: "codex" },
      ],
    },
    retries: { has: () => false, cancelRetry: () => {} },
  } as unknown as ServerContext;
  // a message landing in a chat, as dispatch would put it there: in its
  // archive, and the book told it has gone in
  const arrive = (chat: string) => {
    // as drainQueue sends one: a cut-in waiting on its stop is spent, and
    // the line behind it moves again
    if (ctx.queues.cutIn.has(chat)) ctx.queues.releaseQueue(chat);
    ctx.queues.cutIn.delete(chat);
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
  return { ctx, said, events, statuses, interrupted, projects, arrive, speak, answer };
}

describe("a message", () => {
  test("in bypass mode it goes straight into the other chat's line, marked as whose", async () => {
    const { ctx } = world();
    const sent = await sendLetter(ctx, "a", { to: "api · backend", message: "hello", reply: "later" });
    expect(sent.text).toContain("Sent to api's liaison");
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
    const handle = ctx.talk.handleOf("b");
    expect(listSeats(ctx, "a")).toContain(`${handle}  its liaison`);
    await sendLetter(ctx, "a", { to: handle, message: "hi", reply: "none" });
    expect(ctx.queues.entries.get("b")).toHaveLength(1);
    // one on another project's team is out of reach, even by its handle —
    // and so is its lead: a project is talked to through its liaison
    expect(listSeats(ctx, "a")).not.toContain(ctx.talk.handleOf("c"));
    const sent = await sendLetter(ctx, "a", { to: ctx.talk.handleOf("c"), message: "hi", reply: "none" });
    expect(sent.text).toContain("No agent answers");
    expect(ctx.queues.entries.get("c")).toBeUndefined();
  });

  test("a project by its name alone — or by its lead's handle — is its liaison", async () => {
    const { ctx } = world();
    await sendLetter(ctx, "a", { to: "api", message: "hello", reply: "none" });
    expect(ctx.queues.entries.get("b")).toHaveLength(1);
    await sendLetter(ctx, "a", { to: ctx.talk.handleOf("api-lead"), message: "again", reply: "none" });
    expect(ctx.queues.entries.get("b")).toHaveLength(2);
    expect(ctx.queues.entries.get("api-lead")).toBeUndefined();
  });

  test("a project with no liaison yet gets one, the first time an agent from another writes", async () => {
    const { ctx, projects } = world();
    expect(listSeats(ctx, "c")).toContain("made when you first write");
    const sent = await sendLetter(ctx, "c", { to: "web", message: "hello", reply: "none" });
    expect(sent.text).toContain("Sent to web's liaison");
    expect(projects[0]!.sessions[1]).toMatchObject({ id: "liaison-p", liaison: true });
    expect(ctx.queues.entries.get("liaison-p")).toHaveLength(1);
    expect(ctx.queues.entries.get("web-lead")).toBeUndefined();
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
      everyone: { to: "nobody", projects: [] },
      projects: { q: { to: "anyone", projects: [] } },
    });
    expect((await sendLetter(ctx, "a", { to: "Backend", message: "x" })).text).toContain("has not let you");
    expect(listSeats(ctx, "a")).toContain("1 other project is off limits");
    expect(listSeats(ctx, "a")).not.toContain("Backend");
    // api's own rule lets it out; its team talks among itself either way
    expect((await sendLetter(ctx, "c", { to: "web", message: "y", reply: "none" })).text).toContain(
      "Sent to",
    );
    ctx.talk.setPolicy({ everyone: { to: "nobody", projects: [] }, projects: {} });
    expect((await sendLetter(ctx, "b", { to: "Docs", message: "z", reply: "none" })).text).toContain(
      "Sent to",
    );
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
    void sendLetter(ctx, "c", { to: "Tests", message: "q" });
    arrive("d");
    const text = (await sendLetter(ctx, "d", { to: "Docs", message: "q back?", reply: "wait" })).text;
    expect(text).toContain("waiting on your answer");
    // later is fine: nobody holds anybody
    expect((await sendLetter(ctx, "d", { to: "Docs", message: "fyi", reply: "later" })).text).toContain(
      "Sent to",
    );
  });

  test("a lead — here, the liaison — never holds for an answer: what it sends comes back later", async () => {
    const { ctx } = world();
    const sent = await sendLetter(ctx, "b", { to: "Docs", message: "q", reply: "wait" });
    expect(sent.text).toContain('a lead\'s hand-offs always come back "later"');
    expect(ctx.talk.pending.get(sent.letter!)?.reply).toBe("later");
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

  test("a message rewritten to nothing in the other chat's line — or to commands alone — is taken out, and its sender hears so", async () => {
    for (const text of ["", "/compact"]) {
      const { ctx } = world();
      const sent = sendLetter(ctx, "a", { to: "Backend", message: "a job", reply: "wait" });
      const entry = ctx.queues.entries.get("b")![0]!;
      entry.editing = true;
      promptHandlers.queue_update(ctx, {} as never, {
        type: "queue_update",
        projectId: "b",
        itemId: entry.id,
        text,
      });
      expect((await sent).text).toContain("took your message out");
      expect(ctx.talk.pending.size).toBe(0);
    }
  });

  test("the sender's turn ending takes down its cards", async () => {
    const { ctx, said } = world({ a: "default" });
    void sendLetter(ctx, "a", { to: "Backend", message: "may I?" });
    expect(ctx.permissions.size).toBe(1);
    talkTurnEnded(ctx, "a", { kind: "result", id: "r", ok: false, stopped: true, ts: 1 });
    expect(ctx.permissions.size).toBe(0);
    expect(said.some((m) => m.type === "permission_resolved")).toBe(true);
  });
});

describe("a chat that compacts itself in the middle of a message", () => {
  test("answers it with the last words of the turn that finishes the job, in the fresh session", async () => {
    const { ctx, events, arrive, speak, answer } = world();
    const sent = sendLetter(ctx, "a", { to: "Backend", message: "a long job" }, { waitMs: 5_000 });
    arrive("b");
    // the turn that asked to be compacted ends: the letter is carried over
    // (chats.ts, before talkTurnEnded), and no answer goes yet
    speak("b", "Compacting now.");
    const from = carryLetter(ctx, "b");
    expect(from?.carried).toBe(true);
    talkTurnEnded(ctx, "b", { kind: "result", id: "r1", ok: true, ts: 3 });
    expect(ctx.talk.pending.size).toBe(1);
    // the fresh session's prompt carries the letter on
    events["b"] = [
      { kind: "compaction", id: "m", text: "brief", entries: [], ts: 4 },
      { kind: "user", id: "u2", text: "↻ carry on", from: from!, ts: 5 },
    ];
    // and its turn's last words are the answer — or, compacting again, not yet
    speak("b", "Compacting again.");
    carryLetter(ctx, "b");
    talkTurnEnded(ctx, "b", { kind: "result", id: "r2", ok: true, ts: 6 });
    expect(ctx.talk.pending.size).toBe(1);
    events["b"]!.push({ kind: "user", id: "u3", text: "↻ carry on", from: from!, ts: 7 });
    answer("b", "All done: the job's report.");
    expect(await sent).toMatchObject({
      text: "api · Backend answered:\n\nAll done: the job's report.",
      answered: true,
    });
    expect(ctx.talk.pending.size).toBe(0);
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
    await sendLetter(ctx, "a", { to: "Backend", message: "2", reply: "later" });
    talkDropped(ctx, ctx.queues.entries.get("b")![0]!.from);
    const back = ctx.queues.entries.get("a")!.map((entry) => entry.text);
    expect(back).toEqual([
      "api · Backend's turn on your message failed: the API fell over.",
      "The user took your message out of api · Backend's queue before it was read.",
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

describe("a message cuts in on a chat at work", () => {
  test("it stops the running turn and goes first, then the chat is sent back to its work, then the user's queue", async () => {
    const { ctx, statuses, interrupted } = world();
    statuses["b"] = "working";
    ctx.queues.entries.set("b", [
      { id: "mine", text: "the user's own next step", uploads: [], silent: false },
    ]);
    const sent = await sendLetter(ctx, "a", { to: "Backend", message: "is the API up?", reply: "later" });
    expect(interrupted).toEqual(["b"]);
    expect(sent.text).toContain("stopped what it was doing to read it");
    const line = ctx.queues.entries.get("b")!;
    expect(line.map((entry) => entry.text)).toEqual([
      "is the API up?",
      resumePrompt("web · Frontend"),
      "the user's own next step",
    ]);
    expect(line[0]!.from).toMatchObject({ agent: "a", cutIn: true });
    expect(line[1]).toMatchObject({ resume: true });
    expect(ctx.queues.cutIn.has("b")).toBe(true);
  });

  test("the model reading it deals with it alone, and the prompt after takes it back", () => {
    const from = {
      agent: "a",
      project: "api",
      title: "Backend",
      letter: "l",
      reply: "later",
      depth: 1,
    } as const;
    expect(letterPrompt(from, "abcd1234", "hi")).not.toContain("interrupted you");
    const cut = letterPrompt({ ...from, cutIn: true }, "abcd1234", "hi");
    expect(cut).toContain("interrupted you");
    expect(cut).toContain("sent back to what you were doing");
    expect(resumePrompt("api · Backend")).toContain("Carry on exactly where you left off");
  });

  test("the way back names the command the stop cut off, and says ruri stopped it", async () => {
    const { ctx, statuses, events } = world();
    statuses["b"] = "working";
    events["b"] = [
      { kind: "user", id: "u1", text: "watch the training run", ts: 1 },
      { kind: "tool", id: "t1", name: "Bash", summary: "ssh tenet 'journalctl -u una.service -f'", ts: 2 },
    ];
    await sendLetter(ctx, "a", { to: "Backend", message: "status?", reply: "later" });
    const back = ctx.queues.entries.get("b")!.find((entry) => entry.resume)!;
    expect(back.text).toContain("Bash: ssh tenet 'journalctl -u una.service -f'");
    expect(back.text).toContain("not the user");
    expect(resumePrompt("x")).not.toContain("When you were stopped");
  });

  test("several that come at once go in the order they came, and the chat is sent back once", async () => {
    const { ctx, statuses } = world();
    statuses["b"] = "working";
    await sendLetter(ctx, "a", { to: "Backend", message: "first", reply: "later" });
    await sendLetter(ctx, "c", { to: "Backend", message: "second", reply: "later" });
    expect(ctx.queues.entries.get("b")!.map((entry) => entry.text)).toEqual([
      "first",
      "second",
      resumePrompt("web · Frontend"),
    ]);
  });

  test("a turn answering another agent that waits on it is not cut short — and what waits goes before the way back", async () => {
    const { ctx, statuses, arrive, interrupted } = world();
    statuses["b"] = "working";
    await sendLetter(ctx, "c", { to: "Backend", message: "what changed?", reply: "later" });
    arrive("b");
    interrupted.length = 0;
    await sendLetter(ctx, "a", { to: "Backend", message: "me too", reply: "later" });
    expect(interrupted).toEqual([]);
    const line = ctx.queues.entries.get("b")!;
    expect(line.map((entry) => entry.text)).toEqual(["me too", resumePrompt("api · Docs")]);
    expect(line[0]!.from?.cutIn).toBeUndefined();
  });

  test("a turn doing a job handed over with no answer wanted gives way", async () => {
    const { ctx, statuses, arrive, interrupted } = world();
    statuses["b"] = "working";
    await sendLetter(ctx, "c", { to: "Backend", message: "fix the flaky test", reply: "none" });
    arrive("b");
    interrupted.length = 0;
    await sendLetter(ctx, "a", { to: "Backend", message: "quick question", reply: "later" });
    expect(interrupted).toEqual(["b"]);
  });

  test("a chat waiting on the user at a card, or on an answer of its own, is left to it", async () => {
    const { ctx, statuses, interrupted } = world();
    await sendLetter(ctx, "a", { to: "Backend", message: "at the card", reply: "later" });
    expect(interrupted).toEqual([]);

    // c sends with "wait"; its slice runs out, but its turn is still on it
    statuses["c"] = "working";
    await sendLetter(ctx, "c", { to: "web", message: "tell me when", reply: "wait" }, { waitMs: 5 });
    interrupted.length = 0;
    await sendLetter(ctx, "b", { to: "Docs", message: "a word", reply: "later" });
    expect(interrupted).toEqual([]);
    expect(ctx.queues.entries.get("c")!.at(-1)!.from?.cutIn).toBeUndefined();
  });
});

describe("an agent deciding who to disturb, and handing jobs to other projects", () => {
  test("the list says what each chat is doing: for how long, on what, running what, and what is queued", () => {
    const { ctx, statuses, events } = world();
    statuses["b"] = "working";
    events["b"] = [
      { kind: "user", id: "u1", text: "watch the training run until DPO starts", ts: 1 },
      { kind: "tool", id: "t1", name: "Bash", summary: "ssh tenet 'journalctl -u una.service'", ts: 2 },
    ];
    (ctx.turns.progress as Map<string, { startedAt: number }>).set("b", {
      startedAt: Date.now() - 185 * 60_000,
    });
    ctx.queues.entries.set("b", [{ id: "q1", text: "next", uploads: [], silent: false }]);
    const listed = listSeats(ctx, "a");
    expect(listed).toContain('working for 3h 05m — on "watch the training run until DPO starts"');
    expect(listed).toContain("running Bash: ssh tenet");
    expect(listed).toContain("1 queued behind it");
    expect(listed).toContain("ask_project");
    // its own team, each with what it is doing
    expect(listSeats(ctx, "b")).toContain("Docs");
    expect(listSeats(ctx, "b")).toContain("waiting on the user to answer a card");
    expect(listSeats(ctx, "b")).toContain("your project, your team");
  });

  test('"queue" never stops a chat at work, and says so', async () => {
    const { ctx, statuses, interrupted } = world();
    statuses["b"] = "working";
    const sent = await sendLetter(ctx, "a", {
      to: "Backend",
      message: "later is fine",
      reply: "later",
      delivery: "queue",
    });
    expect(interrupted).toEqual([]);
    expect(sent.text).toContain("queued behind what it is doing, as you asked");
    expect(ctx.queues.entries.get("b")![0]!.from?.cutIn).toBeUndefined();
  });

  test("a chat that can't be interrupted says why", async () => {
    const { ctx } = world();
    const sent = await sendLetter(ctx, "a", { to: "Backend", message: "now please", reply: "later" });
    expect(sent.text).toContain("it could not be interrupted: it is waiting on the user");
  });

  test("ask_project hands the job to the other project's liaison, and opens no chat", async () => {
    const { ctx, projects } = world();
    const sent = await askProject(ctx, "a", {
      project: "api",
      message: "where is the auth middleware?",
      reply: "later",
    });
    expect(projects.flatMap((p) => p.sessions)).toHaveLength(6);
    expect(sent.text).toContain("Handed to api's liaison");
    expect(sent.text).toContain(ctx.talk.handleOf("b"));
    expect(ctx.queues.entries.get("b")![0]).toMatchObject({
      text: "where is the auth middleware?",
      from: { agent: "a" },
    });
  });

  test("ask_project refuses what it can't do, and starts nothing", async () => {
    const { ctx, projects } = world();
    const count = () => projects.flatMap((p) => p.sessions).length;
    expect((await askProject(ctx, "a", { project: "nowhere", message: "hi" })).text).toContain(
      'No project called "nowhere" is open',
    );
    expect((await askProject(ctx, "a", { project: "/no/such/folder", message: "hi" })).text).toContain(
      "There is no folder at /no/such/folder",
    );
    expect((await askProject(ctx, "a", { project: "api", message: "  " })).text).toContain("empty");
    // its own project is its team's to message
    expect((await askProject(ctx, "a", { project: "web", message: "hi" })).text).toContain(
      "your own project",
    );
    ctx.talk.setPolicy({ everyone: { to: "nobody", projects: [] }, projects: {} });
    expect((await askProject(ctx, "a", { project: "api", message: "hi" })).text).toContain(
      "has not let you message api",
    );
    ctx.talk.setPolicy(defaultPolicy());
    expect(count()).toBe(6);
  });

  test("outside bypass mode the liaison is asked about the way any message is, and a no sends nothing", async () => {
    const { ctx, said } = world({ a: "default" });
    const going = askProject(ctx, "a", { project: "api", message: "a question" });
    const card = said.find((m) => m.type === "permission_request");
    expect(card?.type === "permission_request" && card.request.input).toMatchObject({
      project: "api",
      text: "a question",
    });
    answerTalk(ctx, card?.type === "permission_request" ? card.request.requestId : "", false);
    expect((await going).text).toContain("did not let");
    expect(ctx.queues.entries.get("b")).toBeUndefined();
    expect(said.filter((m) => m.type === "permission_request")).toHaveLength(1);
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
    // c is halfway through its lead's message
    const halfway = await sendLetter(before.ctx, "b", { to: "Docs", message: "halfway", reply: "later" });
    before.arrive("c");
    before.speak("c", "Half of it is done.");
    // and b's message to a has been answered, the answer still in b's line
    const landed = await sendLetter(before.ctx, "b", { to: "web", message: "q", reply: "later" });
    before.arrive("liaison-p");
    before.answer("liaison-p", "answer three");
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
    expect(inB.map((entry) => entry.from?.letter)).toEqual([queued.letter, halfway.letter, landed.letter]);
    // nobody holds a call on it any more: it is told the answer comes as a message
    expect(inB[0]!.from).toMatchObject({ reply: "later", project: "web", title: "Frontend" });
    expect(inB[1]!.text).toContain("ruri was restarted while api · Docs was working on your message");
    expect(inB[1]!.text).toContain("Half of it is done.");
    expect(inB[2]).toMatchObject({ text: "answer three", from: { answer: true } });
    expect(after.ctx.queues.entries.get("a")).toBeUndefined();
    expect(after.ctx.talk.letters()).toHaveLength(3);

    // a wait coming back for the landed answer still collects it
    expect((await waitAnswer(after.ctx, "b", landed.letter!)).text).toContain("answer three");
    // the re-sent one is answered like any other, into a's chat
    after.arrive("b");
    after.answer("b", "done at last");
    expect(after.ctx.queues.entries.get("a")!.at(-1)!.text).toBe("done at last");
    after.arrive("a");
    // and b reads that c's turn never finished
    after.arrive("b");
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
