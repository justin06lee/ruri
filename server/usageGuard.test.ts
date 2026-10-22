import { describe, expect, test } from "bun:test";
import type { LetterFrom, Project, ServerMessage } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import {
  FRESH_FOR_MS,
  guardedModel,
  guardHolds,
  guardLevel,
  guardState,
  guardSteps,
  guardTick,
  park,
  parkedFor,
  projectPaused,
  unpark,
  weeklyPercent,
  type Parked,
} from "./usageGuard.js";

function world(weekly: number | undefined, prefs: Record<string, string> = {}, at = Date.now()) {
  const projects: Project[] = [
    { id: "mira", name: "mira", path: "/tmp/mira", starred: true, sessions: [{ id: "mira-lead", lead: true }] },
    { id: "cobalt", name: "cobalt", path: "/tmp/cobalt", sessions: [{ id: "cobalt-lead", lead: true }] },
    { id: "toji", name: "toji", path: "/tmp/toji", sessions: [{ id: "toji-lead", lead: true }] },
  ];
  const said: ServerMessage[] = [];
  const models: Record<string, string> = {};
  const live = new Set<string>();
  const usage = { limits: weekly === undefined ? {} : { claude: { weekly, at } } };
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
      sessionIds: () => projects.flatMap((p) => p.sessions.map((s) => s.id)),
      defaultModel: () => "opus",
      effectiveSettings: () => ({ model: "opus" }),
    },
    manager: { live: (id: string) => live.has(id), setModel: (id: string, model: string) => (models[id] = model) },
    clients: { broadcast: (m: ServerMessage) => said.push(m) },
    prefs: { all: () => prefs },
    usage,
  } as unknown as ServerContext;
  return { ctx, projects, said, models, live, usage };
}

const from = (letter: string): LetterFrom => ({
  agent: "a",
  project: "x",
  title: "y",
  letter,
  reply: "later",
  depth: 1,
});

describe("how far up its steps the week is", () => {
  test("60, 70, 80 by the fresh weekly reading; none without one, or with a stale one", () => {
    expect(guardLevel(world(59).ctx)).toBe(0);
    expect(guardLevel(world(60).ctx)).toBe(1);
    expect(guardLevel(world(70).ctx)).toBe(2);
    expect(guardLevel(world(85).ctx)).toBe(3);
    expect(guardLevel(world(undefined).ctx)).toBe(0);
    const stale = world(95, {}, Date.now() - FRESH_FOR_MS - 1);
    expect(weeklyPercent(stale.ctx)).toBeUndefined();
    expect(guardLevel(stale.ctx)).toBe(0);
  });

  test("the user moves the steps, or turns the guard off", () => {
    expect(guardSteps(world(0, { "ruri-usage-steps": "50, 75, 90" }).ctx)).toEqual([50, 75, 90]);
    expect(guardLevel(world(76, { "ruri-usage-steps": "50,75,90" }).ctx)).toBe(2);
    // not three rising percentages: the defaults
    expect(guardSteps(world(0, { "ruri-usage-steps": "90,80,70" }).ctx)).toEqual([60, 70, 80]);
    expect(guardLevel(world(99, { "ruri-usage-guard": "off" }).ctx)).toBe(0);
  });
});

describe("what each step does", () => {
  test("past 60, Opus and Fable step down to the worker model; other harnesses' models are left", () => {
    const { ctx } = world(65);
    expect(guardedModel(ctx, "opus")).toBe("sonnet");
    expect(guardedModel(ctx, "claude-fable-5-1[1m]")).toBe("sonnet");
    expect(guardedModel(ctx, undefined)).toBe("sonnet");
    expect(guardedModel(ctx, "haiku")).toBe("haiku");
    expect(guardedModel(ctx, "codex:gpt-5.6-luna")).toBe("codex:gpt-5.6-luna");
    expect(guardedModel(world(65, { "ruri-worker-model": "haiku" }).ctx, "opus")).toBe("haiku");
    expect(guardedModel(world(40).ctx, "opus")).toBe("opus");
    expect(guardedModel(world(40).ctx, undefined)).toBeUndefined();
  });

  test("past 70, unstarred projects pause unless kept; past 80, every project", () => {
    const { ctx, projects } = world(72, { "ruri-guard-keep": "Toji" });
    expect(projectPaused(ctx, projects[0]!)).toBe(false);
    expect(projectPaused(ctx, projects[1]!)).toBe(true);
    expect(projectPaused(ctx, projects[2]!)).toBe(false);
    expect(guardHolds(ctx, "mira-lead")).toBeUndefined();
    expect(guardHolds(ctx, "cobalt-lead")).toBe(
      "the week's Claude usage is at 72%, past 70%: cobalt is paused, as only starred projects' agents work now",
    );
    const all = world(81);
    expect(guardHolds(all.ctx, "mira-lead")).toBe(
      "the week's Claude usage is at 81%, past 80%: all agent work waits until it falls",
    );
    expect(guardState(all.ctx)).toMatchObject({ level: 3, weekly: 81, paused: ["mira", "cobalt", "toji"] });
    expect(guardHolds(world(65).ctx, "cobalt-lead")).toBeUndefined();
  });
});

describe("messages waiting on the guard", () => {
  test("parked once each, and delivered as the week falls; a closing chat takes its own", () => {
    const { ctx, usage, said } = world(82);
    const delivered: Parked[] = [];
    const hooks = { deliver: (one: Parked) => delivered.push(one) };
    guardTick(ctx, hooks);
    park(ctx, { chat: "mira-lead", text: "a report", from: from("l1"), delivery: "interrupt" });
    park(ctx, { chat: "mira-lead", text: "a report", from: from("l1"), delivery: "interrupt" });
    park(ctx, { chat: "cobalt-lead", text: "a job", from: from("l2"), delivery: "queue" });
    park(ctx, { chat: "toji-lead", text: "gone", from: from("l3"), delivery: "queue" });
    expect(parkedFor(ctx, "mira-lead")).toBe(1);
    unpark(ctx, new Set(["toji-lead"]));
    expect(parkedFor(ctx, "toji-lead")).toBe(0);
    expect(guardTick(ctx, hooks)).toBe(false);
    // the week falls to 75: mira (starred) works again, cobalt still waits
    usage.limits = { claude: { weekly: 75, at: Date.now() } };
    expect(guardTick(ctx, hooks)).toBe(true);
    expect(delivered.map((one) => one.text)).toEqual(["a report"]);
    expect(parkedFor(ctx, "cobalt-lead")).toBe(1);
    expect(said.at(-1)).toMatchObject({ type: "guard", guard: { level: 2, paused: ["cobalt", "toji"], waiting: 1 } });
    usage.limits = { claude: { weekly: 30, at: Date.now() } };
    guardTick(ctx, hooks);
    expect(delivered.map((one) => one.text)).toEqual(["a report", "a job"]);
    expect(said.at(-1)).toMatchObject({ type: "guard", guard: { level: 0, paused: [], waiting: 0 } });
  });

  test("crossing 60 either way puts every live session on the model it should run on now", () => {
    const { ctx, usage, models, live } = world(50);
    const moved: string[] = [];
    const hooks = { deliver: () => {}, moved: (a: number, b: number) => moved.push(`${a}→${b}`) };
    guardTick(ctx, hooks);
    live.add("mira-lead");
    usage.limits = { claude: { weekly: 62, at: Date.now() } };
    guardTick(ctx, hooks);
    expect(models).toEqual({ "mira-lead": "sonnet" });
    usage.limits = { claude: { weekly: 20, at: Date.now() } };
    guardTick(ctx, hooks);
    expect(models).toEqual({ "mira-lead": "opus" });
    expect(moved).toEqual(["0→1", "1→0"]);
  });
});
