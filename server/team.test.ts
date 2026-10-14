import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  leadOf,
  type PermissionRequest,
  type Project,
  type ServerMessage,
  type TranscriptEvent,
} from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import {
  carryLetter,
  listSeats,
  sendLetter,
  talkDropped,
  talkTurnEnded,
  waitAnswer,
} from "./handlers/talk.js";
import { actOn, atWork, hasSlot, releaseWaiting, rosterText, teamBudget, teamHost } from "./handlers/team.js";
import { ProjectStore } from "./projects.js";
import { SendQueues } from "./queue.js";
import { stoppedLine, TalkBook } from "./talk.js";
import { disallowedFor, leadBriefing, memberBriefing, teamCap, TeamGovernor } from "./team.js";

let dir: string;
let saved: string | undefined;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-team-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the cap on members at work", () => {
  test("none unless RURI_TEAM_MAX sets one", () => {
    const saved = process.env["RURI_TEAM_MAX"];
    delete process.env["RURI_TEAM_MAX"];
    expect(teamCap()).toBeUndefined();
    expect(new TeamGovernor().cap).toBeUndefined();
    process.env["RURI_TEAM_MAX"] = "3";
    expect(teamCap()).toBe(3);
    expect(new TeamGovernor().cap).toBe(3);
    process.env["RURI_TEAM_MAX"] = "nope";
    expect(teamCap()).toBeUndefined();
    if (saved === undefined) delete process.env["RURI_TEAM_MAX"];
    else process.env["RURI_TEAM_MAX"] = saved;
  });

  test("the members waiting on a slot, oldest first, once each", () => {
    const governor = new TeamGovernor({ cap: 1 });
    governor.wait("m");
    governor.wait("n");
    governor.wait("m");
    expect(governor.waiting).toEqual(["m", "n"]);
    governor.unwait("m");
    expect(governor.waiting).toEqual(["n"]);
  });
});

describe("every project a team", () => {
  function store(projects: Project[]): ProjectStore {
    fs.writeFileSync(path.join(dir, "projects.json"), JSON.stringify({ projects }));
    return new ProjectStore();
  }

  test("a project with one chat makes it its lead", () => {
    const s = store([{ id: "p", name: "p", path: "/tmp", sessions: [{ id: "only", title: "Bug Fix" }] }]);
    expect(s.formTeams(() => false)).toBe(true);
    expect(s.get("p")!.sessions).toEqual([{ id: "only", title: "Lead", lead: true }]);
  });

  test("one with several gets a new lead, and the chats it had are its team — a chat never used goes", () => {
    const s = store([
      {
        id: "p",
        name: "ruri",
        path: "/tmp",
        sessions: [
          { id: "ui", title: "Frontend UI" },
          { id: "blank" },
          { id: "linux", title: "Ruri Linux Port" },
        ],
      },
    ]);
    s.formTeams((id) => id === "blank");
    const sessions = s.get("p")!.sessions;
    expect(sessions).toHaveLength(3);
    expect(sessions[0]).toMatchObject({ title: "Lead", lead: true });
    expect(sessions.slice(1)).toEqual([
      { id: "ui", title: "Frontend UI", duty: "Frontend UI" },
      { id: "linux", title: "Ruri Linux Port", duty: "Ruri Linux Port" },
    ]);
    expect(s.lead("p")?.id).toBe(sessions[0]!.id);
    expect(s.isMember("ui")).toBe(true);
    expect(s.isMember(sessions[0]!.id)).toBe(false);
    // and it is kept: the next launch changes nothing
    expect(new ProjectStore().formTeams(() => true)).toBe(false);
  });

  test("a team whose lead has slipped down is put back in order", () => {
    const s = store([
      {
        id: "p",
        name: "p",
        path: "/tmp",
        sessions: [
          { id: "m", duty: "x" },
          { id: "l", lead: true },
        ],
      },
    ]);
    expect(s.formTeams(() => false)).toBe(true);
    expect(s.get("p")!.sessions.map((x) => x.id)).toEqual(["l", "m"]);
  });

  test("a new project starts with its lead; a new chat in it is a member; a lead removed hands on", () => {
    const s = store([]);
    const project = s.add("demo", os.tmpdir());
    expect(project.sessions).toEqual([{ id: project.sessions[0]!.id, title: "Lead", lead: true }]);
    const member = s.addMember(project.id, { name: "UI", duty: "the web UI", layers: ["conversation"] })!;
    expect(s.isMember(member.id)).toBe(true);
    s.setMember(member.id, { duty: "the web UI and its styles", layers: [] });
    expect(s.findSession(member.id)?.session).toEqual({
      id: member.id,
      title: "UI",
      duty: "the web UI and its styles",
    });
    // a member leaves; the lead never does — it goes only with the project
    s.removeMember(project.sessions[0]!.id);
    expect(s.get(project.id)!.sessions[0]).toMatchObject({ lead: true, title: "Lead" });
    s.removeMember(member.id);
    expect(s.get(project.id)!.sessions.map((x) => x.id)).toEqual([project.sessions[0]!.id]);
  });

  test("a project left with no chat gets its lead at launch", () => {
    const s = store([{ id: "p", name: "p", path: "/tmp", sessions: [] }]);
    s.formTeams(() => true);
    expect(s.get("p")!.sessions[0]).toMatchObject({ lead: true });
  });

  test("its liaison is made once, after its lead — not a member, and kept", () => {
    const s = store([]);
    const project = s.add("demo", os.tmpdir());
    const member = s.addMember(project.id, { name: "UI", duty: "the web UI" })!;
    const liaison = s.liaison(project.id)!;
    expect(liaison).toMatchObject({ title: "Liaison", liaison: true });
    expect(s.liaison(project.id)!.id).toBe(liaison.id);
    expect(s.get(project.id)!.sessions.map((x) => x.id)).toEqual([
      project.sessions[0]!.id,
      liaison.id,
      member.id,
    ]);
    expect(s.isMember(liaison.id)).toBe(false);
    expect(s.isLiaison(liaison.id)).toBe(true);
    expect(s.isMember(member.id)).toBe(true);
    expect(s.lead(project.id)?.title).toBe("Lead");
    expect(new ProjectStore().formTeams(() => true)).toBe(false);
    expect(new ProjectStore().get(project.id)!.sessions[1]).toMatchObject({ liaison: true });
  });

  test("the liaison is never taken for the lead, wherever it stands", () => {
    const liaison = { id: "x", title: "Liaison", liaison: true };
    expect(leadOf({ sessions: [liaison, { id: "l", lead: true }] })?.id).toBe("l");
    // no session marked lead: the first that is not the liaison
    expect(leadOf({ sessions: [liaison, { id: "m" }] })?.id).toBe("m");
    expect(leadOf({ sessions: [{ ...liaison, lead: true }, { id: "m" }] })?.id).toBe("m");
    expect(leadOf({ sessions: [liaison] })).toBeUndefined();
  });
});

/* ── a team at work, against a server made of just what it touches ── */

function world(opts: { cap?: number } = {}) {
  const projects: Project[] = [
    {
      id: "p",
      name: "ruri",
      path: "/tmp/ruri",
      sessions: [
        { id: "lead", title: "Lead", lead: true },
        { id: "ui", title: "UI", duty: "the web UI", layers: ["conversation"] },
        { id: "linux", title: "Linux port", duty: "the Linux build" },
        { id: "memory", title: "Memory", duty: "the memory and compaction" },
      ],
    },
    {
      id: "q",
      name: "site",
      path: "/tmp/site",
      sessions: [
        { id: "site-lead", title: "Lead", lead: true },
        { id: "copy", title: "Copy", duty: "the words" },
      ],
    },
  ];
  const said: ServerMessage[] = [];
  /** A chat with no status set is at a card unless a test says otherwise:
   *  a message to it waits in its line, where `arrive` takes it from. */
  const set: Record<string, string> = {};
  const fallback = { status: "idle" };
  const statuses = new Proxy(set, {
    get: (target, key: string) => target[key] ?? fallback.status,
  });
  const events: Record<string, TranscriptEvent[]> = {};
  const interrupted: string[] = [];
  const disposed: string[] = [];
  const broadcast = (message: ServerMessage) => said.push(message);
  const real = (id: string) => projects.flatMap((p) => p.sessions).find((s) => s.id === id);
  const find = (id: string) => {
    for (const project of projects) {
      const session = project.sessions.find((s) => s.id === id);
      if (session) return { project, session: { ...session, permissionMode: "bypassPermissions" as const } };
    }
    return undefined;
  };
  let made = 0;
  const noop = () => {};
  const ctx = {
    store: {
      list: () => projects,
      get: (id: string) => projects.find((p) => p.id === id),
      findSession: find,
      isMember: (id: string) =>
        projects.some((p) => p.sessions.findIndex((s) => s.id === id) > 0) && !real(id)?.liaison,
      lead: (projectId: string) => projects.find((p) => p.id === projectId)?.sessions[0],
      liaison: (projectId: string) => {
        const project = projects.find((p) => p.id === projectId)!;
        const had = project.sessions.find((s) => s.liaison);
        if (had) return had;
        const fresh = { id: `liaison-${projectId}`, title: "Liaison", liaison: true };
        project.sessions.splice(1, 0, fresh);
        return fresh;
      },
      sessionIds: () => projects.flatMap((p) => p.sessions.map((s) => s.id)),
      defaultModel: () => "sonnet",
      findByQuery: (q: string) => projects.find((p) => p.id === q || p.name === q),
      findByPath: (dir: string) => projects.find((p) => p.path === dir),
      workspaceDir: () => "/tmp",
      addMember: (projectId: string, member: { name: string; duty: string; layers?: string[] }) => {
        const session = {
          id: `m-${member.name}-${++made}`,
          title: member.name,
          duty: member.duty,
          ...(member.layers?.length ? { layers: member.layers } : {}),
        };
        projects.find((p) => p.id === projectId)?.sessions.push(session);
        return session;
      },
      setMember: (id: string, patch: { duty?: string }) => {
        const session = real(id);
        if (session && patch.duty) session.duty = patch.duty;
      },
      removeMember: (id: string) => {
        for (const project of projects) project.sessions = project.sessions.filter((s) => s.id !== id);
      },
      copySessionSettings: noop,
    },
    talk: new TalkBook(),
    permissions: new Map<string, PermissionRequest>(),
    clients: { broadcast, forgetChannel: noop },
    queues: new SendQueues(broadcast),
    manager: {
      statuses: () => statuses,
      interrupt: (id: string) => interrupted.push(id),
      live: () => false,
      dispose: (id: string) => disposed.push(id),
      send: noop,
    },
    governor: new TeamGovernor({ cap: opts.cap }),
    archive: { events: (id: string) => events[id] ?? [], turnIds: () => [], remove: noop },
    turns: { work: new Map(), progress: new Map(), contexts: new Map(), sent: new Map() },
    briefs: {
      get: () => ({
        layers: [
          { slug: "conversation", name: "Conversation", what: "Composing prompts and reading replies" },
          { slug: "harnesses", name: "Agent harnesses", what: "The agent CLIs ruri drives" },
        ],
      }),
    },
    models: { allModels: () => [{ value: "haiku", displayName: "Haiku 4.5" }] },
    retries: { has: () => false, cancelRetry: noop },
    checkpoints: { forgetChannel: async () => {} },
    crew: { remove: () => [] },
    crewManager: { dispose: noop },
    agentLogs: { remove: noop },
    drafts: { remove: noop },
    tracker: { removeProject: noop },
    terminals: { closeChannel: noop },
    bridge: { closeBridge: noop },
  } as unknown as ServerContext;
  /** A message landing in a chat, as dispatch would put it there. */
  const arrive = (chat: string) => {
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
    events[chat] = [...(events[chat] ?? []), { kind: "assistant", id: `s-${chat}-${text}`, text, ts: 2 }];
  };
  const end = (chat: string, result: Partial<Extract<TranscriptEvent, { kind: "result" }>> = {}) =>
    talkTurnEnded(ctx, chat, { kind: "result", id: `r-${chat}`, ok: true, ts: 3, ...result });
  return { ctx, said, set, fallback, events, projects, interrupted, disposed, arrive, speak, end };
}

describe("members at work, and a cap only when the user sets one", () => {
  test("every member may work at once: no cap, no waiting", () => {
    const { ctx, set } = world();
    set["ui"] = "working";
    set["linux"] = "working";
    set["memory"] = "working";
    expect(atWork(ctx)).toBe(3);
    expect(hasSlot(ctx, "copy")).toBe(true);
    expect(teamBudget(ctx)).toEqual({ atWork: 3, waiting: [] });
    // a lead is never counted
    set["lead"] = "working";
    expect(atWork(ctx)).toBe(3);
  });

  test("a member holding on an answer is not at work: its harness is parked in a call", () => {
    const { ctx, set } = world();
    set["ui"] = "working";
    set["linux"] = "working";
    set["memory"] = "permission";
    expect(atWork(ctx)).toBe(3);
    void sendLetter(ctx, "linux", { to: "Memory", message: "how do briefs work?", reply: "wait" });
    expect(atWork(ctx)).toBe(2);
  });

  test("with RURI_TEAM_MAX, a message to one asleep waits for a slot, and goes when one frees", async () => {
    const { ctx, set } = world({ cap: 2 });
    set["ui"] = "working";
    set["linux"] = "working";
    expect(hasSlot(ctx, "memory")).toBe(false);
    expect(teamBudget(ctx).cap).toBe(2);
    const sent = await sendLetter(ctx, "lead", { to: "Memory", message: "compact faster", reply: "later" });
    expect(sent.text).toContain("waiting for a free slot");
    expect(ctx.governor.waiting).toEqual(["memory"]);
    await sendLetter(ctx, "lead", { to: "Memory", message: "and test it", reply: "none" });
    expect(ctx.queues.entries.get("memory")).toHaveLength(2);
    releaseWaiting(ctx);
    expect(ctx.governor.waiting).toEqual(["memory"]);
    set["ui"] = "idle";
    releaseWaiting(ctx);
    expect(ctx.governor.waiting).toEqual([]);
    expect(ctx.queues.entries.get("memory")).toHaveLength(1);
    expect(atWork(ctx)).toBe(2);
    expect(hasSlot(ctx, "ui")).toBe(false);
  });
});

describe("what the lead reads", () => {
  test("its roster: each teammate, the layers with no one yet, and the liaison — no machine", () => {
    const { ctx, set } = world();
    set["ui"] = "working";
    const roster = rosterText(ctx, "lead");
    expect(roster).toContain(`${ctx.talk.handleOf("ui")}  UI — working`);
    expect(roster).toContain("duty: the web UI");
    expect(roster).toContain("layers: conversation");
    expect(roster).toContain("Linux port — asleep");
    expect(roster).toContain("Layers with no teammate yet");
    expect(roster).toContain("  harnesses — Agent harnesses");
    expect(roster).not.toContain("  conversation — Conversation");
    expect(roster).toContain("The liaison: none yet");
    expect(roster).not.toContain("memory free");
    expect(roster).not.toContain("RURI_TEAM_MAX");
    expect(rosterText(ctx, "ui")).toContain("Only a project's lead, or its liaison");
  });

  test("the words: the same every time; the lead delegates everything; the liaison has no user", () => {
    expect(leadBriefing("ruri", "tool")).toBe(leadBriefing("ruri", "tool"));
    const lead = leadBriefing("ruri", "tool");
    expect(lead).toContain("you delegate every task");
    expect(lead).toContain('add_teammate with layer "<handle>"');
    expect(lead).toContain('it comes back "later", always');
    expect(lead).toContain("mcp__ruri__manage_teammate");
    expect(lead).toContain('"refresh"');
    expect(lead).toContain('"stop"');
    expect(lead).toContain("liaison");
    expect(lead).not.toMatch(/memory|machine|slot/i);
    const liaison = leadBriefing("ruri", "tool", "", "liaison");
    expect(liaison).toContain("You are the liaison of ruri");
    expect(liaison).toContain("you have no user to ask");
    expect(liaison).toContain("answer the asking agent");
    expect(leadBriefing("ruri", "http", "http://x/talk/1")).toContain('{"do": "manage"');
    const member = memberBriefing({
      project: "ruri",
      name: "UI",
      duty: "the web UI",
      layers: ["conversation"],
    });
    expect(member).toContain('You are "UI" on ruri\'s team. Your duty: the web UI.');
    expect(member).toContain("Your layers: conversation");
    expect(member).toContain("its liaison");
    expect(member).not.toMatch(/machine|MB/);
  });

  test("a lead and the liaison can't write files or start agents; only the lead may ask the user", () => {
    expect(disallowedFor("lead")).toEqual(["Edit", "Write", "NotebookEdit", "Task", "Agent"]);
    expect(disallowedFor("liaison")).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
      "Task",
      "Agent",
      "AskUserQuestion",
    ]);
    expect(disallowedFor("member")).toEqual(["AskUserQuestion"]);
    // no MCP tool is held back: ruri's own are every chat's
    expect(disallowedFor("liaison").some((name) => name.startsWith("mcp__"))).toBe(false);
  });

  test("the list of agents: your own team in full, another project through its liaison", () => {
    const { ctx } = world();
    const listed = listSeats(ctx, "lead");
    expect(listed).toContain("UI (duty: the web UI) [conversation]");
    expect(listed).toContain("its liaison");
    expect(listed).toContain("made when you first write");
    expect(listed).not.toContain(ctx.talk.handleOf("copy"));
    const fromUi = listSeats(ctx, "ui");
    expect(fromUi).toContain(`${ctx.talk.handleOf("lead")}  the lead`);
    expect(fromUi).toContain("Linux port (duty: the Linux build)");
  });
});

describe("a teammate made for a layer, when a job for it comes up", () => {
  test("its name and duty come from the layer; one per layer; a layer must be in the stack", async () => {
    const { ctx, projects } = world();
    const host = teamHost(ctx);
    const added = await host.add("lead", { layer: "harnesses" });
    expect(added).toContain("Added Agent harnesses to the team");
    expect(added).toContain("holding harnesses");
    expect(projects[0]!.sessions.at(-1)).toMatchObject({
      title: "Agent harnesses",
      duty: "The agent CLIs ruri drives",
      layers: ["harnesses"],
    });
    expect(await host.add("lead", { layer: "conversation" })).toContain("UI holds conversation already");
    expect(await host.add("lead", { layer: "nope" })).toContain('No layer goes by "nope"');
    expect(rosterText(ctx, "lead")).toContain("Every layer of the stack has its teammate.");
  });

  test("by name and duty for a project with no stack; never twice; only a lead adds", async () => {
    const { ctx, projects } = world();
    const host = teamHost(ctx);
    expect(await host.add("lead", { name: "Docs", duty: "the README and the changelog" })).toContain(
      "Added Docs",
    );
    expect(projects[0]!.sessions.at(-1)).toMatchObject({
      title: "Docs",
      duty: "the README and the changelog",
    });
    expect(await host.add("lead", { name: "docs", duty: "again" })).toContain("on the team already");
    expect(await host.add("ui", { name: "Rogue", duty: "x" })).toContain("Only a project's lead");
    expect(await host.add("lead", { name: "", duty: "x" })).toContain(
      "needs a layer's handle, or a name and a duty",
    );
  });

  test("with its first job, handed over 'later': the lead's call returns at once", async () => {
    const { ctx, projects, fallback } = world();
    fallback.status = "permission";
    const added = await teamHost(ctx).add("lead", {
      layer: "harnesses",
      message: "find out why Codex resumes fail",
    });
    expect(added).toContain("Its answer comes to this chat as a message when the job is done");
    const fresh = projects[0]!.sessions.at(-1)!;
    expect(ctx.queues.entries.get(fresh.id)?.[0]?.from).toMatchObject({ agent: "lead", reply: "later" });
  });

  test("a lead's message comes back 'later', even asked to wait; a member's is waited on", async () => {
    const { ctx, fallback } = world();
    fallback.status = "permission";
    const sent = await sendLetter(ctx, "lead", { to: "UI", message: "fix the composer" });
    expect(sent.text).toContain("Its answer comes to this chat as a message when the job is done");
    expect(ctx.talk.pending.get(sent.letter!)?.reply).toBe("later");
    const held = await sendLetter(ctx, "lead", { to: "Memory", message: "how full are you?", reply: "wait" });
    expect(held.text).toContain('a lead\'s hand-offs always come back "later"');
    expect(ctx.talk.pending.get(held.letter!)?.reply).toBe("later");
    void sendLetter(ctx, "ui", { to: "Linux port", message: "does it build?" });
    expect([...ctx.talk.pending.values()].find((p) => p.from === "ui")?.reply).toBe("wait");
  });

  test("a teammate is reached by the layer it holds", async () => {
    const { ctx, fallback } = world();
    fallback.status = "permission";
    const sent = await sendLetter(ctx, "lead", { to: "conversation", message: "x", reply: "none" });
    expect(sent.text).toContain("Sent to ruri · UI");
  });
});

describe("the lead's hand on each teammate's session — mid-turn and asleep", () => {
  /** ui working on a message from the lead, with a message from linux
   *  queued behind it. */
  async function busyUi() {
    const w = world();
    w.fallback.status = "permission";
    const asked = await sendLetter(w.ctx, "lead", { to: "UI", message: "fix the composer", reply: "later" });
    w.arrive("ui");
    w.set["ui"] = "working";
    await sendLetter(w.ctx, "linux", {
      to: "UI",
      message: "and the build",
      reply: "later",
      delivery: "queue",
    });
    expect(w.ctx.queues.entries.get("ui")).toHaveLength(1);
    return { ...w, letter: asked.letter! };
  }

  test("stop, mid-turn: the turn is stopped, nothing new is sent, its sender is told who stopped it", async () => {
    const { ctx, set, interrupted, letter, end, speak } = await busyUi();
    const said = teamHost(ctx).manage("lead", "UI", "stop");
    expect(said).toContain("Stopped UI's turn");
    expect(interrupted).toEqual(["ui"]);
    // its next message tells it the lead stopped it, not the user
    expect(ctx.talk.stopNotes.get("ui")?.who).toBe("the lead");
    expect(stoppedLine("the lead", "Bash: npm test")).toContain(
      "not by the user. The call it cut off was Bash: npm test",
    );
    // the line behind is not held: linux's message goes once the turn ends
    expect(ctx.queues.held.has("ui")).toBe(false);
    expect(ctx.queues.entries.get("ui")).toHaveLength(1);
    speak("ui", "half done");
    set["ui"] = "idle";
    end("ui", { ok: false, stopped: true });
    expect(ctx.talk.pending.get(letter)?.ending?.text).toContain("The lead stopped ruri · UI's turn");
  });

  test("stop, asleep: nothing to stop", () => {
    const { ctx, interrupted } = world();
    expect(teamHost(ctx).manage("lead", "Linux port", "stop")).toContain("nothing to stop");
    expect(interrupted).toEqual([]);
  });

  test("restart, mid-turn and asleep: the process closes, the conversation stays", async () => {
    const { ctx, disposed, letter } = await busyUi();
    // a message cut in earlier, and ruri's prompt to go back to that work
    // behind it: the restart ends the work, so that prompt goes
    ctx.queues.push("ui", {
      id: "back",
      text: "↩ Back to what you were doing",
      uploads: [],
      silent: false,
      resume: true,
    });
    expect(teamHost(ctx).manage("lead", "UI", "restart")).toContain("the turn it was on is stopped");
    expect(disposed).toContain("ui");
    expect(ctx.talk.pending.get(letter)?.ending?.text).toContain("the lead restarted it");
    expect(ctx.queues.entries.get("ui")?.some((entry) => entry.resume)).toBe(false);
    expect(ctx.queues.entries.get("ui")?.some((entry) => entry.from?.agent === "linux")).toBe(true);
    const calm = world();
    expect(teamHost(calm.ctx).manage("lead", "Memory", "restart")).toContain("it wasn't at work");
    expect(calm.disposed).toEqual(["memory"]);
  });

  test("compact, mid-turn: it compacts the moment its turn ends, ahead of what waits", async () => {
    const { ctx } = await busyUi();
    expect(teamHost(ctx).manage("lead", "UI", "compact")).toContain("compacts the moment its turn ends");
    expect(ctx.queues.entries.get("ui")?.[0]?.text).toBe("/compact");
    expect(ctx.queues.entries.get("ui")).toHaveLength(2);
  });

  test("refresh, mid-turn: a fresh session in its place, the same role, the waiting messages moved", async () => {
    const { ctx, projects, letter } = await busyUi();
    const said = teamHost(ctx).manage("lead", "conversation", "refresh");
    expect(said).toContain("Refreshed UI");
    expect(said).toContain("1 message waiting for it went to the fresh one");
    const team = projects[0]!.sessions;
    expect(team.some((s) => s.id === "ui")).toBe(false);
    const fresh = team.find((s) => s.title === "UI")!;
    expect(fresh).toMatchObject({ duty: "the web UI", layers: ["conversation"] });
    expect(ctx.talk.pending.get(letter)?.ending?.text).toContain("refreshed by the lead");
    const moved = [...ctx.talk.pending.values()].find((p) => p.from === "linux");
    expect(moved?.to).toBe(fresh.id);
    expect(ctx.queues.entries.get(fresh.id)?.[0]?.from?.agent).toBe("linux");
  });

  test("refresh, asleep — and 'clear', its old name: a fresh one, nothing lost but the conversation", () => {
    const { ctx, projects } = world();
    expect(teamHost(ctx).manage("lead", "Memory", "clear")).toContain("Refreshed Memory");
    expect(projects[0]!.sessions.filter((s) => s.title === "Memory")).toHaveLength(1);
    expect(projects[0]!.sessions.some((s) => s.id === "memory")).toBe(false);
  });

  test("retire, mid-turn: the turn stops, its sender and those waiting in its line are told", async () => {
    const { ctx, projects, disposed, letter } = await busyUi();
    expect(teamHost(ctx).retire("lead", "UI")).toContain("Retired UI");
    expect(disposed).toContain("ui");
    expect(projects[0]!.sessions.some((s) => s.id === "ui")).toBe(false);
    expect(ctx.talk.pending.get(letter)?.ending?.text).toContain("retired by the lead");
    const queued = [...ctx.talk.pending.values()].find((p) => p.from === "linux");
    expect(queued?.ending?.text).toContain("was closed before it answered");
  });

  test("retire: off the team; never the lead or the liaison", () => {
    const { ctx, projects } = world();
    expect(teamHost(ctx).retire("lead", "Linux port")).toContain("Retired Linux port");
    expect(projects[0]!.sessions.some((s) => s.id === "linux")).toBe(false);
    expect(actOn(ctx, "lead", "retire", "user")).toContain("the lead, not a teammate");
    const liaison = (ctx.store as unknown as { liaison(id: string): { id: string } }).liaison("p");
    expect(actOn(ctx, liaison.id, "stop", "user")).toContain("the liaison, not a teammate");
    expect(teamHost(ctx).retire("site-lead", "UI")).toContain("No teammate answers");
  });
});

describe("the liaison: what other projects' agents reach", () => {
  test("a message to another project lands at its liaison — made then — never at its lead", async () => {
    const { ctx, projects, fallback } = world();
    fallback.status = "permission";
    const sent = await sendLetter(ctx, "copy", {
      to: "ruri",
      message: "what does the composer do?",
      reply: "later",
    });
    expect(sent.text).toContain("Sent to ruri's liaison");
    const liaison = projects[0]!.sessions[1]!;
    expect(liaison).toMatchObject({ liaison: true });
    expect(ctx.queues.entries.get(liaison.id)).toHaveLength(1);
    expect(ctx.queues.entries.get("lead")).toBeUndefined();
    // by the lead's handle, too: the door, not the lead
    await sendLetter(ctx, "copy", {
      to: ctx.talk.handleOf("lead"),
      message: "and the queue?",
      reply: "none",
    });
    expect(ctx.queues.entries.get(liaison.id)).toHaveLength(2);
    expect(ctx.queues.entries.get("lead")).toBeUndefined();
    // it is not a member: not on the team page, not in the team's count
    expect(listSeats(ctx, "copy")).toContain(ctx.talk.handleOf(liaison.id));
    expect(rosterText(ctx, "lead")).toContain(`The liaison — other projects' agents reach it`);
    expect(rosterText(ctx, "lead")).toContain("answering: site · Copy");
  });

  test("it runs the same team: adds, hands on, manages; the lead's roster shows what it has going", async () => {
    const { ctx, fallback } = world();
    fallback.status = "permission";
    const liaison = (ctx.store as unknown as { liaison(id: string): { id: string } }).liaison("p").id;
    expect(rosterText(ctx, liaison)).toContain("The lead — the user's chat");
    expect(await teamHost(ctx).add(liaison, { layer: "harnesses" })).toContain("Added Agent harnesses");
    expect(teamHost(ctx).manage(liaison, "Memory", "restart")).toContain("Restarted Memory");
    const sent = await sendLetter(ctx, liaison, { to: "UI", message: "x" });
    expect(ctx.talk.pending.get(sent.letter!)?.reply).toBe("later");
  });

  test("a job it hands on is answered when the answer comes back, by its relay — not when it hands it on", async () => {
    const { ctx, projects, fallback, arrive, speak, end } = world();
    fallback.status = "permission";
    let answered = "";
    const waiting = sendLetter(ctx, "copy", {
      to: "ruri",
      message: "how does rewind work?",
      reply: "wait",
    }).then((result) => {
      answered = result.text;
    });
    const liaison = projects[0]!.sessions[1]!.id;
    arrive(liaison);
    // it hands the job to UI, "later" by default for it, and ends its turn
    const handed = await sendLetter(ctx, liaison, { to: "UI", message: "explain rewind for site's lead" });
    expect(ctx.talk.pending.get(handed.letter!)?.for).toBeDefined();
    speak(liaison, "Handed to UI.");
    end(liaison);
    await Promise.resolve();
    expect(answered).toBe("");
    // UI answers; the answer goes back to the liaison, marked as owed onward
    arrive("ui");
    speak("ui", "Rewind restores files, branch and transcript.");
    end("ui");
    const back = ctx.queues.entries.get(liaison)?.[0];
    // (not toMatchObject with expect.any: bun writes the matcher into the object)
    expect(back?.from?.answer).toBe(true);
    expect(back?.from?.owes).toBe(
      ctx.talk.pending.get(handed.letter!)?.for ?? [...ctx.talk.pending.keys()][0],
    );
    arrive(liaison);
    speak(liaison, "Rewind puts back files, branch and transcript to the kept exchange.");
    end(liaison);
    await waiting;
    expect(answered).toContain("Rewind puts back files, branch and transcript");
    expect(answered).not.toContain("Handed to UI");
  });

  test("a question it answers at once is answered by that turn", async () => {
    const { ctx, projects, fallback, arrive, speak, end } = world();
    fallback.status = "permission";
    let answered = "";
    const waiting = sendLetter(ctx, "copy", {
      to: "ruri",
      message: "who owns the UI?",
      reply: "wait",
    }).then((result) => {
      answered = result.text;
    });
    const liaison = projects[0]!.sessions[1]!.id;
    arrive(liaison);
    speak(liaison, "The UI teammate.");
    end(liaison);
    await waiting;
    expect(answered).toContain("The UI teammate.");
  });
});

describe("a job handed on is answered however its answer comes back", () => {
  /** copy (site) asks ruri, waiting; ruri's liaison hands it to UI and
   *  ends its turn; then a second job from copy, which the liaison is on. */
  async function handedOn() {
    const w = world();
    w.fallback.status = "permission";
    let answered = "";
    const asked = sendLetter(w.ctx, "copy", {
      to: "ruri",
      message: "how does rewind work?",
      reply: "wait",
    }).then((result) => {
      answered = result.text;
    });
    const liaison = w.projects[0]!.sessions[1]!.id;
    w.arrive(liaison);
    const handed = await sendLetter(w.ctx, liaison, { to: "UI", message: "explain rewind for site" });
    w.speak(liaison, "Handed to UI.");
    w.end(liaison);
    // another job, from the same asker, which the liaison is at work on
    await sendLetter(w.ctx, "copy", { to: "ruri", message: "who owns the queue?", reply: "later" });
    w.arrive(liaison);
    w.set[liaison] = "working";
    return { ...w, liaison, handed: handed.letter!, asked, answered: () => answered };
  }

  /** The liaison's second job ends, then the prompt ruri left behind it
   *  runs: its words are the first job's answer. */
  async function relayed(w: Awaited<ReturnType<typeof handedOn>>) {
    const relay = w.ctx.queues.entries.get(w.liaison)?.at(-1);
    expect(relay?.from?.carried).toBe(true);
    expect(relay?.text).toContain("is still waiting on you: answer it now");
    expect(relay?.text).toContain("Rewind restores files, branch and transcript.");
    await Promise.resolve();
    expect(w.answered()).toBe("");
    w.speak(w.liaison, "The queue is the Chat runs teammate's.");
    w.end(w.liaison);
    w.arrive(w.liaison);
    w.speak(w.liaison, "Rewind puts files, branch and transcript back to the kept exchange.");
    w.end(w.liaison);
    await w.asked;
    expect(w.answered()).toContain("Rewind puts files, branch and transcript back");
    expect(w.answered()).not.toContain("Handed to UI");
  }

  test("taken with a wait while the liaison is on another job — the wait held as it lands", async () => {
    const w = await handedOn();
    const took = waitAnswer(w.ctx, w.liaison, w.handed);
    w.arrive("ui");
    w.speak("ui", "Rewind restores files, branch and transcript.");
    w.end("ui");
    expect((await took).text).toContain("Rewind restores files, branch and transcript.");
    await relayed(w);
  });

  test("taken with a wait while the liaison is on another job — out of its line, landed before", async () => {
    const w = await handedOn();
    w.arrive("ui");
    w.speak("ui", "Rewind restores files, branch and transcript.");
    w.end("ui");
    // the answer waits in the liaison's line, behind the job it is on
    expect(w.ctx.queues.entries.get(w.liaison)?.[0]?.from?.answer).toBe(true);
    const took = await waitAnswer(w.ctx, w.liaison, w.handed);
    expect(took.text).toContain("Rewind restores files, branch and transcript.");
    expect(w.ctx.queues.entries.get(w.liaison)?.some((e) => e.from?.answer)).toBe(false);
    await relayed(w);
  });

  test("taken by a wait in the turn on that very job: that turn answers, nothing is sent back", async () => {
    const w = world();
    w.fallback.status = "permission";
    let answered = "";
    const asked = sendLetter(w.ctx, "copy", {
      to: "ruri",
      message: "how does rewind work?",
      reply: "wait",
    }).then((result) => {
      answered = result.text;
    });
    const liaison = w.projects[0]!.sessions[1]!.id;
    w.arrive(liaison);
    w.set[liaison] = "working";
    const handed = await sendLetter(w.ctx, liaison, { to: "UI", message: "explain rewind" });
    const took = waitAnswer(w.ctx, liaison, handed.letter!);
    w.arrive("ui");
    w.speak("ui", "Rewind restores files.");
    w.end("ui");
    await took;
    expect(w.ctx.queues.entries.get(liaison) ?? []).toHaveLength(0);
    w.speak(liaison, "Rewind restores files, as UI says.");
    w.end(liaison);
    await asked;
    expect(answered).toContain("Rewind restores files, as UI says.");
  });

  test("taken out of the liaison's line before it goes in: the asker hears so, rather than nothing", async () => {
    const w = world();
    w.fallback.status = "permission";
    let answered = "";
    const asked = sendLetter(w.ctx, "copy", {
      to: "ruri",
      message: "how does rewind work?",
      reply: "wait",
    }).then((result) => {
      answered = result.text;
    });
    const liaison = w.projects[0]!.sessions[1]!.id;
    w.arrive(liaison);
    await sendLetter(w.ctx, liaison, { to: "UI", message: "explain rewind" });
    w.speak(liaison, "Handed to UI.");
    w.end(liaison);
    w.arrive("ui");
    w.speak("ui", "Rewind restores files.");
    w.end("ui");
    const back = w.ctx.queues.entries.get(liaison)?.[0];
    expect(back?.from?.answer).toBe(true);
    w.set[liaison] = "idle";
    talkDropped(w.ctx, back!.from);
    await asked;
    expect(answered).toContain("handed your message on, and the answer it was waiting for was taken out");
    expect(w.ctx.talk.pending.size).toBe(0);
  });

  test("one nobody waits an answer on is just done with — no turn spent going back to it", async () => {
    const w = world();
    w.fallback.status = "permission";
    await sendLetter(w.ctx, "copy", { to: "ruri", message: "tidy the rewind notes", reply: "none" });
    const liaison = w.projects[0]!.sessions[1]!.id;
    w.arrive(liaison);
    const handed = await sendLetter(w.ctx, liaison, { to: "UI", message: "tidy the rewind notes" });
    w.end(liaison);
    expect(w.ctx.talk.pending.size).toBe(2);
    await sendLetter(w.ctx, "copy", { to: "ruri", message: "who owns the queue?", reply: "later" });
    w.arrive(liaison);
    w.set[liaison] = "working";
    const took = waitAnswer(w.ctx, liaison, handed.letter!);
    w.arrive("ui");
    w.end("ui");
    await took;
    expect(w.ctx.queues.entries.get(liaison) ?? []).toHaveLength(0);
    // only the job it is on now is left in flight
    expect([...w.ctx.talk.pending.values()].map((p) => p.text)).toEqual(["who owns the queue?"]);
  });

  test("with another answer for it still to come, taking one out waits for that one", async () => {
    const w = world();
    w.fallback.status = "permission";
    let answered = "";
    const asked = sendLetter(w.ctx, "copy", {
      to: "ruri",
      message: "rewind and the queue?",
      reply: "wait",
    }).then((result) => {
      answered = result.text;
    });
    const liaison = w.projects[0]!.sessions[1]!.id;
    w.arrive(liaison);
    await sendLetter(w.ctx, liaison, { to: "UI", message: "explain rewind" });
    await sendLetter(w.ctx, liaison, { to: "Memory", message: "explain the queue" });
    w.speak(liaison, "Handed to UI and Memory.");
    w.end(liaison);
    w.arrive("ui");
    w.speak("ui", "Rewind restores files.");
    w.end("ui");
    w.set[liaison] = "idle";
    // as queue_remove does: its sender's book told, then out of the line
    talkDropped(w.ctx, w.ctx.queues.entries.get(liaison)![0]!.from);
    w.ctx.queues.entries.get(liaison)!.shift();
    await Promise.resolve();
    expect(answered).toBe("");
    w.set[liaison] = "permission";
    w.arrive("memory");
    w.speak("memory", "The queue holds what waits.");
    w.end("memory");
    w.arrive(liaison);
    w.speak(liaison, "The queue holds what waits; rewind's answer was lost on the way.");
    w.end(liaison);
    await asked;
    expect(answered).toContain("rewind's answer was lost on the way");
  });
});

describe("a teammate compacting itself in the middle of a job", () => {
  test("the answer is the last words of the turn that finishes the job", async () => {
    const { ctx, fallback, arrive, speak, end } = world();
    fallback.status = "permission";
    let answered = "";
    const waiting = sendLetter(ctx, "linux", {
      to: "UI",
      message: "rebuild the composer",
      reply: "wait",
    }).then((result) => {
      answered = result.text;
    });
    arrive("ui");
    speak("ui", "Writing a handoff note and compacting.");
    const from = carryLetter(ctx, "ui");
    expect(from?.agent).toBe("linux");
    expect(from?.carried).toBe(true);
    end("ui", { ok: false, stopped: true });
    await Promise.resolve();
    expect(answered).toBe("");
    // the fresh session, carried on with the job
    ctx.queues.push("ui", {
      id: "carry",
      text: "Carry on from your handoff note.",
      uploads: [],
      silent: false,
      from: from!,
    });
    arrive("ui");
    speak("ui", "The composer is rebuilt.");
    end("ui");
    await waiting;
    expect(answered).toContain("The composer is rebuilt.");
    // a turn that owes no one carries nothing
    expect(carryLetter(ctx, "memory")).toBeUndefined();
  });
});
