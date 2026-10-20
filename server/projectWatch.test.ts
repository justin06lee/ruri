import { describe, expect, test } from "bun:test";
import type { PermissionRequest, Project, ServerMessage, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import {
  asksUser,
  BLOCKED_AFTER_MS,
  IDLE_AFTER_MS,
  onProjectEvent,
  ProjectWatch,
  SCRIPTS_COUNT_MS,
  SWEEP_MS,
  type ProjectEvent,
} from "./projectWatch.js";
import { SendQueues } from "./queue.js";
import { TalkBook, type Pending } from "./talk.js";
import { TeamGovernor } from "./team.js";

/** Two projects, each a lead, a liaison and teammates; every chat at rest. */
function world() {
  const projects: Project[] = [
    {
      id: "p",
      name: "ruri",
      path: "/tmp/ruri",
      sessions: [
        { id: "lead", title: "Lead", lead: true },
        { id: "liaison", title: "Liaison", liaison: true },
        { id: "ui", title: "UI", duty: "the web UI" },
        { id: "docs", title: "Docs", duty: "the docs" },
      ],
    },
    {
      id: "q",
      name: "site",
      path: "/tmp/site",
      sessions: [
        { id: "site-lead", title: "Lead", lead: true },
        { id: "site-liaison", title: "Liaison", liaison: true },
      ],
    },
  ];
  const statuses: Record<string, string> = {};
  const events: Record<string, TranscriptEvent[]> = {};
  const retrying = new Set<string>();
  const ctx = {
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
    retries: { has: (id: string) => retrying.has(id) },
    turns: { work: new Map<string, { agents: number; scripts: number }>() },
    talk: new TalkBook(),
    permissions: new Map<string, PermissionRequest>(),
    archive: { events: (id: string) => events[id] ?? [] },
  } as unknown as ServerContext;
  let now = 1_000_000;
  const heard: ProjectEvent[] = [];
  const began: Array<{ projectId: string; busySince: number }> = [];
  const watch = new ProjectWatch(ctx, {
    now: () => now,
    emit: (event) => heard.push(event),
    busy: (projectId, busySince) => began.push({ projectId, busySince }),
  });
  /** Time passing, the watch sweeping as it goes. */
  const pass = (ms: number) => {
    for (let gone = 0; gone < ms; gone += SWEEP_MS) {
      now += Math.min(SWEEP_MS, ms - gone);
      watch.sweep();
    }
  };
  /** A chat's turn starting on a prompt. */
  const start = (chat: string, prompt: Partial<Extract<TranscriptEvent, { kind: "user" }>> = {}) => {
    events[chat] = [...(events[chat] ?? []), { kind: "user", id: `u${now}`, text: "go", ts: now, ...prompt }];
    statuses[chat] = "working";
    watch.status(chat, "working");
  };
  /** And ending, on these words. */
  const end = (
    chat: string,
    said = "Done.",
    result: Partial<Extract<TranscriptEvent, { kind: "result" }>> = {},
  ) => {
    events[chat] = [...(events[chat] ?? []), { kind: "assistant", id: `a${now}`, text: said, ts: now }];
    const ended = { kind: "result" as const, id: `r${now}`, ok: true, ts: now, ...result };
    statuses[chat] = ended.ok ? "idle" : "error";
    watch.turnEnded(chat, ended);
  };
  const queue = (chat: string, text = "next") =>
    ctx.queues.push(chat, { id: `q${now}${text}`, text, uploads: [], silent: false });
  const letter = (from: string, to: string, extra: Partial<Pending> = {}) => {
    const pending = {
      id: `l-${from}-${to}`,
      from,
      to,
      reply: "later" as const,
      depth: 1,
      text: "a job",
      ts: now,
      stage: "working" as const,
      waiters: new Set(),
      ...extra,
    } satisfies Pending;
    ctx.talk.pending.set(pending.id, pending);
    return pending;
  };
  const idles = () => heard.filter((event) => event.kind === "project.idle");
  const blocks = () => heard.filter((event) => event.kind === "project.blocked");
  return {
    ctx,
    watch,
    statuses,
    events,
    retrying,
    heard,
    began,
    pass,
    start,
    end,
    queue,
    letter,
    idles,
    blocks,
    now: () => now,
  };
}

describe("a project's team done", () => {
  test("once, a minute after its last chat goes still, with when the stretch began", () => {
    const w = world();
    const began = w.now();
    w.start("lead");
    w.pass(30_000);
    w.end("lead");
    w.pass(IDLE_AFTER_MS - SWEEP_MS);
    expect(w.idles()).toEqual([]);
    w.pass(2 * SWEEP_MS);
    expect(w.idles()).toEqual([
      { kind: "project.idle", projectId: "p", busySince: began, at: expect.any(Number) },
    ]);
    w.pass(5 * IDLE_AFTER_MS);
    expect(w.idles()).toHaveLength(1);
  });

  test("a turn shorter than a sweep is still a stretch at work", () => {
    const w = world();
    w.start("lead");
    w.end("lead");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toHaveLength(1);
  });

  test("a hand-off to a teammate never fires it: the lead still, the teammate at work", () => {
    const w = world();
    const began = w.now();
    w.start("lead");
    w.end("lead", "Handed it to UI.");
    w.pass(20_000);
    // the teammate's line, then its turn — a member waiting for a slot counts too
    w.queue("ui");
    w.ctx.governor.wait("ui");
    w.pass(IDLE_AFTER_MS * 2);
    w.ctx.governor.unwait("ui");
    w.ctx.queues.entries.delete("ui");
    w.start("ui");
    w.pass(IDLE_AFTER_MS * 3);
    expect(w.idles()).toEqual([]);
    w.end("ui");
    // the answer comes back to the lead, which relays it
    w.start("lead", {
      from: {
        agent: "ui",
        project: "ruri",
        title: "UI",
        reply: "later",
        letter: "l",
        depth: 1,
        answer: true,
      },
    });
    w.end("lead", "UI fixed it.");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toEqual([expect.objectContaining({ projectId: "p", busySince: began })]);
    // the hooks heard the stretch begin once, however many chats went busy in it
    expect(w.began).toEqual([{ projectId: "p", busySince: began }]);
  });

  test("an interrupted turn — a message cutting in — and a dropped one to retry, never fire it", () => {
    const w = world();
    w.start("ui");
    w.end("ui", "", { ok: false, stopped: true });
    w.statuses["ui"] = "idle";
    w.ctx.queues.cutIn.add("ui");
    w.queue("ui", "the letter");
    w.pass(IDLE_AFTER_MS * 2);
    w.ctx.queues.cutIn.delete("ui");
    w.ctx.queues.entries.delete("ui");
    w.start("ui");
    w.end("ui", "", { ok: false, error: "overloaded" });
    w.statuses["ui"] = "idle";
    w.retrying.add("ui");
    w.pass(IDLE_AFTER_MS * 2);
    expect(w.heard).toEqual([]);
    w.retrying.delete("ui");
    w.start("ui");
    w.end("ui");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toHaveLength(1);
  });

  test("a chat compacting itself carries on: one stretch, not two", () => {
    const w = world();
    const began = w.now();
    w.start("docs");
    w.end("docs", "Compacting now.");
    // the carry-on, first in its line, then its turn in the fresh session
    w.queue("docs", "↻ You compacted yourself");
    w.pass(SWEEP_MS * 3);
    w.ctx.queues.entries.delete("docs");
    w.start("docs");
    w.end("docs");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toEqual([expect.objectContaining({ busySince: began })]);
  });

  test("background agents count; a shell left running counts only for a while", () => {
    const w = world();
    w.start("ui");
    w.end("ui");
    w.ctx.turns.work.set("ui", { agents: 1, scripts: 0 });
    w.pass(IDLE_AFTER_MS * 5);
    expect(w.idles()).toEqual([]);
    // a dev server: the team is done once it has run on a while
    w.ctx.turns.work.set("ui", { agents: 0, scripts: 1 });
    w.pass(SCRIPTS_COUNT_MS - SWEEP_MS);
    expect(w.idles()).toEqual([]);
    w.pass(IDLE_AFTER_MS + SWEEP_MS * 3);
    expect(w.idles()).toHaveLength(1);
  });

  test("not when the user stopped it, or rewound it — and the next stretch fires as ever", () => {
    const w = world();
    w.start("lead");
    w.pass(20_000);
    w.watch.userEnded("lead");
    w.pass(SWEEP_MS);
    w.end("lead", "", { ok: false, stopped: true });
    w.statuses["lead"] = "idle";
    w.pass(IDLE_AFTER_MS * 3);
    expect(w.heard).toEqual([]);
    w.start("ui");
    w.end("ui");
    w.watch.userEnded("ui");
    w.pass(IDLE_AFTER_MS * 3);
    expect(w.heard).toEqual([]);
    w.start("lead");
    w.pass(20_000);
    w.end("lead");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toHaveLength(1);
  });

  test("the user stopping one chat while the team works on: done when the rest are", () => {
    const w = world();
    w.start("lead");
    w.start("ui");
    w.watch.userEnded("lead");
    w.end("lead", "", { ok: false, stopped: true });
    w.statuses["lead"] = "idle";
    w.pass(IDLE_AFTER_MS * 2);
    w.end("ui");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toHaveLength(1);
  });

  test("a refreshed teammate: the old chat gone, the new one with its line — still at work", () => {
    const w = world();
    w.start("docs");
    const team = w.ctx.store.list()[0]!;
    team.sessions = team.sessions.filter((s) => s.id !== "docs");
    team.sessions.push({ id: "docs-2", title: "Docs", duty: "the docs" });
    w.queue("docs-2");
    w.pass(IDLE_AFTER_MS * 2);
    expect(w.idles()).toEqual([]);
    w.ctx.queues.entries.delete("docs-2");
    w.start("docs-2");
    w.end("docs-2");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toHaveLength(1);
  });

  test("a relaunch: nothing at work seen, nothing fires — not even for a chat left in error", () => {
    const w = world();
    w.statuses["lead"] = "error";
    w.pass(IDLE_AFTER_MS * 5);
    expect(w.heard).toEqual([]);
  });

  test("the liaison answering another project, two projects at once: each done on its own", () => {
    const w = world();
    // site's lead asks ruri; ruri's liaison takes it
    w.start("site-lead");
    const asked = w.letter("site-lead", "liaison");
    w.end("site-lead", "Asked ruri.");
    w.start("liaison", {
      from: {
        agent: "site-lead",
        project: "site",
        title: "Lead",
        reply: "later",
        letter: asked.id,
        depth: 1,
      },
    });
    w.pass(IDLE_AFTER_MS * 2);
    // site waits on ruri's answer: at work still
    expect(w.idles()).toEqual([]);
    w.end("liaison", "The stack is Bun and React. Which part do you need?");
    w.ctx.talk.pending.delete(asked.id);
    w.queue("site-lead", "the answer");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    // ruri is done — its liaison's question went to an agent, not the user
    expect(w.heard).toEqual([expect.objectContaining({ kind: "project.idle", projectId: "p" })]);
    w.ctx.queues.entries.delete("site-lead");
    w.start("site-lead", {
      from: {
        agent: "liaison",
        project: "ruri",
        title: "Liaison",
        reply: "later",
        letter: asked.id,
        depth: 1,
        answer: true,
      },
    });
    w.end("site-lead", "Bun and React, per ruri.");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles().map((event) => event.projectId)).toEqual(["p", "q"]);
  });

  test("a message to another project waiting long past any job is not the team at work", () => {
    const w = world();
    w.start("lead");
    w.letter("lead", "site-liaison", { ts: w.now() - 7 * 60 * 60_000 });
    w.end("lead");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.idles()).toHaveLength(1);
  });

  test("ending on an error, with nothing to try again, is blocked — not done", () => {
    const w = world();
    w.start("ui");
    w.end("ui", "", { ok: false, error: "the account is out of credit" });
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.heard).toEqual([
      expect.objectContaining({
        kind: "project.blocked",
        chatId: "ui",
        reason: "error",
        text: "the account is out of credit",
      }),
    ]);
  });
});

describe("a project waiting on the user", () => {
  test("the lead ending on a question: blocked once, after a moment — and not done", () => {
    const w = world();
    w.start("lead");
    w.end("lead", "The fix is in and the tests pass.\n\nShould I also push it?");
    w.pass(BLOCKED_AFTER_MS - SWEEP_MS);
    expect(w.heard).toEqual([]);
    w.pass(IDLE_AFTER_MS * 3);
    expect(w.heard).toEqual([
      expect.objectContaining({
        kind: "project.blocked",
        projectId: "p",
        chatId: "lead",
        reason: "question",
        text: "Should I also push it?",
      }),
    ]);
  });

  test("answered within the moment, it is no news", () => {
    const w = world();
    w.start("lead");
    w.end("lead", "Which one: A or B?");
    w.pass(SWEEP_MS);
    w.start("lead");
    w.end("lead");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.heard.map((event) => event.kind)).toEqual(["project.idle"]);
  });

  test("a teammate's question in a turn the user typed is the user's; on another agent's job it isn't", () => {
    const w = world();
    w.start("ui", {
      from: { agent: "lead", project: "ruri", title: "Lead", reply: "later", letter: "l1", depth: 1 },
    });
    w.end("ui", "Which file did you mean?");
    w.pass(BLOCKED_AFTER_MS + SWEEP_MS);
    expect(w.blocks()).toEqual([]);
    w.start("docs");
    w.end("docs", "Want me to rewrite the intro too, or leave it?");
    w.pass(BLOCKED_AFTER_MS + SWEEP_MS);
    expect(w.blocks()).toEqual([expect.objectContaining({ chatId: "docs", reason: "question" })]);
  });

  test("a question earlier, then the team finishing later: done is still news", () => {
    const w = world();
    w.start("ui");
    w.start("lead");
    w.end("lead", "UI is on it. Do you want the docs updated too?");
    w.pass(IDLE_AFTER_MS * 2);
    w.end("ui");
    w.pass(IDLE_AFTER_MS + SWEEP_MS);
    expect(w.heard.map((event) => event.kind)).toEqual(["project.blocked", "project.idle"]);
  });

  test("a card left up: blocked once; answered at once, or a naming card, nothing", () => {
    const w = world();
    const card = (requestId: string, kind: PermissionRequest["kind"] = "permission") =>
      w.ctx.permissions.set(requestId, {
        requestId,
        projectId: "ui",
        toolName: "Bash",
        input: {},
        kind,
        ts: w.now(),
      });
    w.statuses["ui"] = "permission";
    w.watch.status("ui", "permission");
    card("quick");
    w.pass(SWEEP_MS);
    w.ctx.permissions.delete("quick");
    card("name", "component");
    card("slow", "question");
    w.pass(BLOCKED_AFTER_MS * 4);
    expect(w.blocks()).toEqual([
      expect.objectContaining({ chatId: "ui", reason: "card", text: "a question" }),
    ]);
  });

  test("a card already up at a launch was told by the run before", () => {
    const w = world();
    w.ctx.permissions.set("old", {
      requestId: "old",
      projectId: "ui",
      toolName: "Bash",
      input: {},
      ts: w.now() - 60_000,
    });
    w.pass(BLOCKED_AFTER_MS * 2);
    expect(w.blocks()).toEqual([]);
  });

  test("a rewind takes the question back", () => {
    const w = world();
    w.start("lead");
    w.end("lead", "Should I delete the old branch?");
    w.watch.userEnded("lead");
    w.pass(IDLE_AFTER_MS * 2);
    expect(w.heard).toEqual([]);
  });
});

describe("whether a reply asks the user something", () => {
  test.each([
    ["Should I also push it?", "Should I also push it?"],
    ["All green.\n\nWhich would you prefer?\n\n1. Keep it\n2. Drop it", "Which would you prefer?"],
    ["Two ways to go:\n- A, quick\n- B, thorough", undefined],
    ["Which would you prefer?\n1. Keep it\n2. Drop it", "Which would you prefer?"],
    ["Should I merge it? If so, I'll tag v1.2 after.", "Should I merge it? If so, I'll tag v1.2 after."],
    ["Want me to keep going, or stop here? Thanks!", "Want me to keep going, or stop here? Thanks!"],
    ["It's ready. **Your call** on when to ship.", "Your call on when to ship."],
    ["Let me know which you prefer.", "Let me know which you prefer."],
    ["어떻게 할까요？", "어떻게 할까요？"],
    // not asking
    ["Done. Let me know if you want the README updated too.", undefined],
    ["Why did it fail? The cache was stale, so I cleared it.", undefined],
    ["See https://example.com/search?q=ruri for the docs.", undefined],
    ["Fixed the optional chain in `a?.b`.", undefined],
    ['The test now asks "is it ready?" before it runs.', undefined],
    ["```ts\nconst x = a ?? b?\n```", undefined],
    ["Everything is merged and pushed.", undefined],
    ["", undefined],
  ])("%p", (reply, asked) => {
    expect(asksUser(reply)).toBe(asked);
  });
});

test("listeners hear events, and one that throws doesn't stop the rest", () => {
  const heard: string[] = [];
  const off = onProjectEvent(() => {
    throw new Error("bad hook");
  });
  const off2 = onProjectEvent((event) => heard.push(event.kind));
  const world2 = world();
  const watch = new ProjectWatch(world2.ctx, { busy: () => {} });
  world2.start("lead");
  watch.status("lead", "working");
  world2.end("lead");
  watch.turnEnded("lead", { kind: "result", id: "r", ok: true, ts: 1 });
  world2.statuses["lead"] = "idle";
  // its own clock: let the minute pass for real is too long — sweep twice
  // with the stretch's quiet already a minute old
  watch.sweep();
  (watch as unknown as { stretches: Map<string, { quietSince?: number }> }).stretches.get("p")!.quietSince =
    Date.now() - IDLE_AFTER_MS - 1;
  watch.sweep();
  off();
  off2();
  expect(heard).toEqual(["project.idle"]);
});
