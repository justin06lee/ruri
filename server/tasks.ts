import * as fs from "node:fs";
import * as path from "node:path";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/**
 * Each project's task list: every job its lead (or its liaison, or a
 * worker) hands to a worker, and how it went — the structure that used to
 * live only in chat relays (docs/token-efficiency.md, "The new design").
 *
 * A task is written when the job is handed on, marked working when its
 * worker starts on it, and marked done, blocked or failed — with the
 * worker's report, clipped, and what its turns cost — when the worker
 * answers. A follow-up handed to a worker while its task is still open
 * joins that task rather than making another: it is the same job, in the
 * same session. One file per project under the config folder, the newest
 * MAX_KEPT kept.
 */

export type TaskStatus = "queued" | "working" | "blocked" | "done" | "failed";

export interface Task {
  /** Per project, counting up from 1: "task 12". */
  id: number;
  /** The job's first line, clipped. */
  title: string;
  /** The worker's chat, and its name as it stood. */
  worker: string;
  workerName: string;
  /** Who handed it on: a chat, and its name as it stood. */
  asker: string;
  askerName: string;
  /** The model it runs on, and whether the asker marked it hard. */
  model: string;
  hard?: boolean;
  status: TaskStatus;
  /** The letters that make it up: the hand-off, then any follow-ups. */
  letters: string[];
  created: number;
  started?: number;
  ended?: number;
  /** The worker's last report on it, clipped. */
  report?: string;
  /** What its turns cost (API prices), and how many there were. */
  costUsd?: number;
  turns?: number;
}

/** Tasks kept per project: the newest. */
export const MAX_KEPT = 300;
/** A report kept on a task, at most. */
export const REPORT_MAX = 6000;
const TITLE_MAX = 100;
const WRITE_DELAY_MS = 500;

/** Words on one line, cut to fit. */
export function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A task's title, from the job as it was written: its first line that
 *  says something. */
export function titleOf(job: string): string {
  const first = job.split("\n").find((line) => line.trim() !== "") ?? job;
  return oneLine(first, TITLE_MAX) || "(no words)";
}

/** Whether a task is still the worker's: nothing has closed it. */
export function isOpen(task: Task): boolean {
  return task.status === "queued" || task.status === "working" || task.status === "blocked";
}

export class TaskStore {
  /** Where the lists live, fixed when the store is made: a write a moment
   *  after a change goes where the store was read from. */
  private readonly dir = configPath("tasks");
  private readonly lists = new Map<string, Task[]>();
  private readonly dirty = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  private file(projectId: string): string {
    return path.join(this.dir, `${path.basename(projectId)}.json`);
  }

  private load(projectId: string): Task[] {
    let list = this.lists.get(projectId);
    if (list) return list;
    list = [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(projectId), "utf8")) as { tasks?: Task[] };
      list = (raw.tasks ?? []).filter((task) => typeof task?.id === "number" && typeof task.worker === "string");
    } catch (err) {
      if (!isMissing(err)) warn("tasks", err, "load");
    }
    this.lists.set(projectId, list);
    return list;
  }

  private touch(projectId: string): void {
    this.dirty.add(projectId);
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.timer.unref?.();
  }

  /** Write every list that changed, now. */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const projectId of this.dirty) {
      try {
        writeJsonAtomic(this.file(projectId), { tasks: this.load(projectId) });
      } catch (err) {
        warn("tasks", err, "flush");
      }
    }
    this.dirty.clear();
  }

  /** A project's tasks, oldest first. */
  list(projectId: string): readonly Task[] {
    return this.load(projectId);
  }

  get(projectId: string, id: number): Task | undefined {
    return this.load(projectId).find((task) => task.id === id);
  }

  /** The task a letter is part of, and its project — looked for in the
   *  project named first, which is read from disk if it has to be. */
  byLetter(letterId: string, projectId?: string): { projectId: string; task: Task } | undefined {
    if (projectId) this.load(projectId);
    for (const [projectId, list] of this.lists) {
      const task = list.findLast((one) => one.letters.includes(letterId));
      if (task) return { projectId, task };
    }
    return undefined;
  }

  /** The worker's open task, if it has one: its newest. */
  openFor(projectId: string, worker: string): Task | undefined {
    return this.load(projectId).findLast((task) => task.worker === worker && isOpen(task));
  }

  /** A new task, queued. */
  create(
    projectId: string,
    fields: Omit<Task, "id" | "status" | "created" | "letters" | "title"> & { job: string; letter: string },
  ): Task {
    const list = this.load(projectId);
    const { job, letter, ...rest } = fields;
    const task: Task = {
      ...rest,
      id: (list.at(-1)?.id ?? 0) + 1,
      title: titleOf(job),
      status: "queued",
      letters: [letter],
      created: Date.now(),
    };
    list.push(task);
    if (list.length > MAX_KEPT) {
      // the oldest closed ones go; an open one stays however old
      const over = list.length - MAX_KEPT;
      let dropped = 0;
      for (let i = 0; i < list.length && dropped < over; ) {
        if (!isOpen(list[i]!)) {
          list.splice(i, 1);
          dropped++;
        } else i++;
      }
    }
    this.touch(projectId);
    return task;
  }

  /** A follow-up joins a task: it is open again, on the worker's turn. */
  join(projectId: string, task: Task, letter: string): void {
    if (!task.letters.includes(letter)) task.letters.push(letter);
    if (task.status === "blocked") task.status = "queued";
    this.touch(projectId);
  }

  /** The worker has started on it. */
  start(projectId: string, task: Task): void {
    task.status = "working";
    task.started ??= Date.now();
    delete task.ended;
    this.touch(projectId);
  }

  /** A turn on it ended, at this cost. */
  spent(projectId: string, task: Task, costUsd: number | undefined): void {
    task.turns = (task.turns ?? 0) + 1;
    if (costUsd && costUsd > 0) task.costUsd = Math.round(((task.costUsd ?? 0) + costUsd) * 10_000) / 10_000;
    this.touch(projectId);
  }

  /** The worker answered: done, blocked on a question, or failed. */
  end(projectId: string, task: Task, status: "done" | "blocked" | "failed", report: string): void {
    task.status = status;
    task.ended = Date.now();
    const said = report.trim();
    task.report = said.length > REPORT_MAX ? `${said.slice(0, REPORT_MAX)}\n[… cut]` : said;
    this.touch(projectId);
  }

  /** A worker's chat is gone: what it had open fails. */
  dropWorker(projectId: string, worker: string, why: string): void {
    for (const task of this.load(projectId)) {
      if (task.worker === worker && isOpen(task)) this.end(projectId, task, "failed", why);
    }
  }
}
