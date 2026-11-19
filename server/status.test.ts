import type { UsageLimits } from "../shared/protocol.js";
import type { SidebarLayout } from "../shared/sidebar.js";
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import type {
  ModelChoice,
  PermissionRequest,
  Project,
  ServerMessage,
  StatusReport,
  TranscriptEvent,
} from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { projectWatch } from "./projectWatch.js";
import { SendQueues } from "./queue.js";
import { createRequestHandler } from "./routes.js";
import { LIVE_PING_MS, statusReport, StatusStream } from "./status.js";
import { TalkBook } from "./talk.js";
import { TeamGovernor } from "./team.js";

const TOKEN = "local-token";

/** Three projects and a hidden one, every chat at rest. */
function world() {
  const projects: Project[] = [
    {
      id: "p-ruri",
      name: "ruri",
      path: "/tmp/ruri",
      sessions: [
        { id: "ruri-lead", title: "Lead", lead: true },
        { id: "ruri-server", title: "Server", duty: "the server" },
        { id: "ruri-ui", title: "UI", duty: "the web UI" },
      ],
    },
    {
      id: "p-site",
      name: "site",
      path: "/tmp/site",
      sessions: [
        { id: "site-lead", title: "Lead", lead: true },
        { id: "site-liaison", title: "Liaison", liaison: true },
      ],
    },
    { id: "p-mira", name: "mira", path: "/tmp/mira", sessions: [{ id: "mira-lead", title: "Lead", lead: true }] },
    {
      id: "p-old",
      name: "old",
      path: "/tmp/old",
      hidden: true,
      sessions: [{ id: "old-lead", title: "Lead", lead: true }],
    },
  ];
  const statuses: Record<string, string> = {};
  const events: Record<string, TranscriptEvent[]> = {};
  const permissions = new Map<string, PermissionRequest>();
  const ctx = {
    options: { token: TOKEN },
    listeningPort: 0,
    store: {
      list: () => projects,
      findSession: (id: string) => {
        for (const project of projects) {
          const session = project.sessions.find((s) => s.id === id);
          if (session) return { project, session };
        }
        return undefined;
      },
    },
    manager: { statuses: () => statuses },
    queues: new SendQueues((_: ServerMessage) => {}),
    governor: new TeamGovernor({ cap: undefined }),
    retries: { has: () => false },
    turns: { work: new Map() },
    talk: new TalkBook(),
    permissions,
    archive: { events: (id: string) => events[id] ?? [], hasHistory: () => false },
  } as unknown as ServerContext;
  let ts = 1_700_000_000_000;
  const say = (chat: string, event: Partial<TranscriptEvent> & { kind: TranscriptEvent["kind"] }) => {
    ts += 1000;
    (events[chat] ??= []).push({ id: `e${ts}`, ts, ...event } as TranscriptEvent);
  };
  /** A whole turn: the prompt, the reply, how it ended. */
  const turn = (chat: string, prompt: string, reply: string, ok = true, error?: string) => {
    say(chat, { kind: "user", text: prompt });
    say(chat, { kind: "assistant", text: reply });
    say(chat, { kind: "result", ok, ...(error ? { error } : {}) });
    statuses[chat] = ok ? "idle" : "error";
    const ended = events[chat]!.at(-1) as Extract<TranscriptEvent, { kind: "result" }>;
    projectWatch(ctx).turnEnded(chat, ended);
  };
  /** A turn begun and still going. */
  const working = (chat: string, prompt: string) => {
    say(chat, { kind: "user", text: prompt });
    statuses[chat] = "working";
  };
  return { ctx, projects, statuses, events, permissions, say, turn, working, now: () => ts };
}

/** Every key anywhere in a value. */
function keys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keys(item, into);
  else if (value && typeof value === "object") {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keys(inner, into);
    }
  }
  return into;
}

describe("the status report", () => {
  test("each project's state, those needing the user first, hidden ones left out", () => {
    const w = world();
    // ruri: the lead handed a job on and is at rest; the server teammate at work
    w.turn("ruri-lead", "Build the phone's status endpoint", "Handed to the server teammate.");
    w.working("ruri-server", "Build GET /status for the phone app");
    // site: its lead ended its turn asking the user something
    w.turn("site-lead", "Redesign the header", "Two ways to go. Which one do you want?");
    // mira: done, at rest
    w.turn("mira-lead", "Fix the build", "The build passes again.");
    const report = statusReport(w.ctx, { now: w.now() });
    expect(report.projects.map((p) => [p.name, p.state])).toEqual([
      ["site", "needs-you"],
      ["ruri", "working"],
      ["mira", "idle"],
    ]);
    const [site, ruri, mira] = report.projects;
    expect(site!.doingNow).toBe("Lead asks: Which one do you want?");
    expect(ruri!.doingNow).toBe("Server: Build GET /status for the phone app");
    expect(mira!.doingNow).toBe("The build passes again.");
    expect(report.needsYou).toHaveLength(1);
    const need = report.needsYou[0]!;
    expect(need.project).toBe("site");
    expect(need.who).toBe("Lead");
    expect(need.reason).toBe("question");
    expect(need.text).toBe("Which one do you want?");
    expect(report.computer).toBeTruthy();
  });

  test("a project's lead and team, each with its state and last words", () => {
    const w = world();
    w.turn("ruri-lead", "Ship it", "Handed to the team.");
    w.turn("ruri-ui", "Tidy the sidebar", "The sidebar is tidy.");
    w.working("ruri-server", "Build GET /status");
    const ruri = statusReport(w.ctx, { now: w.now() }).projects.find((p) => p.name === "ruri")!;
    expect(ruri.lead?.name).toBe("Lead");
    expect(ruri.lead?.role).toBe("lead");
    expect(ruri.lead?.state).toBe("idle");
    expect(ruri.lead?.lastWords).toBe("Handed to the team.");
    expect(ruri.lead?.lastActive).toBeTruthy();
    const server = ruri.team.find((c) => c.name === "Server")!;
    expect(server.role).toBe("teammate");
    expect(server.duty).toBe("the server");
    expect(server.state).toBe("working");
    expect(server.doing).toBe("Build GET /status");
    const ui = ruri.team.find((c) => c.name === "UI")!;
    expect(ui.state).toBe("idle");
    expect(ui.lastWords).toBe("The sidebar is tidy.");
    expect(ui.doing).toBeUndefined();
  });

  test("a card up is the project needing the user, with what it asks", () => {
    const w = world();
    w.working("ruri-lead", "Clean up");
    w.statuses["ruri-lead"] = "permission";
    w.permissions.set("r1", {
      requestId: "r1",
      projectId: "ruri-lead",
      toolName: "Bash",
      input: { command: "rm -rf dist" },
      ts: w.now(),
    });
    // naming a component waits on no one
    w.permissions.set("r2", {
      requestId: "r2",
      projectId: "mira-lead",
      toolName: "name_component",
      kind: "component",
      input: {},
      ts: w.now(),
    });
    const report = statusReport(w.ctx, { now: w.now() });
    const ruri = report.projects[0]!;
    expect(ruri.name).toBe("ruri");
    expect(ruri.state).toBe("needs-you");
    expect(ruri.lead?.state).toBe("needs-you");
    expect(ruri.doingNow).toBe("Lead: Waiting on approval: Bash rm -rf dist");
    expect(report.needsYou.map((n) => [n.project, n.reason])).toEqual([["ruri", "card"]]);
    expect(report.projects.find((p) => p.name === "mira")!.state).toBe("idle");
  });

  test("work stopped on an error, nothing at work, is blocked", () => {
    const w = world();
    w.turn("mira-lead", "Deploy", "", false, "API overloaded");
    const report = statusReport(w.ctx, { now: w.now() });
    const mira = report.projects[0]!;
    expect(mira.name).toBe("mira");
    expect(mira.state).toBe("blocked");
    expect(mira.doingNow).toBe("Lead: Stopped on an error: API overloaded");
    expect(report.needsYou.map((n) => n.reason)).toEqual(["error"]);
  });

  test("a turn the user stopped is not an error", () => {
    const w = world();
    w.say("mira-lead", { kind: "user", text: "Deploy" });
    w.say("mira-lead", { kind: "result", ok: false, stopped: true, error: "stopped" });
    w.statuses["mira-lead"] = "error";
    expect(statusReport(w.ctx, { now: w.now() }).projects.find((p) => p.name === "mira")!.state).toBe("idle");
  });

  test("what a turn is on skips ruri's own prompts", () => {
    const w = world();
    w.say("ruri-server", { kind: "user", text: "Build GET /status" });
    w.say("ruri-server", { kind: "user", text: "↩ Back to what you were doing" });
    w.statuses["ruri-server"] = "working";
    const ruri = statusReport(w.ctx, { now: w.now() }).projects.find((p) => p.name === "ruri")!;
    expect(ruri.team.find((c) => c.name === "Server")!.doing).toBe("Build GET /status");
  });

  test("no ids, costs or tokens unless asked; ?ids=1 gives the ids", () => {
    const w = world();
    w.turn("ruri-lead", "Ship it", "Shipped.");
    w.say("ruri-lead", { kind: "result", ok: true, costUsd: 1.5, tokens: 9000 });
    w.turn("site-lead", "Header?", "Which one do you want?");
    const plain = statusReport(w.ctx, { now: w.now() });
    const text = JSON.stringify(plain);
    for (const id of ["p-ruri", "ruri-lead", "site-lead", "p-site"]) expect(text).not.toContain(id);
    const seen = keys(plain);
    for (const key of ["id", "projectId", "chatId", "costUsd", "tokens", "model", "path", "context"])
      expect(seen.has(key)).toBe(false);
    const withIds = statusReport(w.ctx, { ids: true, now: w.now() });
    const ruri = withIds.projects.find((p) => p.name === "ruri")!;
    expect(ruri.id).toBe("p-ruri");
    expect(ruri.lead?.id).toBe("ruri-lead");
    expect(withIds.needsYou[0]!.chatId).toBe("site-lead");
    expect(withIds.needsYou[0]!.projectId).toBe("p-site");
  });

  test("each harness's limits as the gauges read them, named, with times the phone can read", () => {
    const w = world();
    const at = Date.UTC(2026, 10, 17, 9, 0);
    (w.ctx as unknown as { usage: { limits: Record<string, UsageLimits> } }).usage = {
      limits: {
        claude: {
          fiveHour: 34.4,
          weekly: 12,
          scoped: { label: "Fable", percent: 15.6 },
          resets: { fiveHour: at + 3_600_000 },
          at,
        },
        codex: {},
      },
    };
    expect(statusReport(w.ctx, { now: w.now() }).usage).toEqual([
      {
        name: "Claude",
        account: "work",
        provider: "claude",
        fiveHour: 34,
        weekly: 12,
        scoped: { label: "Fable", percent: 16 },
        resets: { fiveHour: "2026-11-17T10:00:00.000Z" },
        at: "2026-11-17T09:00:00.000Z",
      },
    ]);
  });

  test("each account read is named by its account once a harness has more than one", () => {
    const w = world();
    (w.ctx as unknown as { usage: { limits: Record<string, UsageLimits> } }).usage = {
      limits: {
        "claude-personal": { weekly: 31 },
        claude: { weekly: 66, scoped: { label: "Fable", percent: 100 } },
        codex: { fiveHour: 5 },
        // an account since removed: no one's to show
        "claude:gone": { weekly: 1 },
      },
    };
    const usage = statusReport(w.ctx, { now: w.now() }).usage!;
    expect(usage.map((u) => [u.name, u.account])).toEqual([
      ["Claude (Work)", "work"],
      ["Claude (Personal)", "personal"],
      ["Codex", "codex"],
    ]);
  });

  test("with ids, every account and the one each project runs each harness on", () => {
    const w = world();
    const plain = statusReport(w.ctx, { now: w.now() });
    expect(plain.accounts).toBeUndefined();
    expect(plain.projects.every((p) => p.accounts === undefined)).toBe(true);
    const withIds = statusReport(w.ctx, { ids: true, now: w.now() });
    expect(withIds.accounts?.map((a) => [a.id, a.provider])).toEqual([
      ["work", "claude"],
      ["personal", "claude"],
      ["codex", "codex"],
    ]);
    expect(withIds.projects[0]!.accounts).toEqual({ claude: "work", codex: "codex" });
    // each chat with the account it runs on: its own, else its project's
    expect(withIds.projects[0]!.lead?.accounts).toEqual({ claude: "work", codex: "codex" });
    expect(plain.projects[0]!.lead?.accounts).toBeUndefined();
  });

  test("with ids, the models a chat can be put on, and the one each chat is on", () => {
    const w = world();
    const catalog: ModelChoice[] = [
      {
        value: "fable",
        displayName: "Fable 5.2",
        reasoningEfforts: [{ value: "low" }, { value: "high" }],
        defaultEffort: "high",
      },
      { value: "haiku", displayName: "Haiku 4.5" },
      { value: "codex:gpt-6", displayName: "GPT-6", provider: "codex", providerLabel: "Codex CLI" },
      {
        value: "opencode:opencode/big-pickle",
        displayName: "Big Pickle",
        provider: "opencode",
        providerLabel: "OpenCode",
      },
      {
        value: "opencode:ollama/bonsai-2:latest",
        displayName: "bonsai-2:latest",
        provider: "opencode",
        providerLabel: "OpenCode",
        local: "Ollama",
      },
    ];
    let starred = ["fable", "opencode:ollama/bonsai-2:latest"];
    const picks: Record<string, { model: string; effort: string }> = {
      "site-lead": { model: "codex:gpt-6", effort: "medium" },
    };
    (w.ctx as unknown as { models: { allModels: () => ModelChoice[] } }).models = { allModels: () => catalog };
    Object.assign(w.ctx.store, {
      starredModels: () => starred,
      defaultModel: () => "haiku",
      effectiveSettings: (id: string) => ({
        permissionMode: "default",
        ...(picks[id] ?? { model: "fable", effort: "high" }),
      }),
    });
    const plain = statusReport(w.ctx, { now: w.now() });
    expect(plain.models).toBeUndefined();
    expect(plain.projects.every((p) => p.lead?.model === undefined)).toBe(true);
    const withIds = statusReport(w.ctx, { ids: true, now: w.now() });
    // the starred ones, as the Mac's picker offers them, the default, and
    // the one a chat is on though nobody starred it — in the catalog's order
    expect(withIds.models).toEqual([
      {
        id: "fable",
        name: "Fable 5.2",
        provider: "Claude",
        harness: "claude",
        efforts: ["low", "high"],
        defaultEffort: "high",
      },
      { id: "haiku", name: "Haiku 4.5", provider: "Claude", harness: "claude" },
      { id: "codex:gpt-6", name: "GPT-6", provider: "Codex", harness: "codex" },
      {
        id: "opencode:ollama/bonsai-2:latest",
        name: "bonsai-2:latest",
        provider: "Ollama",
        harness: "opencode",
        local: true,
      },
    ]);
    const site = withIds.projects.find((p) => p.name === "site")!;
    expect([site.lead?.model, site.lead?.effort]).toEqual(["codex:gpt-6", "medium"]);
    const ruri = withIds.projects.find((p) => p.name === "ruri")!;
    expect([ruri.lead?.model, ruri.team[0]?.effort]).toEqual(["fable", "high"]);
    // nothing starred: the whole catalog, as the picker falls back to
    starred = [];
    expect(statusReport(w.ctx, { ids: true, now: w.now() }).models?.map((m) => m.provider)).toEqual([
      "Claude",
      "Claude",
      "Codex",
      "OpenCode",
      "Ollama",
    ]);
  });

  test("with ids, the sidebar as the Mac arranges it, a hidden project left out; and the stars", () => {
    const w = world();
    (w.ctx.store as unknown as { sidebar: () => SidebarLayout }).sidebar = () => ({
      order: ["f-work", "p-mira", "p-old"],
      folders: [{ id: "f-work", name: "Work", collapsed: true, projects: ["p-site", "p-old", "p-ruri"] }],
    });
    (w.ctx.store.list().find((p) => p.id === "p-mira") as { starred?: boolean }).starred = true;
    expect(statusReport(w.ctx, { now: w.now() }).sidebar).toBeUndefined();
    const report = statusReport(w.ctx, { ids: true, now: w.now() });
    expect(report.sidebar).toEqual({
      order: ["f-work", "p-mira"],
      folders: [{ id: "f-work", name: "Work", collapsed: true, projects: ["p-site", "p-ruri"] }],
    });
    expect(report.projects.find((p) => p.name === "mira")!.starred).toBe(true);
    expect(report.projects.find((p) => p.name === "ruri")!.starred).toBeUndefined();
  });
});

/** A response that keeps what is written to it. */
function fakeResponse() {
  const res = new EventEmitter() as EventEmitter & {
    head?: { status: number; headers: Record<string, string> };
    chunks: string[];
    ended: boolean;
    writeHead(status: number, headers: Record<string, string>): void;
    write(chunk: string): boolean;
    end(): void;
  };
  res.chunks = [];
  res.ended = false;
  res.writeHead = (status, headers) => {
    res.head = { status, headers };
  };
  res.write = (chunk) => {
    res.chunks.push(chunk);
    return true;
  };
  res.end = () => {
    res.ended = true;
  };
  return res;
}

/** The status frames written, read back. */
function frames(chunks: string[]): StatusReport[] {
  return chunks
    .filter((chunk) => chunk.startsWith("event: status\n"))
    .map((chunk) => JSON.parse(chunk.split("\ndata: ")[1]!) as StatusReport);
}

describe("the live status", () => {
  test("a frame on connect, another only when the picture changes, a ping on a quiet line", () => {
    const w = world();
    let now = w.now();
    const stream = new StatusStream(w.ctx, () => now);
    const res = fakeResponse();
    stream.add(res as unknown as http.ServerResponse, false);
    expect(res.head?.status).toBe(200);
    expect(res.head?.headers["content-type"]).toContain("text/event-stream");
    expect(frames(res.chunks)).toHaveLength(1);
    // the clock moves, nothing else does: nothing sent
    now += 2_000;
    stream.tick();
    expect(res.chunks).toHaveLength(1);
    // a teammate starts work: a new frame saying so
    w.working("ruri-server", "Build GET /status");
    stream.tick();
    const sent = frames(res.chunks);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.projects[0]!.state).toBe("working");
    // quiet for long enough: a comment, to keep the line open
    now += LIVE_PING_MS;
    stream.tick();
    expect(res.chunks.at(-1)).toBe(": still here\n\n");
    expect(frames(res.chunks)).toHaveLength(2);
    // the phone goes: nothing is left watching
    res.emit("close");
    expect(stream.size).toBe(0);
    stream.stop();
  });
});

describe("GET /status over HTTP", () => {
  async function serve(w: ReturnType<typeof world>, admitted: boolean) {
    const handle = createRequestHandler(w.ctx);
    const server = http.createServer((req, res) => handle(req, res, admitted));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    return { base: `http://127.0.0.1:${port}`, close: () => server.close() };
  }

  test("this port wants the token; through sharing, the device's key was checked at the door", async () => {
    const w = world();
    w.turn("site-lead", "Header?", "Which one do you want?");
    const local = await serve(w, false);
    try {
      expect((await fetch(`${local.base}/status`)).status).toBe(401);
      expect((await fetch(`${local.base}/status`, { headers: { "x-ruri-token": "wrong" } })).status).toBe(401);
      const ok = await fetch(`${local.base}/status`, { headers: { "x-ruri-token": TOKEN } });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toContain("application/json");
      const report = (await ok.json()) as StatusReport;
      expect(report.projects[0]!.state).toBe("needs-you");
      // another site's page gets nothing, token or not
      expect(
        (await fetch(`${local.base}/status`, { headers: { "x-ruri-token": TOKEN, origin: "https://evil.example" } }))
          .status,
      ).toBe(401);
      expect((await fetch(`${local.base}/status/live`)).status).toBe(401);
    } finally {
      local.close();
    }
    const door = await serve(w, true);
    try {
      expect((await fetch(`${door.base}/status?ids=1`)).status).toBe(200);
      const live = new AbortController();
      const res = await fetch(`${door.base}/status/live`, { signal: live.signal });
      expect(res.headers.get("content-type")).toContain("text/event-stream");
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const first = new TextDecoder().decode(value);
      expect(first.startsWith("event: status\ndata: ")).toBe(true);
      live.abort();
    } finally {
      door.close();
    }
  });
});
