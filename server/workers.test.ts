import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LetterFrom, Project, ServerMessage } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { asksTheLead, type Pending } from "./talk.js";
import { TaskStore } from "./tasks.js";
import {
  beginTask,
  chartersFile,
  handOff,
  headsWorkers,
  heldReport,
  isWorker,
  migrateStep,
  modelForTask,
  projectQuiet,
  takeFreshBrief,
  taskSettled,
  tasksOf,
  tasksText,
  taskTurnEnded,
  toSwitch,
  workerCap,
} from "./workers.js";

let dir: string;
let saved: string | undefined;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-workers-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A server made of just what worker mode touches — with a config folder
 *  of its own, so one world's task list on disk is never another's. */
function world(opts: { workers?: boolean; prefs?: Record<string, string>; weekly?: number } = {}) {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(dir, "world-"));
  const projects: Project[] = [
    {
      id: "mira",
      name: "mira",
      path: "/tmp/mira",
      starred: true,
      ...(opts.workers === undefined ? {} : { workers: opts.workers }),
      sessions: [
        { id: "lead", title: "Lead", lead: true },
        { id: "liaison", title: "Liaison", liaison: true },
        { id: "go", title: "Go collector", duty: "the Go collector", layers: ["collector"] },
        { id: "web", title: "Web", duty: "the web app" },
      ],
    },
    {
      id: "cobalt",
      name: "cobalt",
      path: "/tmp/cobalt",
      sessions: [
        { id: "c-lead", title: "Lead", lead: true },
        { id: "sec", title: "Security", duty: "security review" },
      ],
    },
  ];
  const statuses: Record<string, string> = {};
  const disposed: string[] = [];
  const cleared: string[] = [];
  const said: ServerMessage[] = [];
  const pending = new Map<string, Pending>();
  const queues = new Map<string, number>();
  const find = (id: string) => {
    for (const project of projects) {
      const session = project.sessions.find((s) => s.id === id);
      if (session) return { project, session };
    }
    return undefined;
  };
  const ctx = {
    store: {
      list: () => projects,
      get: (id: string) => projects.find((p) => p.id === id),
      findSession: find,
      isMember: (id: string) => {
        const found = find(id);
        return !!found && found.project.sessions[0]!.id !== id && !found.session.liaison;
      },
      sessionIds: () => projects.flatMap((p) => p.sessions.map((s) => s.id)),
      defaultModel: () => "opus",
      update: (id: string, patch: Partial<Project>) => Object.assign(projects.find((p) => p.id === id)!, patch),
      setWorkerModel: (id: string, model: string) => {
        find(id)!.session.model = model;
      },
      effectiveSettings: (id: string) => ({ model: find(id)?.session.model ?? "opus" }),
    },
    manager: {
      statuses: () => statuses,
      dispose: (id: string) => disposed.push(id),
      live: () => false,
      setModel: () => {},
    },
    archive: {
      clearLastSessionId: (id: string) => cleared.push(id),
      setContextTokens: () => {},
      contextWindowOf: () => undefined,
      contextTokens: () => undefined,
      turnIds: () => ["a", "b", "c"],
    },
    turns: { contexts: new Map(), work: new Map() },
    models: { windows: new Map() },
    clients: { broadcast: (m: ServerMessage) => said.push(m) },
    queues: { pending: (id: string) => queues.get(id) ?? 0, cutIn: new Set<string>() },
    governor: { waiting: [] as string[] },
    retries: { has: () => false },
    talk: { pending, handleOf: (id: string) => id.slice(0, 8) },
    prefs: { all: () => ({ "ruri-sessions-mode": "team", ...opts.prefs }) },
    usage: { limits: opts.weekly === undefined ? {} : { claude: { weekly: opts.weekly, at: Date.now() } } },
  } as unknown as ServerContext;
  let n = 0;
  /** A letter in flight, as sendLetter keeps it. */
  const letter = (from: string, to: string, text: string): Pending => {
    const one: Pending = {
      id: `letter-${++n}`,
      from,
      to,
      reply: "later",
      depth: 1,
      text,
      ts: Date.now(),
      stage: "queued",
      waiters: new Set(),
    };
    pending.set(one.id, one);
    return one;
  };
  const fromOf = (one: Pending): LetterFrom => ({
    agent: one.from,
    project: "mira",
    title: "Lead",
    letter: one.id,
    reply: one.reply,
    depth: one.depth,
  });
  return { ctx, projects, statuses, disposed, cleared, said, queues, pending, letter, fromOf };
}

describe("a job for a worker is a task", () => {
  test("handed on, it is queued on the list on the worker model; a follow-up while it is open joins it", () => {
    const { ctx, letter } = world({ workers: true });
    const job = letter("lead", "go", "Add retries to the collector's upload.\nIt drops batches on a 503.");
    const task = handOff(ctx, job)!;
    expect(task).toMatchObject({
      id: 1,
      title: "Add retries to the collector's upload.",
      worker: "go",
      workerName: "Go collector",
      asker: "lead",
      askerName: "Lead",
      model: "sonnet",
      status: "queued",
      letters: [job.id],
    });
    const more = letter("lead", "go", "And log each retry.");
    expect(handOff(ctx, more)).toBe(task);
    expect(task.letters).toEqual([job.id, more.id]);
    // another worker's job is a task of its own
    expect(handOff(ctx, letter("lead", "web", "Fix the chart"))?.id).toBe(2);
  });

  test("marked hard it runs on Opus — unless the usage guard is past its first step", () => {
    expect(modelForTask(world().ctx, true)).toBe("opus");
    expect(modelForTask(world().ctx, false)).toBe("sonnet");
    expect(modelForTask(world({ weekly: 61 }).ctx, true)).toBe("sonnet");
    expect(modelForTask(world({ prefs: { "ruri-hard-model": "fable", "ruri-worker-model": "haiku" } }).ctx, true)).toBe(
      "fable",
    );
    expect(modelForTask(world({ prefs: { "ruri-worker-model": "haiku" } }).ctx, false)).toBe("haiku");
    const { ctx, letter } = world({ workers: true });
    expect(handOff(ctx, letter("lead", "go", "Design the queue"), true)).toMatchObject({ model: "opus", hard: true });
  });

  test("nothing for a chat that is no worker: a project on teammates, a lead, the liaison", () => {
    const teammates = world();
    expect(handOff(teammates.ctx, teammates.letter("lead", "go", "x"))).toBeUndefined();
    expect(isWorker(teammates.ctx, "go")).toBe(false);
    const workers = world({ workers: true });
    expect(handOff(workers.ctx, workers.letter("go", "lead", "x"))).toBeUndefined();
    expect(handOff(workers.ctx, workers.letter("go", "liaison", "x"))).toBeUndefined();
    expect(isWorker(workers.ctx, "go")).toBe(true);
    expect(headsWorkers(workers.ctx, "lead")).toBe(true);
    expect(headsWorkers(workers.ctx, "liaison")).toBe(true);
    expect(headsWorkers(workers.ctx, "go")).toBe(false);
    expect(headsWorkers(teammates.ctx, "lead")).toBe(false);
  });

  test("at most two workers at once per project, unless the preference says", () => {
    expect(workerCap(world().ctx)).toBe(2);
    expect(workerCap(world({ prefs: { "ruri-worker-max": "3" } }).ctx)).toBe(3);
    expect(workerCap(world({ prefs: { "ruri-worker-max": "none" } }).ctx)).toBe(2);
  });
});

describe("each task in a fresh session", () => {
  test("its first prompt starts the worker fresh, on the task's model, told of the task and not its past", () => {
    const { ctx, letter, fromOf, disposed, cleared, projects } = world({ workers: true });
    projects[0]!.sessions[2]!.model = "opus";
    const job = letter("lead", "go", "Add retries");
    const task = handOff(ctx, job, false)!;
    beginTask(ctx, "go", fromOf(job));
    expect(disposed).toEqual(["go"]);
    expect(cleared).toEqual(["go"]);
    expect(projects[0]!.sessions[2]!.model).toBe("sonnet");
    expect(task.status).toBe("working");
    expect(task.started).toBeNumber();
    const brief = takeFreshBrief(ctx, "go")!;
    expect(brief).toContain("task 1 on mira's task list, from Lead");
    expect(brief).toContain("Nothing of your earlier jobs is in it");
    // taken once
    expect(takeFreshBrief(ctx, "go")).toBeUndefined();
  });

  test("a follow-up goes on in the same session; so do answers, ruri's prompts and the user's own words", () => {
    const { ctx, letter, fromOf, disposed } = world({ workers: true });
    const job = letter("lead", "go", "Add retries");
    const task = handOff(ctx, job)!;
    beginTask(ctx, "go", fromOf(job));
    expect(disposed).toHaveLength(1);
    // it asked; the lead answers
    tasksOf(ctx).end("mira", task, "blocked", "Which backoff?");
    const answer = letter("lead", "go", "Exponential, max 5");
    expect(handOff(ctx, answer)).toBe(task);
    expect(task.status).toBe("queued");
    beginTask(ctx, "go", fromOf(answer));
    expect(disposed).toHaveLength(1);
    expect(task.status).toBe("working");
    beginTask(ctx, "go", { ...fromOf(job), answer: true });
    beginTask(ctx, "go", { ...fromOf(job), carried: true });
    beginTask(ctx, "go", undefined);
    expect(disposed).toHaveLength(1);
    expect(takeFreshBrief(ctx, "go")).toBeDefined();
  });

  test("a letter from before the switch, with no task, finishes the old way", () => {
    const { ctx, letter, fromOf, disposed } = world({ workers: true });
    beginTask(ctx, "go", fromOf(letter("lead", "go", "old job")));
    expect(disposed).toEqual([]);
    expect(takeFreshBrief(ctx, "go")).toBeUndefined();
  });

  test("the next job, once this one is done, starts fresh again", () => {
    const { ctx, letter, fromOf, disposed } = world({ workers: true });
    const one = letter("lead", "go", "first");
    const task = handOff(ctx, one)!;
    beginTask(ctx, "go", fromOf(one));
    expect(taskSettled(ctx, one, "answered", "Done: retries added.", asksTheLead)).toBe(task);
    expect(task.status).toBe("done");
    const two = letter("lead", "go", "second");
    expect(handOff(ctx, two)!.id).toBe(2);
    beginTask(ctx, "go", fromOf(two));
    expect(disposed).toEqual(["go", "go"]);
  });
});

describe("how a task ends", () => {
  test("done, blocked on a question, or failed — its report kept and its turns' cost added up", () => {
    const { ctx, letter, fromOf } = world({ workers: true });
    const job = letter("lead", "go", "Add retries");
    const task = handOff(ctx, job)!;
    beginTask(ctx, "go", fromOf(job));
    taskTurnEnded(ctx, "go", 0.12);
    taskTurnEnded(ctx, "go", 0.3);
    expect(task.costUsd).toBeCloseTo(0.42);
    expect(task.turns).toBe(2);
    taskSettled(ctx, job, "answered", "BLOCKED: no credentials for the bucket", asksTheLead);
    expect(task.status).toBe("blocked");
    expect(task.report).toBe("BLOCKED: no credentials for the bucket");
    const again = letter("lead", "go", "Use the staging key");
    handOff(ctx, again);
    beginTask(ctx, "go", fromOf(again));
    // the first letter's end no longer speaks for the task
    taskSettled(ctx, job, "failed", "late", asksTheLead);
    expect(task.status).toBe("working");
    taskSettled(ctx, again, "failed", "The user stopped it.", asksTheLead);
    expect(task.status).toBe("failed");
    expect(task.ended).toBeNumber();
    // a task that has ended is left be
    taskSettled(ctx, again, "answered", "done after all", asksTheLead);
    expect(task.status).toBe("failed");
  });

  test("what the lead reads: the list, one task in full, and a finished report cut short", () => {
    const { ctx, letter, fromOf } = world({ workers: true });
    const job = letter("lead", "go", "Add retries to the upload");
    const task = handOff(ctx, job)!;
    beginTask(ctx, "go", fromOf(job));
    taskTurnEnded(ctx, "go", 0.5);
    taskSettled(ctx, job, "answered", "Retries added with backoff; tests pass.", asksTheLead);
    handOff(ctx, letter("lead", "web", "Fix the chart's axis"));
    const list = tasksText(ctx, "mira");
    expect(list).toContain("Open:\n  2. Fix the chart's axis — Web · queued · sonnet");
    expect(list).toContain("  1. Add retries to the upload — Go collector · done · sonnet · $0.50");
    expect(list).toContain("Retries added with backoff; tests pass.");
    const one = tasksText(ctx, "mira", 1);
    expect(one).toContain("Task 1: Add retries to the upload");
    expect(one).toContain("Report:\nRetries added with backoff; tests pass.");
    expect(tasksText(ctx, "mira", 9)).toBe("No task 9 in mira's list.");
    expect(tasksText(ctx, "cobalt")).toContain("task list is empty");
    expect(heldReport(task, "short")).toBe("Task 1 (Add retries to the upload) is done · $0.50. Its report:\n\nshort");
    const long = heldReport(task, "x".repeat(2000));
    expect(long).toContain("Its report, cut — the whole of it: tasks with id 1");
    expect(long.length).toBeLessThan(1700);
  });
});

describe("the task list on disk", () => {
  test("kept per project, read back by a new store", () => {
    process.env["RURI_CONFIG_DIR"] = dir;
    const store = new TaskStore();
    const made = store.create("p1", {
      job: "one",
      letter: "l1",
      worker: "w",
      workerName: "W",
      asker: "lead",
      askerName: "Lead",
      model: "sonnet",
    });
    store.end("p1", made, "done", "ok");
    store.flush();
    const file = path.join(dir, "tasks", "p1.json");
    expect(fs.existsSync(file)).toBe(true);
    const again = new TaskStore();
    expect(again.list("p1")).toHaveLength(1);
    expect(again.byLetter("l1", "p1")?.task.report).toBe("ok");
    expect(again.openFor("p1", "w")).toBeUndefined();
  });
});

describe("the switch, project by project", () => {
  test("mira first, and only while quiet; then every quiet project left; never one switched back", () => {
    const { ctx, projects, statuses, queues } = world();
    expect(toSwitch(ctx).map((p) => p.name)).toEqual(["mira", "cobalt"]);
    statuses["go"] = "working";
    expect(projectQuiet(ctx, projects[0]!)).toBe(false);
    // mira at work: nothing switches, cobalt waits behind it
    expect(migrateStep(ctx)).toEqual([]);
    expect(projects[1]!.workers).toBeUndefined();
    delete statuses["go"];
    queues.set("web", 1);
    expect(migrateStep(ctx)).toEqual([]);
    queues.delete("web");
    expect(migrateStep(ctx).map((p) => p.name)).toEqual(["mira"]);
    expect(projects[0]!.workers).toBe(true);
    // its charters, written down
    const charters = fs.readFileSync(chartersFile("mira"), "utf8");
    expect(charters).toContain("# mira: charters");
    expect(charters).toContain("## Go collector");
    expect(charters).toContain("- duty: the Go collector");
    expect(charters).toContain("- layers: collector");
    expect(charters).not.toContain("## Lead");
    expect(charters).not.toContain("## Liaison");
    expect(migrateStep(ctx).map((p) => p.name)).toEqual(["cobalt"]);
    expect(toSwitch(ctx)).toEqual([]);
  });

  test("a letter in flight to or from the project keeps it from switching; off stops it all", () => {
    const { ctx, projects, letter } = world();
    const out = letter("lead", "sec", "a question for cobalt");
    expect(projectQuiet(ctx, projects[0]!)).toBe(false);
    expect(projectQuiet(ctx, projects[1]!)).toBe(false);
    out.reply = "none";
    expect(projectQuiet(ctx, projects[0]!)).toBe(true);
    expect(projectQuiet(ctx, projects[1]!)).toBe(false);
    const off = world({ prefs: { "ruri-workers-migrate": "off" } });
    expect(migrateStep(off.ctx)).toEqual([]);
    const back = world({ workers: false });
    expect(toSwitch(back.ctx).map((p) => p.name)).toEqual(["cobalt"]);
  });
});
