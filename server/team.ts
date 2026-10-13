/**
 * A project as a team: one lead the user talks to, and the members it
 * hands work to.
 *
 * The sidebar used to fill with chats — one per thing the user was doing
 * in a project, each a conversation of its own to find and keep track of.
 * Now a project shows one chat, its lead (always its first session, marked
 * `lead`), and every other chat is a member of its team: a conversation
 * with a duty — a part of the project, usually some of its layers — that
 * keeps what it learns from one job to the next. Members are not in the
 * sidebar. The lead messages them (server/talk.ts, the same letters every
 * agent sends), they message each other, and the lead looks after them:
 * adds one, widens a duty, compacts, restarts, clears or retires one.
 *
 * A member asleep costs nothing. Its process closes a moment after its
 * turn ends, as any chat nobody has open does (server/sessions.ts), and a
 * message wakes it on the session it left, with its whole conversation.
 * What a member costs is the process while it works — a few hundred MB of
 * harness and its MCP servers — so how many may work at once follows the
 * memory the machine has free. A message to one beyond that waits in its
 * line, and goes the moment one at work finishes. Nothing is lost; it
 * only waits. A member holding on an answer from another is not counted:
 * its harness is parked in a tool call, and counting it would let two
 * members waiting on each other's teammates hold every slot for good.
 *
 * This file is the part that needs no server: the machine's memory, the
 * budget, the words the lead and its members read, and the lead's tools.
 * server/handlers/team.ts runs it.
 */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TeamAction } from "../shared/protocol.js";

/** The lead's tools, auto-allowed: they act on the lead's own team. */
export const TEAM_TOOLS = [
  "mcp__ruri__team",
  "mcp__ruri__add_teammate",
  "mcp__ruri__update_teammate",
  "mcp__ruri__reset_teammate",
  "mcp__ruri__retire_teammate",
];

/** What one agent at work is taken to cost before any has been measured:
 *  `claude` idles at about 200 MB and works at 300–400 with its MCP
 *  servers; Codex's app-server is lighter, ACP agents about the same. */
export const AGENT_BYTES = 350 * 1024 ** 2;

/** Memory always left to the user's own apps: this much at least, or this
 *  share of the machine, whichever is more. */
const RESERVE_MIN = 2 * 1024 ** 3;
const RESERVE_SHARE = 0.12;

/** How long a reading of the machine's memory stands. */
const FRESH_MS = 5_000;

/** The most members at work at once, whatever the memory: one per two
 *  cores, between two and six — or the user's RURI_TEAM_MAX. */
export function teamCap(cores = os.cpus().length): number {
  const set = Number(process.env["RURI_TEAM_MAX"]);
  if (Number.isFinite(set) && set >= 1) return Math.floor(set);
  return Math.max(2, Math.min(6, Math.floor(cores / 2)));
}

/**
 * How many members may be at work at once: the ones at work now (their
 * memory is already spent, so already out of `available`), and as many
 * more as fit in what is free above the reserve — never more than `cap`,
 * and never none, so a team on a machine short of memory still moves, one
 * member at a time.
 */
export function slotsFor(input: {
  availableBytes: number;
  totalBytes: number;
  perAgentBytes: number;
  atWork: number;
  cap: number;
}): number {
  const reserve = Math.max(RESERVE_MIN, input.totalBytes * RESERVE_SHARE);
  const fit = Math.max(0, Math.floor((input.availableBytes - reserve) / Math.max(1, input.perAgentBytes)));
  return Math.max(1, Math.min(input.cap, input.atWork + fit));
}

/**
 * What macOS could hand out now. Its own figure first: the kernel's
 * memory-free level (`kern.memorystatus_level`, a percentage — what
 * `memory_pressure` reports and Activity Monitor's pressure follows), which
 * counts what compression would win back. Failing that, `vm_stat`.
 * Never `os.freemem()`, which there is the free pages alone: on a Mac that
 * has been up an hour, a few hundred MB of a machine with gigabytes to give.
 */
export function parseLevel(text: string, totalBytes: number): number | undefined {
  const level = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(level) && level > 0 && level <= 100
    ? (level / 100) * totalBytes
    : undefined;
}

/** `vm_stat`'s free pages, and the ones macOS gives up the moment anyone
 *  asks — inactive, speculative, purgeable. */
export function parseVmStat(text: string): number | undefined {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!size) return undefined;
  const pages = (name: string): number => Number(new RegExp(`Pages ${name}:\\s+(\\d+)`).exec(text)?.[1] ?? 0);
  const total = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  return total > 0 ? total * size : undefined;
}

/** Linux says it itself: MemAvailable, in kB. */
export function parseMeminfo(text: string): number | undefined {
  const kb = Number(/^MemAvailable:\s+(\d+)\s*kB/m.exec(text)?.[1]);
  return kb > 0 ? kb * 1024 : undefined;
}

const LEVEL = ["-n", "kern.memorystatus_level"];
const QUICK = { encoding: "utf8" as const, timeout: 2_000 };

function readAvailableSync(): number {
  try {
    if (process.platform === "linux")
      return parseMeminfo(fs.readFileSync("/proc/meminfo", "utf8")) ?? os.freemem();
    if (process.platform === "darwin")
      return (
        parseLevel(execFileSync("sysctl", LEVEL, QUICK), os.totalmem()) ??
        parseVmStat(execFileSync("vm_stat", QUICK)) ??
        os.freemem()
      );
  } catch {
    // the system's own figure, low as it is on a Mac
  }
  return os.freemem();
}

/** A quick command's output, or nothing when it fails. */
function output(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, QUICK, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

async function readAvailable(): Promise<number> {
  if (process.platform === "linux") {
    return fs.promises
      .readFile("/proc/meminfo", "utf8")
      .then((text) => parseMeminfo(text) ?? os.freemem())
      .catch(() => os.freemem());
  }
  if (process.platform !== "darwin") return os.freemem();
  const level = await output("sysctl", LEVEL);
  const fromLevel = level === undefined ? undefined : parseLevel(level, os.totalmem());
  if (fromLevel !== undefined) return fromLevel;
  const vm = await output("vm_stat", []);
  return (vm === undefined ? undefined : parseVmStat(vm)) ?? os.freemem();
}

/**
 * The machine's memory as last read, renewed behind the reading when it is
 * older than FRESH_MS — the budget is asked as a message goes out, which
 * must not wait on `vm_stat`. And the members waiting on a slot, oldest
 * first.
 */
export class TeamGovernor {
  private available: number;
  private at = Date.now();
  private reading = false;
  readonly totalBytes: number;
  readonly cap: number;
  /** Members with something waiting on a free slot, oldest first. */
  readonly waiting: string[] = [];
  /** Members a slot has just been handed to, and when: they hold it before
   *  their turn has said it started, which is a microtask away. */
  readonly starting = new Map<string, number>();
  /** The next look at the members waiting, while any are. */
  recheck: NodeJS.Timeout | undefined;
  private readonly readLater: () => Promise<number>;

  constructor(
    machine: {
      /** The memory free now, read as ruri starts. */
      read?: () => number;
      /** And again, behind a reading gone stale. */
      readLater?: () => Promise<number>;
      totalBytes?: number;
      cap?: number;
    } = {},
  ) {
    this.available = (machine.read ?? readAvailableSync)();
    this.readLater = machine.readLater ?? readAvailable;
    this.totalBytes = machine.totalBytes ?? os.totalmem();
    this.cap = machine.cap ?? teamCap();
  }

  availableBytes(): number {
    if (Date.now() - this.at > FRESH_MS && !this.reading) {
      this.reading = true;
      void this.readLater()
        .then((bytes) => {
          this.available = bytes;
          this.at = Date.now();
        })
        .finally(() => {
          this.reading = false;
        });
    }
    return this.available;
  }

  wait(chat: string): void {
    if (!this.waiting.includes(chat)) this.waiting.push(chat);
  }

  unwait(chat: string): void {
    const at = this.waiting.indexOf(chat);
    if (at !== -1) this.waiting.splice(at, 1);
  }
}

/** "1.2 GB", "350 MB". */
export function bytes(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

/* ── what the lead and its members read ───────────────────────────── */

/**
 * What a lead is told about its team. The same words every time — the
 * roster changes, the system prompt must not, or the provider's cache
 * goes with it — so the team itself is one call away (mcp__ruri__team, or
 * {"do": "team"}).
 */
export function leadBriefing(project: string, via: "tool" | "http", endpoint = ""): string {
  const call = (tool: string, body: string) => (via === "tool" ? `mcp__ruri__${tool}` : `{"do": ${body}}`);
  return [
    "<ruri:team>",
    `You are the lead of ${project}: the one agent the user talks to here. ruri gives a project one chat — yours — and a team behind it that only you and they see. Each teammate is a chat of its own with a duty (a part of the project, usually some of its layers), its own conversation, and what it has learned from every job it has done.`,
    ...(via === "http"
      ? [
          `You manage the team over the same endpoint you message agents on (${endpoint}), with these extra calls:`,
          '  {"do": "team"} — the roster and the machine',
          '  {"do": "add", "name": "...", "duty": "...", "layers": ["<handle>"], "model": "<optional>", "message": "<optional first job>", "reply": "wait"}',
          '  {"do": "update", "who": "<handle or name>", "name": "...", "duty": "...", "layers": [...]}',
          '  {"do": "reset", "who": "<handle or name>", "how": "compact" | "restart" | "clear"}',
          '  {"do": "retire", "who": "<handle or name>"}',
        ]
      : []),
    `- Hand work to the teammate whose duty it is, with ${call("message_agent", '"send"')} (to: its handle or its name). It wakes for your message, does the job, and its last words come back to you as the answer; then it sleeps — its process closes and costs nothing, and its conversation is kept for the next job. Keep coordination, quick questions and small things for yourself; hand off real work, and hand parallel work to several teammates at once (reply "later" brings each answer here as it lands).`,
    `- ${call("team", '"team"')} shows the roster — each teammate's handle, duty, layers, state (asleep, working, waiting for a slot…), how full its context is and what it last said — and the machine: the memory free, and how many teammates may work at once.`,
    `- Add a teammate (${call("add_teammate", '"add"')}) only when no one's duty covers work that will come back. Prefer handing the job to whoever is closest, or widening a duty (${call("update_teammate", '"update"')}). Keep the team small: a handful, each with a clear part of the project — never one per task.`,
    "- Be easy on the machine. A teammate at work holds a harness process of a few hundred MB, so ruri lets only as many work at once as memory allows; a message beyond that waits in line and starts the moment one finishes — nothing is lost, it waits. Don't wake teammates for nothing, and don't fan one job out to many.",
    `- Look after their context: ${call("reset_teammate", '"reset"')} compacts one whose context is filling (ruri also compacts on its own past about 80%), restarts one whose process is stuck, or clears one whose conversation has gone wrong — a fresh start that keeps only its name and duty. ${call("retire_teammate", '"retire"')} removes one for good.`,
    "- Teammates message each other directly, and any of them can ask you. A teammate cannot reach the user; you are their voice. Tell the user what the team is doing in a line or two — they see only you.",
    "</ruri:team>",
  ].join("\n");
}

/** What a member is told about where it stands. Its name and duty change
 *  rarely; when they do, its next session reads the new ones. */
export function memberBriefing(input: {
  project: string;
  name: string;
  duty: string;
  layers?: string[];
}): string {
  return [
    "<ruri:team>",
    `You are ${input.name ? `"${input.name}"` : "a member"} on ${input.project}'s team. Your duty: ${input.duty}.${
      input.layers?.length
        ? ` Your layers: ${input.layers.join(", ")} — read their sheets (\`ruri layer <handle>\`) before you work there, and keep them true.`
        : ""
    }`,
    "The user doesn't see this chat. They talk to the project's lead, which hands you work as messages. Do the job, then end your turn with a short report — what you did, what you found, anything left open: that report is your answer, and the only part of your turn the lead reads.",
    "Never ask the user anything — they can't see you. If you're stuck, say so in your report, or ask the lead or a teammate with message_agent.",
    "Other teammates own other parts of the project: when you need what one holds — how its side works, a change in its part — message it rather than guessing, and stay in your own part unless the lead hands you more. list_agents shows the team and each one's duty.",
    "Be easy on the machine — every agent at work is a process of a few hundred MB on the user's computer: don't start agents of your own (the Task tool) unless the job truly splits, and never many at once.",
    "Between jobs you sleep: your process closes, and your conversation is kept for the next message.",
    "</ruri:team>",
  ].join("\n");
}

/* ── the lead's tools ─────────────────────────────────────────────── */

/** What the lead's tools do, with the server behind them. */
export interface TeamHost {
  /** The roster and the machine, in words. */
  roster(leadId: string): string;
  add(
    leadId: string,
    args: {
      name: string;
      duty: string;
      layers?: string[];
      model?: string;
      message?: string;
      reply?: "wait" | "later" | "none";
    },
    /** How a first message's answer is waited on: the tool call's own
     *  cancellation, or an HTTP call's (and its harness's shorter slice). */
    wait?: { signal?: AbortSignal; via?: "tool" | "http"; waitMs?: number },
  ): Promise<string>;
  update(leadId: string, args: { who: string; name?: string; duty?: string; layers?: string[] }): string;
  reset(leadId: string, who: string, how: Exclude<TeamAction, "retire">): string;
  retire(leadId: string, who: string): string;
}

function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

const text = (said: string) => ({ content: [{ type: "text" as const, text: said }] });

const WHO = z.string().describe("The teammate's handle (from team or list_agents) or its name");

/** The lead's tools, for the `ruri` MCP server its Claude chat gets. */
export function teamTools(host: TeamHost, leadId: string) {
  return [
    tool(
      "team",
      "Your team: each teammate's handle, name, duty and layers, its state right now (asleep — no process, costs nothing; working; waiting on an answer; queued for a free slot; waiting on the user), how full its context is, when it last worked and the start of what it last said — and the machine: memory free, what an agent at work costs, and how many teammates may work at once.",
      {},
      async () => text(host.roster(leadId)),
    ),
    tool(
      "add_teammate",
      "Add a teammate: a new persistent chat in this project with a name and a duty, out of the user's sight, that sleeps between jobs and keeps its conversation. Only when no one's duty covers work that will come back — prefer handing work to an existing teammate or widening its duty. With a message, it starts on that at once and answers the way message_agent does.",
      {
        name: z
          .string()
          .describe('What to call it, by what it looks after: "UI", "Linux port", "Compaction"'),
        duty: z
          .string()
          .describe(
            "What it owns and does, in a sentence or two — it reads this as its standing brief, so say where its part of the project is",
          ),
        layers: z
          .array(z.string())
          .optional()
          .describe(
            "Handles of the layers it owns, from the stack (ruri architecture), when the project has one",
          ),
        model: z.string().optional().describe("A model for it, by name or id; the project's own by default"),
        message: z.string().optional().describe("Its first job, if it has one now"),
        reply: z
          .enum(["wait", "later", "none"])
          .optional()
          .describe(
            'With a message: wait for the answer (default), "later" to have it come here as a message, or "none"',
          ),
      },
      async (args, extra) =>
        text(
          await host.add(
            leadId,
            {
              name: args.name,
              duty: args.duty,
              ...(args.layers ? { layers: args.layers } : {}),
              ...(args.model ? { model: args.model } : {}),
              ...(args.message ? { message: args.message } : {}),
              ...(args.reply ? { reply: args.reply } : {}),
            },
            { via: "tool", ...(signalOf(extra) ? { signal: signalOf(extra)! } : {}) },
          ),
        ),
    ),
    tool(
      "update_teammate",
      "Change a teammate's name, duty or layers — to widen a duty rather than add someone, or narrow one that has sprawled. Its next session reads the new ones.",
      {
        who: WHO,
        name: z.string().optional(),
        duty: z.string().optional(),
        layers: z.array(z.string()).optional().describe("The whole new list; [] clears it"),
      },
      async (args) =>
        text(
          host.update(leadId, {
            who: args.who,
            ...(args.name ? { name: args.name } : {}),
            ...(args.duty ? { duty: args.duty } : {}),
            ...(args.layers ? { layers: args.layers } : {}),
          }),
        ),
    ),
    tool(
      "reset_teammate",
      'Look after a teammate\'s session. "compact": condense its conversation into a brief and go on from that in a fresh session — for a context filling up (ruri also does this on its own past about 80%). "restart": close its process, stopping a turn it is stuck in; the conversation is kept and the next message resumes it. "clear": throw its conversation away and start it fresh, keeping only its name, duty and layers — for one that has gone wrong; it gets a new handle.',
      { who: WHO, how: z.enum(["compact", "restart", "clear"]) },
      async (args) => text(host.reset(leadId, args.who, args.how)),
    ),
    tool(
      "retire_teammate",
      "Remove a teammate for good: its process, its conversation and its place on the team. What it learned that matters is already in the project's memory.",
      { who: WHO },
      async (args) => text(host.retire(leadId, args.who)),
    ),
  ];
}
