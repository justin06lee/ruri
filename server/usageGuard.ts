import * as fs from "node:fs";
import type { LetterFrom, Project, TalkDelivery, UsageGuard } from "../shared/protocol.js";
import { configPath } from "./configDir.js";
import type { ServerContext } from "./context.js";
import { warn } from "./log.js";

/**
 * The usage guard (docs/token-efficiency.md, "The new design"): the plan's
 * weekly % across everything, as the usage gauges read it, steps agent
 * work down as it climbs —
 *
 * - past the first step (60%) every project chat on Opus or Fable runs on
 *   the worker model instead (Sonnet), and no task gets Opus;
 * - past the second (70%) projects ranked low pause: unstarred ones not
 *   named in "ruri-guard-keep". Their running turns finish; a message
 *   from another agent into one of their chats waits here, parked, and
 *   goes in once the guard lets go;
 * - past the third (80%) every project's agent work waits the same way.
 *
 * Only agents' messages wait: what the user types still goes. Each step
 * lifts by itself as the % falls — the weekly reset — and "off" in the
 * "ruri-usage-guard" preference lifts all three at once. No reading, or
 * one older than FRESH_FOR_MS, is no step at all: the guard never stops
 * work on a number it does not have.
 */

/** Where the steps are, by default: "ruri-usage-steps" moves them. */
export const GUARD_STEPS: readonly [number, number, number] = [60, 70, 80];

/** A reading older than this says nothing about now. */
export const FRESH_FOR_MS = 3 * 60 * 60 * 1000;

/** What a chat steps down to, unless "ruri-worker-model" says otherwise. */
export const STEP_DOWN_MODEL = "sonnet";

/** 0 below the first step, then 1, 2, 3. */
export type GuardLevel = 0 | 1 | 2 | 3;

function prefs(ctx: ServerContext): Record<string, string> {
  return ctx.prefs?.all?.() ?? {};
}

/** The plan's weekly %, when there is a fresh reading of it. */
export function weeklyPercent(ctx: ServerContext, now = Date.now()): number | undefined {
  const claude = ctx.usage?.limits?.["claude"];
  if (typeof claude?.weekly !== "number") return undefined;
  if (claude.at !== undefined && now - claude.at > FRESH_FOR_MS) return undefined;
  return claude.weekly;
}

/** The three steps: "ruri-usage-steps" ("60,70,80"), when it names three
 *  rising percentages. */
export function guardSteps(ctx: ServerContext): readonly [number, number, number] {
  const said = (prefs(ctx)["ruri-usage-steps"] ?? "")
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);
  const [a, b, c] = said;
  return said.length === 3 && said.every((n) => Number.isFinite(n) && n > 0 && n <= 100) && a! <= b! && b! <= c!
    ? [a!, b!, c!]
    : GUARD_STEPS;
}

/** Whether the user has turned the guard off. */
export function guardOff(ctx: ServerContext): boolean {
  return (prefs(ctx)["ruri-usage-guard"] ?? "").trim().toLowerCase() === "off";
}

/** How far up the steps the week is now. */
export function guardLevel(ctx: ServerContext, now = Date.now()): GuardLevel {
  if (guardOff(ctx)) return 0;
  const weekly = weeklyPercent(ctx, now);
  if (weekly === undefined) return 0;
  const [one, two, three] = guardSteps(ctx);
  return weekly >= three ? 3 : weekly >= two ? 2 : weekly >= one ? 1 : 0;
}

/** Projects that go on working past the second step: the starred, and
 *  those "ruri-guard-keep" names (by name, comma-separated). */
export function keepsGoing(ctx: ServerContext, project: Project): boolean {
  if (project.starred) return true;
  const kept = (prefs(ctx)["ruri-guard-keep"] ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return kept.includes(project.name.toLowerCase());
}

/** Whether a project's agents wait now. */
export function projectPaused(ctx: ServerContext, project: Project, level = guardLevel(ctx)): boolean {
  return level >= 3 || (level === 2 && !keepsGoing(ctx, project));
}

/** Why another agent's message into this chat waits now, in the words
 *  its sender reads — or nothing, when it goes. */
export function guardHolds(ctx: ServerContext, chat: string): string | undefined {
  const level = guardLevel(ctx);
  if (level < 2) return undefined;
  const project = ctx.store.findSession(chat)?.project;
  if (!project || !projectPaused(ctx, project, level)) return undefined;
  const weekly = weeklyPercent(ctx);
  const [, two, three] = guardSteps(ctx);
  return level >= 3
    ? `the week's Claude usage is at ${weekly}%, past ${three}%: all agent work waits until it falls`
    : `the week's Claude usage is at ${weekly}%, past ${two}%: ${project.name} is paused, as only starred projects' agents work now`;
}

/** Whether a model is one the first step takes down: Claude's Opus or
 *  Fable, not another harness's. */
function premium(model: string): boolean {
  return !model.includes(":") && /opus|fable/i.test(model);
}

/** The model a project chat runs on, the guard considered: past the first
 *  step, Opus and Fable step down to the worker model. */
export function guardedModel(ctx: ServerContext, model: string | undefined): string | undefined {
  if (guardLevel(ctx) < 1) return model;
  const effective = model || ctx.store.defaultModel();
  if (!premium(effective)) return model;
  return prefs(ctx)["ruri-worker-model"]?.trim() || STEP_DOWN_MODEL;
}

/** Every step the guard takes, and the user turning it off or on, in
 *  ~/.config/ruri/guard.log: one line each, with the time. */
export function guardLog(line: string): void {
  try {
    fs.appendFileSync(configPath("guard.log"), `${new Date().toISOString()} ${line}\n`);
  } catch (err) {
    warn("guard", err, "guardLog");
  }
}

/* ── messages waiting on the guard ────────────────────────────────── */

/** A message held back from a paused chat: delivered as it was, later. */
export interface Parked {
  chat: string;
  text: string;
  from: LetterFrom;
  delivery: TalkDelivery;
  ts: number;
}

interface GuardMemory {
  level: GuardLevel;
  parked: Parked[];
  timer?: NodeJS.Timeout;
}

const memories = new WeakMap<ServerContext, GuardMemory>();

function memoryOf(ctx: ServerContext): GuardMemory {
  let memory = memories.get(ctx);
  if (!memory) memories.set(ctx, (memory = { level: 0, parked: [] }));
  return memory;
}

/** A message into a paused chat waits here. */
export function park(ctx: ServerContext, entry: Omit<Parked, "ts">): void {
  const memory = memoryOf(ctx);
  // a message delivered again after a relaunch is the same one
  if (memory.parked.some((one) => one.from.letter === entry.from.letter && !one.from.answer === !entry.from.answer))
    return;
  memory.parked.push({ ...entry, ts: Date.now() });
}

/** How many messages wait for a chat. */
export function parkedFor(ctx: ServerContext, chat: string): number {
  return memoryOf(ctx).parked.filter((one) => one.chat === chat).length;
}

/** A chat closing takes what waited for it. */
export function unpark(ctx: ServerContext, chats: ReadonlySet<string>): void {
  const memory = memoryOf(ctx);
  memory.parked = memory.parked.filter((one) => !chats.has(one.chat));
}

/** The guard as the windows show it. */
export function guardState(ctx: ServerContext): UsageGuard {
  const level = guardLevel(ctx);
  const weekly = weeklyPercent(ctx);
  return {
    level,
    steps: [...guardSteps(ctx)],
    ...(weekly !== undefined ? { weekly } : {}),
    ...(guardOff(ctx) ? { off: true } : {}),
    paused: ctx.store
      .list()
      .filter((project) => projectPaused(ctx, project, level))
      .map((project) => project.id),
    waiting: memoryOf(ctx).parked.length,
  };
}

/** What happens when the level moves — wired by the server. */
export interface GuardHooks {
  /** A parked message goes again (it may park once more). */
  deliver(parked: Parked): void;
  /** The level moved: from, to. */
  moved?(from: GuardLevel, to: GuardLevel): void;
}

/**
 * One look at the week: when the level has moved, every live session is
 * put on the model it should now run on (between its turns), the windows
 * hear, and — the level falling, or a project starred — what waited goes.
 * Answers whether anything changed.
 */
export function guardTick(ctx: ServerContext, hooks: GuardHooks): boolean {
  const memory = memoryOf(ctx);
  const level = guardLevel(ctx);
  const was = memory.level;
  memory.level = level;
  if (level !== was) {
    hooks.moved?.(was, level);
    // the first step moves models both ways; a session between turns
    // takes the change now, one at work once its turn ends
    if ((was >= 1) !== (level >= 1)) {
      for (const chat of ctx.store.sessionIds()) {
        if (!ctx.manager.live(chat)) continue;
        const model = ctx.store.effectiveSettings(chat)?.model;
        const now = guardedModel(ctx, model) ?? model;
        if (now) ctx.manager.setModel(chat, now);
      }
    }
  }
  // what waited goes once its project works again
  const ready = memory.parked.filter((one) => !guardHolds(ctx, one.chat));
  if (ready.length) {
    memory.parked = memory.parked.filter((one) => !ready.includes(one));
    for (const one of ready) hooks.deliver(one);
  }
  const changed = level !== was || ready.length > 0;
  if (changed) ctx.clients.broadcast({ type: "guard", guard: guardState(ctx) });
  return changed;
}

/** How often the guard looks, besides after every turn. */
export const GUARD_EVERY_MS = 60_000;

/** The guard's own clock, until the server closes. */
export function startGuard(ctx: ServerContext, hooks: GuardHooks): void {
  const memory = memoryOf(ctx);
  if (memory.timer) return;
  memory.level = guardLevel(ctx);
  memory.timer = setInterval(() => guardTick(ctx, hooks), GUARD_EVERY_MS);
  memory.timer.unref?.();
}

export function stopGuard(ctx: ServerContext): void {
  const memory = memoryOf(ctx);
  if (memory.timer) clearInterval(memory.timer);
  delete memory.timer;
}
