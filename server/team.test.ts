import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PermissionRequest, Project, ServerMessage, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { listSeats, sendLetter } from "./handlers/talk.js";
import { atWork, hasSlot, releaseWaiting, rosterText, teamBudget, teamHost } from "./handlers/team.js";
import { ProjectStore } from "./projects.js";
import { SendQueues } from "./queue.js";
import { TalkBook } from "./talk.js";
import {
  leadBriefing,
  memberBriefing,
  parseLevel,
  parseMeminfo,
  parseVmStat,
  slotsFor,
  TeamGovernor,
} from "./team.js";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

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

describe("the machine's room for members at work", () => {
  test("as many more as fit above the reserve, and the ones at work already", () => {
    // 16 GB machine, 6 GB free: the reserve is 2 GB, so 4 GB fits eleven
    // agents of 350 MB — capped at four
    expect(
      slotsFor({ availableBytes: 6 * GB, totalBytes: 16 * GB, perAgentBytes: 350 * MB, atWork: 0, cap: 4 }),
    ).toBe(4);
    // 2.7 GB free: 0.7 GB above the reserve is two more
    expect(
      slotsFor({ availableBytes: 2.7 * GB, totalBytes: 16 * GB, perAgentBytes: 350 * MB, atWork: 1, cap: 4 }),
    ).toBe(3);
  });

  test("never none, so a team short of memory still moves one at a time", () => {
    expect(
      slotsFor({ availableBytes: 0.5 * GB, totalBytes: 8 * GB, perAgentBytes: 350 * MB, atWork: 0, cap: 4 }),
    ).toBe(1);
    // and never takes a slot from one already at work
    expect(
      slotsFor({ availableBytes: 0, totalBytes: 8 * GB, perAgentBytes: 350 * MB, atWork: 2, cap: 4 }),
    ).toBe(2);
  });

  test("a big machine keeps more back for the user", () => {
    // 64 GB: the reserve is 12% (7.7 GB), not 2 GB
    expect(
      slotsFor({ availableBytes: 8 * GB, totalBytes: 64 * GB, perAgentBytes: 400 * MB, atWork: 0, cap: 6 }),
    ).toBe(1);
  });

  test("macOS's free memory counts what it gives up on asking; Linux says it itself", () => {
    const vm = [
      "Mach Virtual Memory Statistics: (page size of 16384 bytes)",
      "Pages free:                               10000.",
      "Pages active:                            400000.",
      "Pages inactive:                          200000.",
      "Pages speculative:                         5000.",
      "Pages wired down:                        100000.",
      "Pages purgeable:                           1000.",
    ].join("\n");
    expect(parseVmStat(vm)).toBe((10000 + 200000 + 5000 + 1000) * 16384);
    expect(parseVmStat("nothing here")).toBeUndefined();
    expect(parseLevel("36\n", 8 * GB)).toBeCloseTo(0.36 * 8 * GB);
    expect(parseLevel("", 8 * GB)).toBeUndefined();
    expect(parseLevel("nope", 8 * GB)).toBeUndefined();
    expect(parseMeminfo("MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    8000000 kB\n")).toBe(
      8000000 * 1024,
    );
    expect(parseMeminfo("MemTotal: 1 kB")).toBeUndefined();
  });

  test("a stale reading is renewed behind the one handed out", async () => {
    let next = 3 * GB;
    const governor = new TeamGovernor({
      read: () => 1 * GB,
      readLater: async () => next,
      totalBytes: 8 * GB,
      cap: 3,
    });
    expect(governor.availableBytes()).toBe(1 * GB);
    (governor as unknown as { at: number }).at = 0;
    expect(governor.availableBytes()).toBe(1 * GB);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(governor.availableBytes()).toBe(3 * GB);
    next = 5 * GB;
    governor.wait("m");
    governor.wait("m");
    expect(governor.waiting).toEqual(["m"]);
    governor.unwait("m");
    expect(governor.waiting).toEqual([]);
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
});

/* ── a team at work, against a server made of just what it touches ── */

function world(opts: { cap?: number; free?: number } = {}) {
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
    { id: "q", name: "site", path: "/tmp/site", sessions: [{ id: "site-lead", lead: true }, { id: "copy" }] },
  ];
  const said: ServerMessage[] = [];
  const statuses: Record<string, string> = {};
  const events: Record<string, TranscriptEvent[]> = {};
  const broadcast = (message: ServerMessage) => said.push(message);
  const find = (id: string) => {
    for (const project of projects) {
      const session = project.sessions.find((s) => s.id === id);
      if (session) return { project, session: { ...session, permissionMode: "bypassPermissions" as const } };
    }
    return undefined;
  };
  const ctx = {
    store: {
      list: () => projects,
      get: (id: string) => projects.find((p) => p.id === id),
      findSession: find,
      isMember: (id: string) => projects.some((p) => p.sessions.findIndex((s) => s.id === id) > 0),
      sessionIds: () => projects.flatMap((p) => p.sessions.map((s) => s.id)),
      defaultModel: () => "sonnet",
      findByQuery: (q: string) => projects.find((p) => p.id === q || p.name === q),
      workspaceDir: () => "/tmp",
      addMember: (projectId: string, member: { name: string; duty: string }) => {
        const session = { id: `m-${member.name}`, title: member.name, duty: member.duty };
        projects.find((p) => p.id === projectId)?.sessions.push(session);
        return session;
      },
      setMember: (id: string, patch: { duty?: string }) => {
        const session = find(id)?.session;
        const real = projects.flatMap((p) => p.sessions).find((s) => s.id === session?.id);
        if (real && patch.duty) real.duty = patch.duty;
      },
    },
    talk: new TalkBook(),
    permissions: new Map<string, PermissionRequest>(),
    clients: { broadcast },
    queues: new SendQueues(broadcast),
    manager: {
      statuses: () => statuses,
      interrupt: () => {},
      live: () => false,
      dispose: () => {},
      send: () => {},
    },
    governor: new TeamGovernor({
      read: () => opts.free ?? 64 * GB,
      readLater: async () => opts.free ?? 64 * GB,
      totalBytes: 128 * GB,
      cap: opts.cap ?? 2,
    }),
    meters: { latest: () => undefined },
    archive: { events: (id: string) => events[id] ?? [], turnIds: () => [] },
    turns: { work: new Map(), progress: new Map(), contexts: new Map() },
    briefs: { get: () => ({ layers: [{ slug: "conversation" }, { slug: "harnesses" }] }) },
    models: { allModels: () => [{ value: "haiku", displayName: "Haiku 4.5" }] },
    retries: { has: () => false, cancelRetry: () => {} },
  } as unknown as ServerContext;
  return { ctx, said, statuses, events, projects };
}

describe("members at work, and the ones waiting for a slot", () => {
  test("a member holding on an answer is not at work: its harness is parked in a call", async () => {
    const { ctx, statuses } = world();
    statuses["ui"] = "working";
    statuses["linux"] = "working";
    // at a card is still in its turn
    statuses["memory"] = "permission";
    expect(atWork(ctx)).toBe(3);
    // linux asks memory, and waits on it
    void sendLetter(ctx, "linux", { to: "Memory", message: "how do briefs work?" });
    expect(atWork(ctx)).toBe(2);
  });

  test("a message to one asleep waits for a slot when the machine has none, and goes when one frees", async () => {
    const { ctx, statuses } = world({ cap: 2 });
    statuses["ui"] = "working";
    statuses["linux"] = "working";
    expect(hasSlot(ctx, "memory")).toBe(false);
    const sent = await sendLetter(ctx, "lead", { to: "Memory", message: "compact faster", reply: "later" });
    expect(sent.text).toContain("waiting for a free slot");
    expect(ctx.governor.waiting).toEqual(["memory"]);
    expect(ctx.queues.entries.get("memory")).toHaveLength(1);
    expect(ctx.talk.letters()[0]).toMatchObject({ to: "memory", status: "queued" });
    // a second one lines up behind it, in the same wait
    await sendLetter(ctx, "lead", { to: "Memory", message: "and test it", reply: "none" });
    expect(ctx.queues.entries.get("memory")).toHaveLength(2);
    expect(ctx.governor.waiting).toEqual(["memory"]);
    // still no room: nothing moves
    releaseWaiting(ctx);
    expect(ctx.governor.waiting).toEqual(["memory"]);
    // ui finishes: memory takes its slot, the first in its line going out
    statuses["ui"] = "idle";
    releaseWaiting(ctx);
    expect(ctx.governor.waiting).toEqual([]);
    expect(ctx.queues.entries.get("memory")).toHaveLength(1);
    // and it holds that slot before its turn has said so
    expect(atWork(ctx)).toBe(2);
    expect(hasSlot(ctx, "ui")).toBe(false);
  });

  test("the budget follows the memory free, and a lead is never held to it", () => {
    const { ctx, statuses } = world({ cap: 6, free: 2.5 * GB });
    // 128 GB machine: the reserve is 15 GB, so 2.5 GB free has no room for
    // one more — but never none
    expect(teamBudget(ctx).slots).toBe(1);
    statuses["lead"] = "working";
    statuses["site-lead"] = "working";
    expect(atWork(ctx)).toBe(0);
  });
});

describe("what the lead reads, and does", () => {
  test("its roster: each teammate's handle, duty, layers and state, and the machine", () => {
    const { ctx, statuses } = world();
    statuses["ui"] = "working";
    const roster = rosterText(ctx, "lead");
    expect(roster).toContain(`${ctx.talk.handleOf("ui")}  UI — working`);
    expect(roster).toContain("duty: the web UI");
    expect(roster).toContain("layers: conversation");
    expect(roster).toContain("Linux port — asleep");
    expect(roster).toContain("The machine:");
    expect(roster).toContain("Teammates at work across ruri: 1");
    // a member has no team to read
    expect(rosterText(ctx, "ui")).toContain("Only the lead");
  });

  test("the list of agents: your own team in full, another project through its lead", () => {
    const { ctx } = world();
    const listed = listSeats(ctx, "lead");
    expect(listed).toContain("UI (duty: the web UI)");
    expect(listed).toContain(`${ctx.talk.handleOf("site-lead")}  the lead`);
    expect(listed).not.toContain(ctx.talk.handleOf("copy"));
    // a member sees its lead and its teammates
    const fromUi = listSeats(ctx, "ui");
    expect(fromUi).toContain(`${ctx.talk.handleOf("lead")}  the lead`);
    expect(fromUi).toContain("Linux port (duty: the Linux build)");
  });

  test("adding a teammate: named, with a duty, never twice, layers checked against the stack", async () => {
    const { ctx, projects } = world();
    const host = teamHost(ctx);
    const added = await host.add("lead", {
      name: "Harness",
      duty: "the agent CLIs",
      layers: ["harnesses", "nope"],
    });
    expect(added).toContain("Added Harness to the team");
    expect(added).toContain("No layer goes by nope");
    expect(added).toContain("asleep until you message it");
    expect(projects[0]!.sessions.at(-1)).toMatchObject({ title: "Harness", duty: "the agent CLIs" });
    expect(await host.add("lead", { name: "harness", duty: "again" })).toContain("on the team already");
    expect(await host.add("ui", { name: "Rogue", duty: "x" })).toContain("Only the lead");
    expect(await host.add("lead", { name: "", duty: "x" })).toContain("needs a name and a duty");
  });

  test("a teammate is found by name or handle, only on the lead's own team", () => {
    const { ctx, projects } = world();
    const host = teamHost(ctx);
    expect(host.update("lead", { who: "ui", duty: "the web UI and the sidebar" })).toContain("Updated UI");
    expect(projects[0]!.sessions[1]!.duty).toBe("the web UI and the sidebar");
    expect(host.update("lead", { who: ctx.talk.handleOf("linux"), duty: "Linux" })).toContain(
      "Updated Linux port",
    );
    expect(host.retire("lead", "copy")).toContain('No teammate answers to "copy"');
    expect(host.reset("site-lead", "UI", "restart")).toContain("No teammate answers");
  });

  test("the words: the lead's are the same every time; a member's say its duty and its layers", () => {
    expect(leadBriefing("ruri", "tool")).toBe(leadBriefing("ruri", "tool"));
    expect(leadBriefing("ruri", "tool")).toContain("mcp__ruri__add_teammate");
    expect(leadBriefing("ruri", "http", "http://x/talk/1")).toContain('{"do": "reset"');
    const member = memberBriefing({
      project: "ruri",
      name: "UI",
      duty: "the web UI",
      layers: ["conversation"],
    });
    expect(member).toContain('You are "UI" on ruri\'s team. Your duty: the web UI.');
    expect(member).toContain("Your layers: conversation");
    expect(member).toContain("Never ask the user");
  });
});
