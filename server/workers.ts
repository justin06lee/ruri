import * as path from "node:path";
import { leadOf, type LetterFrom, type Project } from "../shared/protocol.js";
import { writeTextAtomic } from "./atomic.js";
import { running } from "./channel.js";
import { configPath } from "./configDir.js";
import type { ServerContext } from "./context.js";
import { warn } from "./log.js";
import { isOpen, oneLine, TaskStore, type Task } from "./tasks.js";
import type { Pending } from "./talk.js";
import { resetContext } from "./turns.js";
import { guardLevel, STEP_DOWN_MODEL } from "./usageGuard.js";

/**
 * Worker mode (docs/token-efficiency.md, "The new design"): a project
 * whose teammates are charters, not conversations.
 *
 * A teammate's name, duty and layers stay — its charter — but the job
 * handed to it starts a fresh session, briefed with that charter, the
 * layer sheets, the project's catch-up and the job, and nothing of the
 * jobs before. Follow-ups within the job (an answer to its question, the
 * answers to what it asked others) go on in that session; the next job
 * starts fresh again. Every job is a task on the project's task list
 * (server/tasks.ts), with its model — Sonnet, or Opus when the asker
 * marked it hard — its status, its report and its cost. At most
 * workerCap() of a project's workers are at work at once
 * (handlers/team.ts hasSlot); the rest wait in line.
 *
 * A project is switched to it by the migration below, only while none of
 * its chats is at work; a job in flight when it switches has no task, and
 * finishes the old way.
 */

/** Workers at work at once in one project, unless "ruri-worker-max" says. */
export const WORKER_MAX = 2;

/** A job's model, unless the preferences say otherwise: Sonnet for most,
 *  Opus for one the asker marked hard. */
export const WORKER_MODEL = STEP_DOWN_MODEL;
export const HARD_MODEL = "opus";

interface Workers {
  tasks: TaskStore;
  /** Workers about to start a job fresh: the brief their new session
   *  gets instead of the conversation's. */
  fresh: Map<string, string>;
  migrating?: NodeJS.Timeout;
}

const all = new WeakMap<ServerContext, Workers>();

function workersOf(ctx: ServerContext): Workers {
  let workers = all.get(ctx);
  if (!workers) all.set(ctx, (workers = { tasks: new TaskStore(), fresh: new Map() }));
  return workers;
}

/** The server's task lists. */
export function tasksOf(ctx: ServerContext): TaskStore {
  return workersOf(ctx).tasks;
}

function prefs(ctx: ServerContext): Record<string, string> {
  return ctx.prefs?.all?.() ?? {};
}

/** Whether a project runs on workers. */
export function workerMode(project: Project | undefined): boolean {
  return project?.workers === true;
}

/** Whether a chat is a worker: a member of a project run on workers. */
export function isWorker(ctx: ServerContext, chat: string): boolean {
  const found = ctx.store.findSession(chat);
  return !!found && workerMode(found.project) && ctx.store.isMember(chat);
}

/** Whether a chat is the lead or the liaison of a project run on workers. */
export function headsWorkers(ctx: ServerContext, chat: string): boolean {
  const found = ctx.store.findSession(chat);
  if (!found || !workerMode(found.project)) return false;
  return found.session.liaison === true || leadOf(found.project)?.id === chat;
}

/** How many of one project's workers may be at work at once. */
export function workerCap(ctx: ServerContext): number {
  const said = Number(prefs(ctx)["ruri-worker-max"]);
  return Number.isFinite(said) && said >= 1 ? Math.floor(said) : WORKER_MAX;
}

/** The model a job runs on: the worker model, or — marked hard, and the
 *  usage guard not past its first step — the hard one. */
export function modelForTask(ctx: ServerContext, hard: boolean): string {
  const plain = prefs(ctx)["ruri-worker-model"]?.trim() || WORKER_MODEL;
  if (!hard || guardLevel(ctx) >= 1) return plain;
  return prefs(ctx)["ruri-hard-model"]?.trim() || HARD_MODEL;
}

/* ── a task's life ────────────────────────────────────────────────── */

/**
 * A letter going to a worker (handlers/talk.ts sendLetter): a new task, or
 * — the worker has one open — a follow-up joining it. Nothing for a chat
 * that is no worker.
 */
export function handOff(ctx: ServerContext, letter: Pending, hard = false): Task | undefined {
  const found = ctx.store.findSession(letter.to);
  if (!found || !workerMode(found.project) || !ctx.store.isMember(letter.to)) return undefined;
  const tasks = tasksOf(ctx);
  const projectId = found.project.id;
  const open = tasks.openFor(projectId, letter.to);
  if (open) {
    tasks.join(projectId, open, letter.id);
    return open;
  }
  const asker = ctx.store.findSession(letter.from);
  return tasks.create(projectId, {
    job: letter.text,
    letter: letter.id,
    worker: letter.to,
    workerName: found.session.title ?? "",
    asker: letter.from,
    askerName: asker
      ? asker.project.id === projectId
        ? asker.session.title || "untitled"
        : `${asker.project.name} · ${asker.session.title || "untitled"}`
      : "",
    model: modelForTask(ctx, hard),
    ...(hard ? { hard: true } : {}),
  });
}

/** What a worker's fresh session is told, ahead of the job itself. */
export function freshTaskBrief(project: string, task: Task): string {
  return [
    "<ruri:task>",
    `This session is new, for one job: task ${task.id} on ${project}'s task list, from ${task.askerName || "another agent"}. Nothing of your earlier jobs is in it. What you need is your charter (your duty and layers), your layers' sheets, the project's catch-up and the message below. \`ruri recall <words>\` finds what earlier exchanges said, and \`ruri tasks\` lists what earlier tasks reported.`,
    "Do this job, then end your turn with your report: what you did, what you found, what is left. It goes on the task list and back to whoever asked. If you need a decision, end on the question, or start the report with BLOCKED:, and the answer comes back into this same session.",
    "</ruri:task>",
    "",
  ].join("\n");
}

/**
 * A prompt about to go to a chat (dispatch.ts, before anything else is
 * read of it). For a worker's letter that starts a task, the worker starts
 * fresh: its process and its sessions go, its gauge reads empty, it runs on
 * the task's model, and its first prompt carries freshTaskBrief instead of
 * the conversation. A follow-up — the task already under way — goes on in
 * its session. Anything else (an answer, ruri's own prompts, the user's
 * own words, a letter from before the switch) is left as it was.
 */
export function beginTask(ctx: ServerContext, chat: string, from: LetterFrom | undefined): void {
  if (!from || from.answer || from.carried) return;
  const found = ctx.store.findSession(chat);
  if (!found || !workerMode(found.project) || !ctx.store.isMember(chat)) return;
  const tasks = tasksOf(ctx);
  const hit = tasks.byLetter(from.letter, found.project.id);
  if (!hit || hit.task.worker !== chat) return;
  const { task } = hit;
  if (task.started === undefined) {
    ctx.manager.dispose(chat);
    ctx.archive.clearLastSessionId(chat);
    resetContext(ctx, chat);
    if (found.session.model !== task.model) ctx.store.setWorkerModel(chat, task.model);
    workersOf(ctx).fresh.set(chat, freshTaskBrief(found.project.name, task));
  }
  tasks.start(found.project.id, task);
}

/** The brief a worker's fresh session takes, once (handoff.ts catchUp). */
export function takeFreshBrief(ctx: ServerContext, chat: string): string | undefined {
  const fresh = workersOf(ctx).fresh;
  const brief = fresh.get(chat);
  fresh.delete(chat);
  return brief;
}

/** A worker's turn ended: its task carries the cost. */
export function taskTurnEnded(ctx: ServerContext, chat: string, costUsd: number | undefined): void {
  const found = ctx.store.findSession(chat);
  if (!found || !workerMode(found.project)) return;
  const task = tasksOf(ctx).openFor(found.project.id, chat);
  if (task?.status === "working") tasksOf(ctx).spent(found.project.id, task, costUsd);
}

/**
 * A letter has ended (handlers/talk.ts settle). When it is a task's, the
 * task ends with it — done, or blocked on a question the asker is to
 * answer, or failed — and the report is kept. Answers the task, for the
 * words the asker is handed.
 */
export function taskSettled(
  ctx: ServerContext,
  letter: Pending,
  outcome: "answered" | "failed" | "dropped",
  text: string,
  asks: (text: string) => boolean,
): Task | undefined {
  const found = ctx.store.findSession(letter.to);
  const hit = tasksOf(ctx).byLetter(letter.id, found?.project.id);
  if (!hit || !isOpen(hit.task)) return undefined;
  // a follow-up's end speaks for the task only when it is the newest
  if (hit.task.letters.at(-1) !== letter.id) return hit.task;
  const status = outcome !== "answered" ? "failed" : asks(text) ? "blocked" : "done";
  tasksOf(ctx).end(hit.projectId, hit.task, status, text);
  return hit.task;
}

/** A worker leaving the team: what it had open fails. */
export function workerGone(ctx: ServerContext, chat: string, why: string): void {
  const found = ctx.store.findSession(chat);
  if (found) tasksOf(ctx).dropWorker(found.project.id, chat, why);
}

/* ── what the lead reads ──────────────────────────────────────────── */

function dollars(usd: number | undefined): string {
  return usd ? ` · $${usd < 1 ? usd.toFixed(2) : usd.toFixed(1)}` : "";
}

/** One task, on one line. */
export function taskLine(task: Task): string {
  return `  ${task.id}. ${task.title} — ${task.workerName || "a worker"} · ${task.status}${task.hard ? " · hard" : ""} · ${task.model}${dollars(task.costUsd)}`;
}

/** A finished task's report as it comes to its asker with its next
 *  prompt: short, and where the rest is. */
export function heldReport(task: Task, report: string, max = 1500): string {
  const said = report.trim();
  const cut = said.length > max;
  return `Task ${task.id} (${task.title}) is ${task.status}${dollars(task.costUsd)}. ${
    cut ? `Its report, cut — the whole of it: tasks with id ${task.id}` : "Its report"
  }:\n\n${cut ? `${said.slice(0, max)}…` : said}`;
}

/** The task list, as the lead's tasks tool and `ruri tasks` give it: the
 *  open ones, then the newest closed; or one in full. */
export function tasksText(ctx: ServerContext, projectId: string, id?: number): string {
  const project = ctx.store.get(projectId);
  if (!project) return "No such project.";
  const tasks = tasksOf(ctx).list(projectId);
  if (id !== undefined) {
    const task = tasks.find((one) => one.id === id);
    if (!task) return `No task ${id} in ${project.name}'s list.`;
    const when = (ts: number | undefined) => (ts ? new Date(ts).toLocaleString() : "—");
    return [
      `Task ${task.id}: ${task.title}`,
      `  worker: ${task.workerName || "a worker"} (${ctx.talk.handleOf(task.worker)}) · ${task.model}${task.hard ? " · hard" : ""}`,
      `  asked by: ${task.askerName || "another agent"} · status: ${task.status}${dollars(task.costUsd)}${task.turns ? ` · ${task.turns} turn${task.turns === 1 ? "" : "s"}` : ""}`,
      `  handed on ${when(task.created)} · started ${when(task.started)} · ended ${when(task.ended)}`,
      ...(task.letters.length > 1 ? [`  ${task.letters.length - 1} follow-up${task.letters.length === 2 ? "" : "s"}`] : []),
      "",
      task.report ? `Report:\n${task.report}` : "No report yet.",
    ].join("\n");
  }
  if (tasks.length === 0)
    return `${project.name}'s task list is empty: a job handed to a worker with message_agent is its first task.`;
  const open = tasks.filter(isOpen);
  const closed = tasks.filter((task) => !isOpen(task)).slice(-12);
  const spent = tasks.reduce((sum, task) => sum + (task.costUsd ?? 0), 0);
  return [
    `${project.name}'s tasks — number. title — worker · status · model · cost (${tasks.length} on the list${dollars(spent)}):`,
    ...(open.length ? ["Open:", ...open.map(taskLine)] : ["Nothing open."]),
    ...(closed.length
      ? [
          "Closed, newest last:",
          ...closed.map((task) => `${taskLine(task)}${task.report ? `\n     ${oneLine(task.report, 140)}` : ""}`),
        ]
      : []),
    "One in full, with its whole report: tasks with its id.",
  ].join("\n");
}

/* ── the switch ───────────────────────────────────────────────────── */

/** Whether a project could switch now: none of its chats at work, nothing
 *  in a line, no message out to one of them or from one. */
export function projectQuiet(ctx: ServerContext, project: Project): boolean {
  const chats = new Set(project.sessions.map((session) => session.id));
  const statuses = ctx.manager.statuses();
  for (const chat of chats) {
    if (running(ctx, chat) || statuses[chat] === "permission") return false;
    if (ctx.queues.pending(chat) > 0 || ctx.queues.cutIn.has(chat)) return false;
    if (ctx.governor.waiting.includes(chat) || ctx.retries.has(chat)) return false;
  }
  for (const letter of ctx.talk.pending.values()) {
    if (letter.ending) continue;
    if (chats.has(letter.to) || (chats.has(letter.from) && letter.reply !== "none")) return false;
  }
  return true;
}

/** Where a project's charters are written down, as they stood when it
 *  switched. */
export function chartersFile(projectId: string): string {
  return configPath("charters", `${path.basename(projectId)}.md`);
}

/** A project's charters, in words: each teammate's name, duty, layers. */
export function chartersText(ctx: ServerContext, project: Project): string {
  const lead = leadOf(project)?.id;
  const members = project.sessions.filter((session) => session.id !== lead && !session.liaison);
  return [
    `# ${project.name}: charters`,
    "",
    `Written ${new Date().toISOString()}, when ${project.name} switched from persistent teammates to workers (docs/token-efficiency.md in ruri). Each charter is what a teammate was — its name, duty and layers — and what a worker on a job for it is briefed with. They stay on the team page, where the lead can change them (update_teammate).`,
    "",
    ...members.flatMap((member) => [
      `## ${member.title || "untitled"}`,
      "",
      `- duty: ${member.duty || "(none given)"}`,
      ...(member.layers?.length ? [`- layers: ${member.layers.join(", ")}`] : []),
      `- chat: ${member.id} (${ctx.archive.turnIds(member.id).length} exchanges as a teammate)`,
      "",
    ]),
  ].join("\n");
}

/**
 * Switch one project to workers: its charters written down, the flag set,
 * and its two leads' sessions let go of so their next prompt reads the
 * new words (the conversation is kept — it resumes).
 */
export function switchToWorkers(ctx: ServerContext, project: Project): void {
  try {
    writeTextAtomic(chartersFile(project.id), chartersText(ctx, project));
  } catch (err) {
    warn("workers", err, "charters");
  }
  ctx.store.update(project.id, { workers: true });
  for (const session of project.sessions) if (!running(ctx, session.id)) ctx.manager.dispose(session.id);
  ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
}

/** The projects still to switch, in order: "ruri-workers-first" (names,
 *  comma-separated — mira by default) first, then the rest as listed.
 *  Never one switched back by hand (workers: false). */
export function toSwitch(ctx: ServerContext): Project[] {
  const first = (prefs(ctx)["ruri-workers-first"] ?? "mira")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const left = ctx.store.list().filter((project) => project.workers === undefined);
  const rank = (project: Project) => {
    const at = first.indexOf(project.name.toLowerCase());
    return at === -1 ? first.length : at;
  };
  return left
    .map((project, at) => ({ project, at }))
    .sort((a, b) => rank(a.project) - rank(b.project) || a.at - b.at)
    .map(({ project }) => project);
}

/** How often the migration looks for a quiet project. */
export const MIGRATE_EVERY_MS = 30_000;

/**
 * One look: the projects "ruri-workers-first" names switch first, each
 * once it is quiet, and nothing else does until they have — so mira goes
 * first; after them, every quiet project left switches. A project only
 * ever switches between jobs. "off" in "ruri-workers-migrate" stops it.
 * Answers the projects switched.
 */
export function migrateStep(ctx: ServerContext): Project[] {
  if ((prefs(ctx)["ruri-workers-migrate"] ?? "").trim().toLowerCase() === "off") return [];
  const left = toSwitch(ctx);
  const first = (prefs(ctx)["ruri-workers-first"] ?? "mira")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const firsts = left.filter((project) => first.includes(project.name.toLowerCase()));
  const now = (firsts.length ? firsts : left).filter((project) => projectQuiet(ctx, project));
  for (const project of now) switchToWorkers(ctx, project);
  return now;
}

/** The migration's clock: until every project has switched. */
export function startMigration(ctx: ServerContext, onSwitched?: (project: Project) => void): void {
  const workers = workersOf(ctx);
  if (workers.migrating || toSwitch(ctx).length === 0) return;
  workers.migrating = setInterval(() => {
    for (const switched of migrateStep(ctx)) onSwitched?.(switched);
    if (toSwitch(ctx).length === 0) stopMigration(ctx);
  }, MIGRATE_EVERY_MS);
  workers.migrating.unref?.();
}

export function stopMigration(ctx: ServerContext): void {
  const workers = workersOf(ctx);
  if (workers.migrating) clearInterval(workers.migrating);
  delete workers.migrating;
  workers.tasks.flush();
}
