import { describe, expect, test } from "bun:test";
import {
  CARRY_ON,
  type AskAnswers,
  type AskQuestion,
  type LetterFrom,
  type ModelChoice,
  type PermissionRequest,
  type PhoneChatFrame,
  type Project,
  type ProjectStatus,
  type ServerMessage,
  type TranscriptEvent,
} from "../shared/protocol.js";
import { moveInLayout, setFolder, type SidebarLayout } from "../shared/sidebar.js";
import type { ClientConn, ServerContext } from "./context.js";
import {
  nextFrame,
  phoneAnswer,
  phoneAsks,
  phoneDraft,
  phoneItems,
  phoneQueue,
  phoneQueueDo,
  phoneAccount,
  phoneModel,
  phoneSidebar,
  phoneStop,
  readAnswerBody,
  readQueueBody,
  readSendBody,
  readSidebarBody,
} from "./phoneChat.js";
import { promptHandlers } from "./handlers/prompts.js";
import { SendQueues, type QueueEntry } from "./queue.js";

const at = 1_700_000_000_000;

describe("phoneItems", () => {
  test("what was said in full, tool calls folded into steps, ruri's own prompts left out", () => {
    const events: TranscriptEvent[] = [
      { kind: "user", id: "u1", text: "fix the build", ts: at },
      { kind: "tool", id: "t1", name: "Read", summary: "Makefile", ts: at + 1 },
      { kind: "tool", id: "t2", name: "Bash", summary: "make build", ts: at + 2 },
      { kind: "assistant", id: "a1", text: "Fixed.", ts: at + 3 },
      { kind: "result", id: "r1", ok: true, ts: at + 4 },
      { kind: "user", id: "u2", text: `${CARRY_ON}: carry on`, ts: at + 5 },
      { kind: "result", id: "r2", ok: false, error: "overloaded", ts: at + 6 },
      { kind: "result", id: "r3", ok: false, stopped: true, ts: at + 7 },
    ];
    const items = phoneItems(events);
    expect(items.map((item) => [item.id, item.kind, item.text])).toEqual([
      ["u1", "user", "fix the build"],
      ["t1", "steps", "2 steps"],
      ["a1", "assistant", "Fixed."],
      ["r2", "note", "Stopped on an error: overloaded"],
      ["r3", "note", "Stopped"],
    ]);
    expect(items[1]!.steps).toEqual(["Read: Makefile", "Bash: make build"]);
  });

  test("a prompt's attachments come with it, and files alone are still a prompt", () => {
    const attachment = {
      id: "a1",
      kind: "image" as const,
      mediaType: "image/jpeg",
      name: "photo.jpg",
      n: 1,
      url: "/uploads/a1-photo.jpg",
    };
    const items = phoneItems([
      { kind: "user", id: "u1", text: "", attachments: [attachment], ts: at },
      { kind: "user", id: "u2", text: "no file", ts: at + 1 },
      { kind: "user", id: "u3", text: "", ts: at + 2 },
    ]);
    expect(items.map((item) => item.id)).toEqual(["u1", "u2"]);
    expect(items[0]!.attachments).toEqual([attachment]);
    expect(items[1]!.attachments).toBeUndefined();
  });

  test("the reply still being written comes last, marked pending", () => {
    const items = phoneItems([{ kind: "user", id: "u1", text: "hi", ts: at }], { id: "m1", text: "Hel" });
    expect(items.at(-1)).toMatchObject({ id: "draft:m1", kind: "assistant", text: "Hel", pending: true });
  });
});

describe("nextFrame", () => {
  const frame = (items: { id: string; text: string }[]): PhoneChatFrame => ({
    chat: "c",
    name: "ruri",
    project: "ruri",
    state: "working",
    queue: [],
    items: items.map((item) => ({ ...item, kind: "assistant", at: "" })),
  });

  test("the whole list first, then only what changed or is new", () => {
    const first = nextFrame(frame([{ id: "a", text: "1" }]), new Map());
    expect(first.send?.items?.length).toBe(1);
    const second = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      first.held,
    );
    expect(second.send?.items).toBeUndefined();
    expect(second.send?.upsert?.map((item) => item.id)).toEqual(["b"]);
    const same = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      second.held,
    );
    expect(same.send).toBeUndefined();
  });

  test("a draft that became the reply: removed, and the reply added", () => {
    const held = nextFrame(frame([{ id: "draft:m", text: "Hel" }]), new Map()).held;
    const next = nextFrame(frame([{ id: "a", text: "Hello" }]), held);
    expect(next.send?.remove).toEqual(["draft:m"]);
    expect(next.send?.upsert?.map((item) => item.id)).toEqual(["a"]);
  });

  test("a change of order sends the whole list again", () => {
    const held = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      new Map(),
    ).held;
    const next = nextFrame(
      frame([
        { id: "b", text: "2" },
        { id: "a", text: "1" },
      ]),
      held,
    );
    expect(next.send?.items?.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("a send from the phone", () => {
  const file = {
    id: "a-1",
    kind: "image" as const,
    mediaType: "image/png",
    name: "x.png",
    n: 1,
    data: "aGk=",
  };
  const send = (more: Record<string, unknown>) =>
    readSendBody({ id: "c", text: "hi", clientId: "p", ...more });

  test("words, files or both", () => {
    expect(send({})?.uploads).toEqual([]);
    expect(send({ attachments: [file] })?.uploads).toEqual([file]);
    expect(send({ text: "", attachments: [file] })?.uploads).toEqual([file]);
  });

  test("not nothing, and not what isn't one", () => {
    expect(send({ text: "  " })).toBeUndefined();
    expect(send({ attachments: "x" })).toBeUndefined();
    expect(send({ attachments: [{ ...file, kind: "virus" }] })).toBeUndefined();
    expect(send({ attachments: [{ ...file, data: "" }] })).toBeUndefined();
    expect(send({ attachments: Array(21).fill(file) })).toBeUndefined();
  });

  test("an id can't walk out of the uploads folder", () => {
    for (const id of ["../../evil", "a/b", "a\\b", "..", ""])
      expect(send({ attachments: [{ ...file, id }] })).toBeUndefined();
  });

  test("only the fields it may set get through", () => {
    const body = send({ attachments: [{ ...file, url: "/x", picture: "aGk=", regions: [] }] });
    expect(Object.keys(body!.uploads[0]!).sort()).toEqual(["data", "id", "kind", "mediaType", "n", "name"]);
  });

  test("cuts in only when it says so", () => {
    expect(send({})?.now).toBe(false);
    expect(send({ now: true })?.now).toBe(true);
    expect(send({ now: "yes" })?.now).toBe(false);
  });
});

describe("the phone's hand on a queue", () => {
  const CHAT = "chat";
  const entry = (id: string, extra: Partial<QueueEntry> = {}): QueueEntry => ({
    id,
    text: `prompt ${id}`,
    uploads: [],
    silent: false,
    ...extra,
  });
  /** Another agent's message, as the queue holds one. */
  const letter: LetterFrom = {
    agent: "x",
    project: "yagami",
    title: "",
    letter: "l1",
    reply: "none",
    depth: 1,
  };

  /** A server with one chat in it: its queue real, the rest only what the
   *  queue's handlers touch. */
  function world(status: ProjectStatus, queue: QueueEntry[], held = false) {
    const sent: ServerMessage[] = [];
    const interrupted: string[] = [];
    const queues = new SendQueues((message) => sent.push(message));
    queues.entries.set(CHAT, queue);
    if (held) queues.held.set(CHAT, { by: "stop" });
    const ctx = {
      queues,
      retries: { cancelRetry: () => {} },
      manager: {
        statuses: () => ({ [CHAT]: status }),
        interrupt: (id: string) => interrupted.push(id),
      },
      clients: { broadcast: (message: ServerMessage) => sent.push(message) },
      store: { isMember: () => false, findSession: () => undefined },
    } as unknown as ServerContext;
    const line = () => (queues.entries.get(CHAT) ?? []).map((e) => e.id);
    return { ctx, queues, interrupted, line };
  }

  test("a body names a chat, what to do, and which prompt", () => {
    expect(readQueueBody({ id: "c", do: "now", itemId: "p" })).toEqual({ id: "c", do: "now", itemId: "p" });
    expect(readQueueBody({ id: "c", do: "remove", itemId: "p" })).toEqual({
      id: "c",
      do: "remove",
      itemId: "p",
    });
    expect(readQueueBody({ id: "c", do: "send", itemId: "ignored" })).toEqual({ id: "c", do: "send" });
    expect(readQueueBody({ id: "c", do: "now" })).toBeUndefined();
    expect(readQueueBody({ id: "c", do: "shuffle", itemId: "p" })).toBeUndefined();
    expect(readQueueBody({ do: "send" })).toBeUndefined();
    expect(readQueueBody({ id: 4, do: "send" })).toBeUndefined();
  });

  test("it is shown its own prompts only, the one cutting in marked", () => {
    const shown = phoneQueue([
      entry("silent", { silent: true }),
      entry("letter", { from: letter }),
      entry("cut", { cut: true }),
      entry("plain"),
    ]);
    expect(shown).toEqual([
      { id: "cut", text: "prompt cut", now: true },
      { id: "plain", text: "prompt plain" },
    ]);
  });

  test("a prompt sent now stops the running turn and stands first", () => {
    const w = world("working", [entry("1"), entry("2"), entry("3")]);
    expect(phoneQueueDo(w.ctx, { id: CHAT, do: "now", itemId: "3" })).toBe(true);
    expect(w.interrupted).toEqual([CHAT]);
    expect(w.line()).toEqual(["3", "1", "2"]);
    expect(phoneQueue(w.queues.entries.get(CHAT)!)[0]).toMatchObject({ id: "3", now: true });
  });

  test("a prompt taken out is gone, the rest as they stood", () => {
    const w = world("working", [entry("1"), entry("2")]);
    expect(phoneQueueDo(w.ctx, { id: CHAT, do: "remove", itemId: "1" })).toBe(true);
    expect(w.line()).toEqual(["2"]);
    expect(w.interrupted).toEqual([]);
  });

  test("what it isn't shown it can't touch: another agent's message, ruri's own, or nothing at all", () => {
    const w = world("working", [entry("letter", { from: letter }), entry("silent", { silent: true })]);
    for (const itemId of ["letter", "silent", "nobody"]) {
      expect(phoneQueueDo(w.ctx, { id: CHAT, do: "remove", itemId })).toBe(false);
      expect(phoneQueueDo(w.ctx, { id: CHAT, do: "now", itemId })).toBe(false);
    }
    expect(w.line()).toEqual(["letter", "silent"]);
    expect(w.interrupted).toEqual([]);
  });

  test("a queue is sent on only while it stands by", () => {
    const moving = world("working", [entry("1")]);
    expect(phoneQueueDo(moving.ctx, { id: CHAT, do: "send" })).toBe(false);
    const standing = world("working", [entry("1")], true);
    expect(phoneQueueDo(standing.ctx, { id: CHAT, do: "send" })).toBe(true);
    expect(standing.queues.held.has(CHAT)).toBe(false);
  });

  test("stop ends the running turn and takes back a cut-in", () => {
    const w = world("working", [entry("1", { cut: true })]);
    w.queues.cutIn.add(CHAT);
    phoneStop(w.ctx, CHAT);
    expect(w.interrupted).toEqual([CHAT]);
    expect(w.queues.cutIn.has(CHAT)).toBe(false);
  });
});

describe("the phone's hand on the sidebar", () => {
  /** A store with a real layout: two projects in a folder, one out, one hidden. */
  function world() {
    let layout: SidebarLayout = {
      order: ["f", "c", "hid"],
      folders: [{ id: "f", name: "Work", projects: ["a", "b"] }],
    };
    const projects = [
      { id: "a", name: "a" },
      { id: "b", name: "b" },
      { id: "c", name: "c" },
      { id: "hid", name: "hid", hidden: true },
    ];
    const sent: ServerMessage[] = [];
    const ctx = {
      store: {
        list: () => projects,
        sidebar: () => layout,
        moveInSidebar: (id: string, to: { folderId?: string; beforeId?: string }) => {
          layout = moveInLayout(layout, id, to);
        },
        setFolder: (id: string, patch: { name?: string; collapsed?: boolean }) => {
          layout = setFolder(layout, id, patch);
        },
      },
      clients: { broadcast: (message: ServerMessage) => sent.push(message) },
    } as unknown as ServerContext;
    return { ctx, sent, layout: () => layout };
  }

  test("a body moves something somewhere, or folds a folder", () => {
    expect(readSidebarBody({ do: "move", id: "a", folderId: "f", beforeId: "b" })).toEqual({
      do: "move",
      id: "a",
      folderId: "f",
      beforeId: "b",
    });
    expect(readSidebarBody({ do: "move", id: "a" })).toEqual({ do: "move", id: "a" });
    expect(readSidebarBody({ do: "fold", folderId: "f", collapsed: true })).toEqual({
      do: "fold",
      folderId: "f",
      collapsed: true,
    });
    expect(readSidebarBody({ do: "move" })).toBeUndefined();
    expect(readSidebarBody({ do: "fold", folderId: "f" })).toBeUndefined();
    expect(readSidebarBody({ do: "rename", folderId: "f", name: "x" })).toBeUndefined();
  });

  test("a project moves out of its folder and into another place, every window told", () => {
    const w = world();
    expect(phoneSidebar(w.ctx, { do: "move", id: "b", beforeId: "f" })).toBe(true);
    expect(w.layout().order).toEqual(["b", "f", "c", "hid"]);
    expect(w.layout().folders[0]!.projects).toEqual(["a"]);
    expect(w.sent.some((m) => m.type === "sidebar")).toBe(true);
    expect(phoneSidebar(w.ctx, { do: "move", id: "c", folderId: "f", beforeId: "a" })).toBe(true);
    expect(w.layout().folders[0]!.projects).toEqual(["c", "a"]);
  });

  test("a folder folds and opens", () => {
    const w = world();
    expect(phoneSidebar(w.ctx, { do: "fold", folderId: "f", collapsed: true })).toBe(true);
    expect(w.layout().folders[0]!.collapsed).toBe(true);
    expect(phoneSidebar(w.ctx, { do: "fold", folderId: "nope", collapsed: true })).toBe(false);
  });

  test("what the phone isn't shown it can't move, or move things around", () => {
    const w = world();
    const before = w.layout();
    expect(phoneSidebar(w.ctx, { do: "move", id: "hid" })).toBe(false);
    expect(phoneSidebar(w.ctx, { do: "move", id: "a", beforeId: "hid" })).toBe(false);
    expect(phoneSidebar(w.ctx, { do: "move", id: "a", folderId: "gone" })).toBe(false);
    expect(phoneSidebar(w.ctx, { do: "move", id: "nobody" })).toBe(false);
    expect(w.layout()).toBe(before);
    expect(w.sent).toEqual([]);
  });
});

describe("the phone's account menu", () => {
  test("a project it is shown goes on an account; a hidden one, or no account, doesn't", () => {
    const projects: Project[] = [
      { id: "a", name: "a", path: "/a", sessions: [{ id: "a-lead" }] },
      { id: "hid", name: "hid", path: "/hid", hidden: true, sessions: [] },
    ];
    const sent: ServerMessage[] = [];
    const ctx = {
      store: {
        list: () => projects,
        get: (id: string) => projects.find((p) => p.id === id),
        findSession: () => undefined,
        update: (id: string, patch: Partial<Project>) =>
          Object.assign(
            projects.find((p) => p.id === id)!,
            patch,
          ),
      },
      clients: { broadcast: (message: ServerMessage) => sent.push(message) },
    } as unknown as ServerContext;
    expect(phoneAccount(ctx, "a", "personal")).toBe(true);
    expect(projects[0]!.accounts).toEqual({ claude: "personal" });
    expect(sent.map((m) => m.type)).toEqual(["projects"]);
    expect(phoneAccount(ctx, "hid", "personal")).toBe(false);
    expect(phoneAccount(ctx, "a", "nobody")).toBe(false);
    expect(phoneAccount(ctx, "nope", "work")).toBe(false);
  });
});

describe("the phone's model menu", () => {
  const catalog: ModelChoice[] = [
    {
      value: "fable",
      displayName: "Fable 5.2",
      reasoningEfforts: [{ value: "low" }, { value: "high" }, { value: "xhigh" }],
      defaultEffort: "high",
    },
    {
      value: "codex:gpt-6",
      displayName: "GPT-6",
      provider: "codex",
      reasoningEfforts: [{ value: "low" }, { value: "medium" }],
      defaultEffort: "medium",
    },
    {
      value: "opencode:ollama/bonsai-2:latest",
      displayName: "bonsai-2:latest",
      provider: "opencode",
      local: "Ollama",
    },
  ];

  function world() {
    const session: { id: string; model?: string; effort?: string } = { id: "a-lead" };
    const projects: Project[] = [{ id: "a", name: "a", path: "/a", sessions: [session] }];
    const sent: ServerMessage[] = [];
    const told: string[] = [];
    const ctx = {
      models: {
        allModels: () => catalog,
        registry: { prepare: (model: string) => told.push(`prepare ${model}`) },
      },
      store: {
        list: () => projects,
        findSession: (id: string) => (id === session.id ? { project: projects[0]!, session } : undefined),
        effectiveSettings: (id: string) =>
          id === session.id
            ? {
                model: session.model || "fable",
                effort: session.effort || "xhigh",
                permissionMode: "default",
              }
            : undefined,
        setSessionSettings: (_id: string, patch: { model?: string; effort?: string }) =>
          Object.assign(session, patch),
      },
      manager: {
        setModel: (_id: string, model: string) => told.push(`model ${model}`),
        setEffort: (_id: string, effort: string) => told.push(`effort ${effort}`),
      },
      // nothing measured yet: no gauge to redraw
      turns: { contexts: new Map() },
      archive: { contextTokens: () => undefined },
      clients: { broadcast: (message: ServerMessage) => sent.push(message) },
    } as unknown as ServerContext;
    return { ctx, session, sent, told };
  }

  test("a chat goes on a model the catalog lists, as the prompt box's picker puts it", () => {
    const w = world();
    expect(phoneModel(w.ctx, "a-lead", { model: "fable" })).toEqual({ ok: true });
    // already on it: nothing to say
    expect(w.told).toEqual([]);
    expect(phoneModel(w.ctx, "a-lead", { model: "claude-made-up" })).toEqual({
      ok: false,
      error: "This computer doesn't list that model.",
    });
    expect(phoneModel(w.ctx, "nope", { model: "fable" })).toEqual({ ok: false, error: "That chat is gone." });
    expect(w.session.model).toBeUndefined();
  });

  test("moved onto a model that doesn't take its level, it goes to that model's own", () => {
    const w = world();
    expect(phoneModel(w.ctx, "a-lead", { model: "codex:gpt-6" })).toEqual({ ok: true });
    expect(w.session).toMatchObject({ model: "codex:gpt-6", effort: "medium" });
    expect(w.told).toEqual(["prepare codex:gpt-6", "model codex:gpt-6", "effort medium"]);
    expect(w.sent.map((m) => m.type)).toEqual(["projects", "projects"]);
  });

  test("a local model has no level to pick, and keeps the chat's own for when it leaves", () => {
    const w = world();
    expect(phoneModel(w.ctx, "a-lead", { model: "opencode:ollama/bonsai-2:latest" })).toEqual({ ok: true });
    expect(w.session).toEqual({ id: "a-lead", model: "opencode:ollama/bonsai-2:latest" });
    expect(phoneModel(w.ctx, "a-lead", { effort: "high" })).toEqual({
      ok: false,
      error: "That model has no reasoning levels.",
    });
  });

  test("a level is one the chat's model takes", () => {
    const w = world();
    expect(phoneModel(w.ctx, "a-lead", { effort: "low" })).toEqual({ ok: true });
    expect(w.session.effort).toBe("low");
    expect(phoneModel(w.ctx, "a-lead", { effort: "ludicrous" })).toEqual({
      ok: false,
      error: "That model doesn't take that level.",
    });
    // both at once: the level is checked against the model it is going to
    expect(phoneModel(w.ctx, "a-lead", { model: "codex:gpt-6", effort: "xhigh" })).toMatchObject({
      ok: false,
    });
    expect(w.session.model).toBeUndefined();
    expect(phoneModel(w.ctx, "a-lead", { model: "codex:gpt-6", effort: "low" })).toEqual({ ok: true });
    expect(w.session).toMatchObject({ model: "codex:gpt-6", effort: "low" });
  });
});

describe("a prompt box the same on every device", () => {
  /** Drafts as the server keeps them, and what each window is told. */
  function world() {
    const drafts = new Map<string, { text: string; attachments?: { id: string }[] }>();
    const told: Array<{ to: string; message: ServerMessage }> = [];
    const windows = ["a", "b"];
    const ctx = {
      drafts: {
        get: (id: string) => drafts.get(id),
        set: (id: string, text: string, attachments?: { id: string }[]) =>
          drafts.set(id, { text, ...(attachments ? { attachments } : {}) }),
      },
      clients: {
        broadcast: (message: ServerMessage) => windows.forEach((to) => told.push({ to, message })),
        broadcastOthers: (message: ServerMessage, except: ClientConn | undefined) =>
          windows
            .filter((to) => to !== (except as unknown as { name: string }).name)
            .forEach((to) => told.push({ to, message })),
      },
      embedder: { warm: () => {} },
      // the handler looks ahead to a fresh session only for a chat it knows
      store: { findSession: () => undefined },
    } as unknown as ServerContext;
    const window = (name: string) => ({ name }) as unknown as ClientConn;
    return { ctx, drafts, told, window };
  }

  test("written in one window, every other window is told — and not the one writing", () => {
    const w = world();
    void promptHandlers.draft(w.ctx, w.window("a"), {
      type: "draft",
      projectId: "c",
      text: "half a thought",
    });
    expect(w.drafts.get("c")?.text).toBe("half a thought");
    expect(w.told).toEqual([
      { to: "b", message: { type: "composer_draft", projectId: "c", text: "half a thought" } },
    ]);
    // the same words again (only its files changed) tell nobody
    void promptHandlers.draft(w.ctx, w.window("a"), {
      type: "draft",
      projectId: "c",
      text: "half a thought",
    });
    expect(w.told.length).toBe(1);
  });

  test("written on the phone, every window is told, the files already there kept", () => {
    const w = world();
    w.drafts.set("c", { text: "", attachments: [{ id: "f1" }] });
    phoneDraft(w.ctx, "c", "from the train");
    expect(w.drafts.get("c")).toEqual({ text: "from the train", attachments: [{ id: "f1" }] });
    expect(w.told.map((t) => t.to)).toEqual(["a", "b"]);
    phoneDraft(w.ctx, "c", "from the train");
    expect(w.told.length).toBe(2);
  });
});

describe("the phone at a card", () => {
  const CHAT = "chat";
  const card = (id: string, extra: Partial<PermissionRequest>): PermissionRequest => ({
    requestId: id,
    projectId: CHAT,
    toolName: "Bash",
    input: {},
    ts: at,
    ...extra,
  });
  const approach: AskQuestion = {
    question: "Which approach?",
    header: "Approach",
    options: [
      { label: "Rewrite", description: "from scratch", value: "rewrite", preview: "new.ts" },
      { label: "Patch", description: "the smallest change" },
    ],
    multiSelect: false,
  };
  const surfaces: AskQuestion = {
    question: "Which surfaces?",
    header: "Surfaces",
    options: [
      { label: "Web", description: "" },
      { label: "Phone", description: "" },
    ],
    multiSelect: true,
  };

  /** A server with cards up: what each answer handler was handed. */
  function world(cards: PermissionRequest[]) {
    const permissions = new Map(cards.map((c) => [c.requestId, c]));
    const allowed: Array<{ id: string; allow: boolean; always: boolean }> = [];
    const answered: Array<{ id: string; answers: AskAnswers | undefined }> = [];
    const talked: Array<{ id: string; allow: boolean }> = [];
    const ctx = {
      permissions,
      talk: {
        asks: new Map(
          cards
            .filter((c) => c.kind === "message")
            .map((c) => [
              c.requestId,
              { answer: (allow: boolean) => talked.push({ id: c.requestId, allow }) },
            ]),
        ),
      },
      manager: {
        respondPermission: (id: string, allow: boolean, always: boolean) =>
          allowed.push({ id, allow, always }),
        respondQuestion: (id: string, answers: AskAnswers | undefined) => {
          answered.push({ id, answers });
          return "answered";
        },
      },
      crewManager: { respondPermission: () => {}, respondQuestion: () => "none" },
      clients: { broadcast: () => {} },
    } as unknown as ServerContext;
    return { ctx, allowed, answered, talked };
  }

  test("it is shown what each card asks — a tool, a message, a question — and never a component to name", () => {
    const { ctx } = world([
      card("q", {
        kind: "question",
        toolName: "AskUserQuestion",
        input: { questions: [approach, surfaces] },
        ts: at + 2,
      }),
      card("p", { input: { command: "rm -rf dist" }, agent: "a1", ts: at }),
      card("m", {
        kind: "message",
        toolName: "message_agent",
        input: { to: "c2", project: "orchard", title: "Harvest", text: "How many crates?", reply: "wait" },
        ts: at + 1,
      }),
      card("n", { kind: "component", input: { name: "the bar", files: [], note: "" } }),
      card("elsewhere", { projectId: "another chat" }),
    ]);
    const asks = phoneAsks(ctx, CHAT);
    expect(asks.map((a) => a.id)).toEqual(["p", "m", "q"]);
    expect(asks[0]).toEqual({
      id: "p",
      kind: "permission",
      title: "Bash",
      detail: "rm -rf dist",
      byAgent: true,
    });
    expect(asks[1]).toEqual({
      id: "m",
      kind: "message",
      title: "Message orchard · Harvest",
      detail: "How many crates?",
    });
    expect(asks[2]).toMatchObject({ kind: "question", title: "Which approach?" });
    expect(asks[2]!.questions).toEqual([
      {
        question: "Which approach?",
        header: "Approach",
        options: [
          { label: "Rewrite", description: "from scratch" },
          { label: "Patch", description: "the smallest change" },
        ],
        multi: false,
        other: true,
      },
      {
        question: "Which surfaces?",
        header: "Surfaces",
        options: [{ label: "Web" }, { label: "Phone" }],
        multi: true,
        other: true,
      },
    ]);
  });

  test("a plan to start building, and a question only the Mac can take", () => {
    const { ctx } = world([
      card("plan", { toolName: "ExitPlanMode", input: { plan: "1. Build it" } }),
      card("secret", {
        kind: "question",
        input: {
          questions: [{ question: "The key?", header: "", options: [], multiSelect: false, secret: true }],
        },
        ts: at + 1,
      }),
    ]);
    const [plan, secret] = phoneAsks(ctx, CHAT);
    expect(plan).toMatchObject({ title: "Start building from this plan", detail: "1. Build it" });
    expect(secret).toMatchObject({ kind: "question", onMac: true });
    expect(
      phoneAnswer(ctx, { id: CHAT, ask: "secret", answers: [{ picked: [], other: "hunter2" }] }),
    ).toEqual({
      ok: false,
      error: "Answer this one on your Mac.",
    });
  });

  test("a body allows, answers or waves away", () => {
    expect(readAnswerBody({ id: "c", ask: "p", allow: false })).toEqual({ id: "c", ask: "p", allow: false });
    expect(readAnswerBody({ id: "c", ask: "p", dismiss: true })).toEqual({
      id: "c",
      ask: "p",
      dismiss: true,
    });
    expect(readAnswerBody({ id: "c", ask: "p", answers: [{ picked: ["A"], other: "b", more: 1 }] })).toEqual({
      id: "c",
      ask: "p",
      answers: [{ picked: ["A"], other: "b" }],
    });
    expect(readAnswerBody({ id: "c", ask: "p" })).toBeUndefined();
    expect(readAnswerBody({ id: "c", allow: true })).toBeUndefined();
    expect(readAnswerBody({ id: "c", ask: "p", answers: [{ picked: [1] }] })).toBeUndefined();
    expect(
      readAnswerBody({ id: "c", ask: "p", answers: [{ picked: [], other: "x".repeat(10_001) }] }),
    ).toBeUndefined();
  });

  test("a tool is allowed or refused the way the window's card does it, once, never for always", () => {
    const { ctx, allowed } = world([card("p", { input: { command: "ls" } })]);
    expect(phoneAnswer(ctx, { id: CHAT, ask: "p", allow: true })).toEqual({ ok: true });
    expect(phoneAnswer(ctx, { id: CHAT, ask: "p", allow: false })).toEqual({ ok: true });
    expect(allowed).toEqual([
      { id: "p", allow: true, always: false },
      { id: "p", allow: false, always: false },
    ]);
  });

  test("a message is let go or held back", () => {
    const { ctx, talked, allowed } = world([
      card("m", {
        kind: "message",
        input: { to: "c2", project: "orchard", title: "", text: "hi", reply: "none" },
      }),
    ]);
    expect(phoneAnswer(ctx, { id: CHAT, ask: "m", allow: true })).toEqual({ ok: true });
    expect(talked).toEqual([{ id: "m", allow: true }]);
    expect(allowed).toEqual([]);
  });

  test("a question's answers are put together as the window's card puts them", () => {
    const { ctx, answered } = world([
      card("q", { kind: "question", input: { questions: [approach, surfaces] } }),
    ]);
    expect(
      phoneAnswer(ctx, {
        id: CHAT,
        ask: "q",
        answers: [{ picked: ["Rewrite", "Not offered"] }, { picked: ["Web", "Phone"], other: "the watch" }],
      }),
    ).toEqual({ ok: true });
    expect(answered).toEqual([
      {
        id: "q",
        answers: {
          answers: { "Which approach?": "Rewrite", "Which surfaces?": "Web, Phone, the watch" },
          values: { "Which approach?": ["rewrite"], "Which surfaces?": ["Web", "Phone", "the watch"] },
          annotations: { "Which approach?": { preview: "new.ts" } },
        },
      },
    ]);
    // words of one's own stand in for the options of a one-answer question
    phoneAnswer(ctx, {
      id: CHAT,
      ask: "q",
      answers: [{ picked: ["Patch"], other: "neither" }, { picked: ["Web"] }],
    });
    expect(answered[1]!.answers!.answers).toEqual({ "Which approach?": "neither", "Which surfaces?": "Web" });
  });

  test("an answer that won't do is refused in words, and nothing is sent", () => {
    const { ctx, answered } = world([
      card("q", { kind: "question", input: { questions: [approach, surfaces] } }),
    ]);
    expect(phoneAnswer(ctx, { id: CHAT, ask: "q", answers: [{ picked: ["Patch"] }] })).toEqual({
      ok: false,
      error: "Answer each question.",
    });
    expect(
      phoneAnswer(ctx, { id: CHAT, ask: "q", answers: [{ picked: ["Patch"] }, { picked: [] }] }),
    ).toEqual({
      ok: false,
      error: "Surfaces: An answer is required.",
    });
    expect(phoneAnswer(ctx, { id: CHAT, ask: "q", allow: true })).toMatchObject({ ok: false });
    expect(answered).toEqual([]);
    // waved away: the card's own handler, with no answers
    expect(phoneAnswer(ctx, { id: CHAT, ask: "q", dismiss: true })).toEqual({ ok: true });
    expect(answered).toEqual([{ id: "q", answers: undefined }]);
  });

  test("a card that is gone, another chat's, or a component's is not answered", () => {
    const { ctx, allowed } = world([
      card("theirs", { projectId: "another chat" }),
      card("n", { kind: "component", input: { name: "x", files: [], note: "" } }),
    ]);
    for (const ask of ["gone", "theirs", "n"]) {
      expect(phoneAnswer(ctx, { id: CHAT, ask, allow: true })).toMatchObject({ ok: false });
    }
    expect(allowed).toEqual([]);
  });
});
