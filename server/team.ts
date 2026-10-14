/**
 * A project as a team: one lead the user talks to, a liaison other
 * projects' agents talk to, and the members both hand work to.
 *
 * The sidebar used to fill with chats — one per thing the user was doing
 * in a project, each a conversation of its own to find and keep track of.
 * Now a project shows one chat, its lead (always its first session, marked
 * `lead`), and every other chat is a member of its team: a conversation
 * with a duty — one layer of the project's stack, as a rule — that keeps
 * what it learns from one job to the next. Members are not in the
 * sidebar. The lead messages them (server/talk.ts, the same letters every
 * agent sends), they message each other, and the lead looks after them:
 * adds one, widens a duty, stops, compacts, refreshes, restarts or retires
 * one.
 *
 * The lead delegates: every task goes to a teammate, and the lead talks
 * with the user, chooses who does each job, hands it over and relays the
 * answer — free for the user most of the time. A teammate is made the
 * first time a job for its layer comes up, never all at once.
 *
 * The liaison is a second lead, out of the user's sight (marked `liaison`
 * on its session): what an agent from another project reaches when it
 * writes here, made the first time one does. It delegates the way the lead
 * does, to the same team, but has no user: it answers the agent that
 * asked.
 *
 * A member asleep costs nothing. Its process closes a moment after its
 * turn ends, as any chat nobody has open does (server/sessions.ts), and a
 * message wakes it on the session it left, with its whole conversation.
 * Every member may work at once. Only the user's RURI_TEAM_MAX, when set,
 * caps how many: a message to one beyond it waits in its line, and goes
 * the moment one at work finishes — and a member holding on an answer from
 * another is not counted, or two waiting on each other's teammates would
 * hold every slot for good.
 *
 * This file is the part that needs no server: the cap, the words the
 * leads and the members read, and the leads' tools. server/handlers/team.ts
 * runs it.
 */
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TeamAction } from "../shared/protocol.js";

/** The leads' tools, auto-allowed: they act on the project's own team. */
export const TEAM_TOOLS = [
  "mcp__ruri__team",
  "mcp__ruri__add_teammate",
  "mcp__ruri__update_teammate",
  "mcp__ruri__manage_teammate",
  "mcp__ruri__retire_teammate",
];

/**
 * What a lead or a liaison may not do in a Claude chat: write files, or
 * start agents of its own. It delegates — the work is its teammates'.
 * Reading, searching and the shell stay, for looking; and every MCP tool
 * stays, ruri's own included.
 */
export const LEAD_DISALLOWED = ["Edit", "Write", "NotebookEdit", "Task", "Agent"];

/** The built-in tools a project's Claude chat may not use, by its place on
 *  the team: a lead delegates; a member, and the liaison, have no user to
 *  ask — nobody would ever see the card. Other harnesses are told, in their
 *  words, but not held to it. */
export function disallowedFor(role: Head | "member"): string[] {
  if (role === "lead") return LEAD_DISALLOWED;
  return role === "liaison" ? [...LEAD_DISALLOWED, "AskUserQuestion"] : ["AskUserQuestion"];
}

/** The most members at work at once across ruri: none unless the user
 *  sets RURI_TEAM_MAX. */
export function teamCap(): number | undefined {
  const set = Number(process.env["RURI_TEAM_MAX"]);
  return Number.isFinite(set) && set >= 1 ? Math.floor(set) : undefined;
}

/** The cap, and the members waiting on a slot under it, oldest first. */
export class TeamGovernor {
  readonly cap: number | undefined;
  /** Members with something waiting on a free slot, oldest first. */
  readonly waiting: string[] = [];
  /** Members a slot has just been handed to, and when: they hold it before
   *  their turn has said it started, which is a microtask away. */
  readonly starting = new Map<string, number>();
  /** The next look at the members waiting, while any are. */
  recheck: NodeJS.Timeout | undefined;

  constructor(opts: { cap?: number | undefined } = {}) {
    this.cap = "cap" in opts ? opts.cap : teamCap();
  }

  wait(chat: string): void {
    if (!this.waiting.includes(chat)) this.waiting.push(chat);
  }

  unwait(chat: string): void {
    const at = this.waiting.indexOf(chat);
    if (at !== -1) this.waiting.splice(at, 1);
  }
}

/* ── what the leads and the members read ─────────────────────────── */

/** Which of a project's two leads a chat is: the user's, or the one other
 *  projects' agents reach. */
export type Head = "lead" | "liaison";

/**
 * What a lead — or the liaison — is told about its team and its job. The
 * same words every time — the roster changes, the system prompt must not,
 * or the provider's cache goes with it — so the team itself is one call
 * away (mcp__ruri__team, or {"do": "team"}).
 */
export function leadBriefing(
  project: string,
  via: "tool" | "http",
  endpoint = "",
  head: Head = "lead",
): string {
  const call = (tool: string, body: string) => (via === "tool" ? `mcp__ruri__${tool}` : `{"do": ${body}}`);
  const liaison = head === "liaison";
  return [
    "<ruri:team>",
    liaison
      ? `You are the liaison of ${project}: the lead that agents from other projects reach. They write to you, as messages, with jobs and questions for this project. The user never sees this chat and you have no user to ask: the user talks to the project's lead, another chat. You don't do the work yourself — you delegate every task, and your job is choosing who does it: hand it over, follow it up, and answer the agent that asked.`
      : `You are the lead of ${project}: the one agent the user talks to. You don't do the work yourself — you delegate every task, and your job is choosing who does it: talk with the user, decide whose job each thing is, hand it over, follow it up, and relay the answer. Every task goes to a teammate — features, fixes, investigation, reviews, even reading code to answer a question — so you stay free for the user.`,
    `The team: one teammate per layer of the project's stack (the layers in this prompt; \`ruri architecture\`), each a chat of its own with that layer as its duty, its own conversation, and what it has learned from every job it has done. A teammate is made the first time a job for its layer comes up — never all at once — and sleeps between jobs at no cost.${
      liaison ? " It is the lead's team too: you share it." : ""
    }`,
    ...(via === "http"
      ? [
          `You run the team over the same endpoint you message agents on (${endpoint}), with these extra calls:`,
          '  {"do": "team"} — the roster',
          '  {"do": "add", "layer": "<handle>", "message": "<the job>"} — a teammate for a layer, with its first job (or "name" and "duty" instead of "layer")',
          '  {"do": "update", "who": "<handle or name>", "name": "...", "duty": "...", "layers": [...]}',
          '  {"do": "manage", "who": "<handle or name>", "action": "stop" | "compact" | "refresh" | "restart"}',
          '  {"do": "retire", "who": "<handle or name>"}',
        ]
      : []),
    "- Read only what you need to choose whom: the catch-up, `ruri architecture`, `ruri layer <handle>`, and the roster. Never open the project's files or run its code to answer something yourself — not even a one-line read: that is a teammate's job. You can't edit files or start agents of your own here.",
    `- Hand a job over with ${call("message_agent", '"send"')} (to: the teammate's handle, its name, or its layer's handle) — it comes back "later", always, for you: the call returns at once and the answer comes to this chat as a message when the job is done. Then end your turn${
      liaison ? "" : " with a line to the user on who has it"
    }. Write the job so it reads cold: what is wanted and why, anything said that matters, and what to report back.`,
    `- No teammate for that layer yet: ${call("add_teammate", '"add"')} with layer "<handle>" — it takes its name and duty from the layer — and the job as its message, in the same call. A project with no stack: give it a name and a duty for a part of the project, never a single task.`,
    "- A job across layers goes to the teammate of its main layer, which messages the others itself. Separate jobs go out together, each to its own teammate: every teammate may work at once.",
    liaison
      ? "- Answer the agent that asked: when the answers you are waiting on have landed here, your last words in the turn the last one starts go back to it — so end that turn with what it needs. Until then, end each turn short; it keeps waiting. Only a question about the team or the stack itself, which the roster or the sheets answer, is yours to answer at once; anything in the project's files or code goes to a teammate."
      : "- When an answer lands, relay what the user needs in your own words: what was done, what was found, what is left. If it falls short, hand it back saying what to change.",
    liaison
      ? "- You have no user. When a job needs a decision, don't guess and don't look for the user: answer the asking agent with the question — it has a user to ask. Don't hand outside jobs to the lead: it is the user's."
      : "- Teammates can't reach the user: you are their voice. When one needs a decision, ask the user, and hand the answer back.",
    `- Run the team. ${call("team", '"team"')} shows each teammate's state, duty, layers, how full its context is and what it last said, which layers have no teammate yet, and what the ${
      liaison ? "lead" : "liaison"
    } has going. ${call("message_agent", '"send"')} with delivery "queue" waits behind what a teammate is doing; the default, "interrupt", stops its turn so it reads yours now. ${call(
      "manage_teammate",
      '"manage"',
    )}: "stop" ends the turn it is on and sends nothing new; "compact" condenses its conversation into a brief it goes on from (teammates also compact themselves as their context fills); "refresh" puts a fresh session in its place for the same name, duty and layers — for one gone wrong, or carrying too much; "restart" closes a stuck process and keeps the conversation. ${call(
      "update_teammate",
      '"update"',
    )} widens or narrows a duty; ${call("retire_teammate", '"retire"')} removes a teammate for good.`,
    liaison
      ? "- Teammates message each other directly, and can ask you about a job you handed them."
      : "- Teammates message each other directly, and can ask you. Agents from other projects never reach you: they write to this project's liaison, a second lead out of the user's sight that hands their jobs to the same team.",
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
    "The user doesn't see this chat. Work comes to you as messages — from the project's lead, which the user talks to; from its liaison, which takes jobs from other projects' agents; or from a teammate. Do the job, then end your turn with a short report — what you did, what you found, anything left open: that report is your answer, and the only part of your turn the sender reads.",
    "Never ask the user anything — they can't see you. If you're stuck, say so in your report, or ask whoever handed you the job, or a teammate, with message_agent.",
    "Other teammates own other parts of the project, one layer each: when a job reaches into another's layer, message the teammate who owns it (list_agents shows the team and each one's duty) rather than guessing or working there yourself — and if no one holds that layer yet, ask whoever handed you the job to add one. Stay in your own part unless you're handed more.",
    "Between jobs you sleep: your process closes, and your conversation is kept for the next message.",
    "</ruri:team>",
  ].join("\n");
}

/* ── the leads' tools ─────────────────────────────────────────────── */

/** What a teammate's session can be told to do, from the tools: stop the
 *  turn it is on, compact, refresh ("clear", its old name), restart. */
export type ManageAction = Exclude<TeamAction, "retire">;

/** A new teammate: for a layer of the stack, or by name and duty. */
export interface AddArgs {
  /** A layer's handle: the teammate's name and duty come from the layer. */
  layer?: string;
  name?: string;
  duty?: string;
  layers?: string[];
  model?: string;
  message?: string;
  /** A lead's hand-offs come back "later" ("wait" is taken as that). */
  reply?: "wait" | "later" | "none";
}

/** What the leads' tools do, with the server behind them. `headId` is the
 *  lead or the liaison calling. */
export interface TeamHost {
  /** The roster, in words. */
  roster(headId: string): string;
  add(
    headId: string,
    args: AddArgs,
    /** How a first message's answer is waited on: the tool call's own
     *  cancellation, or an HTTP call's (and its harness's shorter slice). */
    wait?: { signal?: AbortSignal; via?: "tool" | "http"; waitMs?: number },
  ): Promise<string>;
  update(headId: string, args: { who: string; name?: string; duty?: string; layers?: string[] }): string;
  manage(headId: string, who: string, action: ManageAction): string;
  retire(headId: string, who: string): string;
}

function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

const text = (said: string) => ({ content: [{ type: "text" as const, text: said }] });

const WHO = z
  .string()
  .describe("The teammate's handle (from team or list_agents), its name, or its layer's handle");

/** The leads' tools, for the `ruri` MCP server a lead's or liaison's Claude
 *  chat gets. */
export function teamTools(host: TeamHost, headId: string) {
  return [
    tool(
      "team",
      "Your team: each teammate's handle, name, duty and layers, its state right now (asleep — no process, costs nothing; working; waiting on an answer; waiting on the user), how full its context is, when it last worked and the start of what it last said — the stack's layers that have no teammate yet — and what the project's other lead (the lead, or the liaison other projects' agents reach) has going.",
      {},
      async () => text(host.roster(headId)),
    ),
    tool(
      "add_teammate",
      "Add a teammate: a persistent chat in this project, out of the user's sight, that sleeps between jobs and keeps its conversation. As a rule one per layer of the stack, made the first time a job for that layer comes up: give the layer's handle and it takes its name and duty from the layer. A project with no stack: a name and a duty. With a message it starts on that job at once, and its answer comes here as a message when the job is done.",
      {
        layer: z
          .string()
          .optional()
          .describe(
            "The handle of the layer it owns (from the stack, `ruri architecture`): its name and duty come from the layer",
          ),
        name: z
          .string()
          .optional()
          .describe('Without a layer: what to call it, by what it looks after — "UI", "Linux port"'),
        duty: z
          .string()
          .optional()
          .describe(
            "Without a layer: what it owns and does, in a sentence or two — it reads this as its standing brief, so say where its part of the project is",
          ),
        layers: z
          .array(z.string())
          .optional()
          .describe("More layers' handles it owns besides `layer`, when one teammate should hold several"),
        model: z.string().optional().describe("A model for it, by name or id; the project's own by default"),
        message: z.string().optional().describe("Its first job — the one it is being added for"),
        reply: z
          .enum(["later", "none"])
          .optional()
          .describe(
            'With a message: "later" (the default) has the answer come here as a message when the job is done; "none" wants nothing back',
          ),
      },
      async (args, extra) =>
        text(
          await host.add(
            headId,
            {
              ...(args.layer ? { layer: args.layer } : {}),
              ...(args.name ? { name: args.name } : {}),
              ...(args.duty ? { duty: args.duty } : {}),
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
      "Change a teammate's name, duty or layers — to widen a duty, or narrow one that has sprawled. Its next session reads the new ones.",
      {
        who: WHO,
        name: z.string().optional(),
        duty: z.string().optional(),
        layers: z.array(z.string()).optional().describe("The whole new list; [] clears it"),
      },
      async (args) =>
        text(
          host.update(headId, {
            who: args.who,
            ...(args.name ? { name: args.name } : {}),
            ...(args.duty ? { duty: args.duty } : {}),
            ...(args.layers ? { layers: args.layers } : {}),
          }),
        ),
    ),
    tool(
      "manage_teammate",
      'Act on a teammate\'s session. "stop": end the turn it is on, sending nothing new — a message it was answering is told so; anything waiting in its line goes on after. "compact": condense its conversation into a brief and go on from that in a fresh session — at once when it is asleep, the moment its turn ends when it is at work. "refresh": a fresh session in its place with the same name, duty and layers and nothing else — for one gone wrong, or carrying too much; it gets a new handle, and messages waiting for it move to the new one. ("clear" is the old name for refresh.) "restart": close its process, stopping a turn it is stuck in; the conversation is kept, and the next message resumes it. To queue a message behind its work or interrupt it, use message_agent\'s delivery.',
      { who: WHO, action: z.enum(["stop", "compact", "refresh", "restart", "clear"]) },
      async (args) => text(host.manage(headId, args.who, args.action)),
    ),
    tool(
      "retire_teammate",
      "Remove a teammate for good: its process, its conversation and its place on the team. What it learned that matters is already in the project's memory.",
      { who: WHO },
      async (args) => text(host.retire(headId, args.who)),
    ),
  ];
}
