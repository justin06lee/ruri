/**
 * Agents talking to agents: a chat's model messaging another chat's — in
 * its own project or any other open one — and hearing back.
 *
 * A message arrives in the other chat as a prompt, marked as whose it is
 * (the user event's `from`), and queues behind whatever that chat is doing
 * like any prompt the user sends. What the sender gets back is that chat's
 * last word at the end of the turn the message started: in the tool call's
 * answer when it waits for it, as a message in its own chat when it asked
 * for the answer later, or not at all.
 *
 * The user decides who may message whom (the talk page, TalkPolicy): one
 * rule for every agent, a project's for the chats in it, a chat's own for
 * it. ruri holds every message to that rule, and outside bypass mode it
 * asks the user before each one goes, on a card in the sender's chat —
 * the same card the model's other asks come on.
 *
 * This file is the part that needs no server: the rules, the handles the
 * agents address each other by, the words each side reads, the book of
 * messages in flight, and the tools. server/handlers/talk.ts runs it.
 */
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type {
  LetterFrom,
  TalkLetter,
  TalkPolicy,
  TalkReply,
  TalkRule,
  TalkStatus,
} from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/** The tool names, auto-allowed: ruri asks the user itself, per message. */
export const TALK_TOOLS = ["mcp__ruri__list_agents", "mcp__ruri__message_agent"];

/** How long a sender waits on an answer before it is sent to its chat
 *  instead — a turn can run for hours, and a tool call that long is a
 *  turn nobody can see the end of. */
export const WAIT_MS = 20 * 60_000;

/** How many agents deep an exchange may go since the user last spoke: A
 *  asks B, B asks C… Each hop is a turn someone is paying for, and two
 *  agents answering each other's answers would otherwise never stop. */
export const MAX_DEPTH = 6;

/** Messages kept for the talk page, newest first. */
const KEPT = 60;

/** How much of a message the talk page keeps. */
const EXCERPT = 280;

/** The most of an answer handed back in one piece. */
const MAX_ANSWER = 24_000;

/* ── who may message whom ─────────────────────────────────────────── */

export function openRule(): TalkRule {
  return { to: "anyone", projects: [], chats: [] };
}

/** Until the user says otherwise, any agent may message any other: every
 *  message still waits on the user outside bypass mode. */
export function defaultPolicy(): TalkPolicy {
  return { everyone: openRule(), projects: {}, chats: {} };
}

function parseRule(raw: unknown): TalkRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const to = data["to"];
  if (to !== "anyone" && to !== "listed" && to !== "nobody") return undefined;
  const ids = (value: unknown): string[] =>
    Array.isArray(value)
      ? [...new Set(value.filter((x): x is string => typeof x === "string" && x !== ""))]
      : [];
  return { to, projects: ids(data["projects"]), chats: ids(data["chats"]) };
}

function parseRules(raw: unknown): Record<string, TalkRule> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, TalkRule> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rule = parseRule(value);
    if (rule && key) out[key] = rule;
  }
  return out;
}

/** Whatever was stored, as a policy: anything unreadable is the default,
 *  and an unreadable rule is no rule (its chat falls back to the next). */
export function parsePolicy(raw: unknown): TalkPolicy {
  if (!raw || typeof raw !== "object") return defaultPolicy();
  const data = raw as Record<string, unknown>;
  return {
    everyone: parseRule(data["everyone"]) ?? openRule(),
    projects: parseRules(data["projects"]),
    chats: parseRules(data["chats"]),
  };
}

/** The rule a chat goes by, and whose rule it is. */
export function ruleFor(
  policy: TalkPolicy,
  chat: string,
  project: string,
): { rule: TalkRule; by: "chat" | "project" | "everyone" } {
  const own = policy.chats[chat];
  if (own) return { rule: own, by: "chat" };
  const shared = policy.projects[project];
  if (shared) return { rule: shared, by: "project" };
  return { rule: policy.everyone, by: "everyone" };
}

export interface Seat {
  chat: string;
  project: string;
}

/** Whether one chat may message another, by the user's rules. */
export function mayMessage(policy: TalkPolicy, from: Seat, to: Seat): boolean {
  if (from.chat === to.chat) return false;
  const { rule } = ruleFor(policy, from.chat, from.project);
  if (rule.to === "anyone") return true;
  if (rule.to === "nobody") return false;
  return rule.chats.includes(to.chat) || rule.projects.includes(to.project);
}

/* ── what each side reads ─────────────────────────────────────────── */

/** "ruri · Frontend UI" — or just the project, for a chat with no title. */
export function seatName(project: string, title: string): string {
  return title ? `${project} · ${title}` : `${project} (an untitled chat)`;
}

const REPLY_LINE: Record<TalkReply, string> = {
  wait: "It is waiting on your answer: when you finish this turn, your last message goes straight back to it, so end with what it needs.",
  later:
    "When you finish this turn, your last message goes back to it as its answer, so end with what it needs.",
  none: "It asked for no answer.",
};

/** A message from another agent, as the model it is for reads it. */
export function letterPrompt(from: LetterFrom, handle: string, text: string): string {
  const who = seatName(from.project, from.title);
  return [
    `<ruri:message from="${who}" agent="${handle}">`,
    text,
    "</ruri:message>",
    `This came from another agent working in ruri — ${who} — not from the user. ${REPLY_LINE[from.reply]} To message it yourself later, use message_agent with to "${handle}".`,
  ].join("\n");
}

/** An answer coming back to the chat that asked, for its model. */
export function answerPrompt(from: LetterFrom, handle: string, text: string): string {
  const who = seatName(from.project, from.title);
  return [
    `<ruri:answer from="${who}" agent="${handle}">`,
    text,
    "</ruri:answer>",
    `That is ${who}'s answer to the message you sent it.`,
  ].join("\n");
}

/** An answer handed back, cut down to what a tool result should carry. */
export function clipAnswer(text: string): string {
  return text.length <= MAX_ANSWER
    ? text
    : `${text.slice(0, MAX_ANSWER)}\n\n[… cut here: the rest is in that chat's own transcript]`;
}

/* ── the book of messages ─────────────────────────────────────────── */

/** A message sent and not yet answered. */
export interface Pending {
  id: string;
  from: string;
  to: string;
  reply: TalkReply;
  depth: number;
  /** The sender's tool call, while it waits on the answer. */
  resolve?: (text: string) => void;
  timer?: ReturnType<typeof setTimeout>;
}

function policyFile(): string {
  return configPath("talk.json");
}

/**
 * Who may message whom (kept on disk), the latest messages (kept for this
 * run only, for the talk page), the messages in flight, and the cards up
 * asking the user.
 */
export class TalkBook {
  private stored: TalkPolicy | null = null;
  private log: TalkLetter[] = [];
  readonly pending = new Map<string, Pending>();
  /** Cards up asking the user whether a message may go, by request id. */
  readonly asks = new Map<string, { from: string; answer: (allow: boolean) => void }>();
  /** Handles are made from the chat's id with this, so a handle names a
   *  chat without being its id — the id is what the HTTP endpoint takes
   *  as the right to speak *as* that chat (routes.ts). New every run. */
  private readonly salt = randomBytes(16).toString("hex");

  /** Told whenever the policy or the log changes. */
  onChange: () => void = () => {};

  policy(): TalkPolicy {
    if (this.stored) return this.stored;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(policyFile(), "utf8"));
    } catch (err) {
      if (!isMissing(err)) warn("talk", err, "load");
    }
    this.stored = parsePolicy(raw);
    return this.stored;
  }

  setPolicy(policy: TalkPolicy): void {
    this.stored = parsePolicy(policy);
    try {
      writeJsonAtomic(policyFile(), this.stored, 2);
    } catch (err) {
      warn("talk", err, "save");
    }
    this.onChange();
  }

  letters(): TalkLetter[] {
    return this.log;
  }

  /** A chat's handle: short, stable for this run, and not its id. */
  handleOf(chat: string): string {
    return createHash("sha256").update(`${this.salt}:${chat}`).digest("hex").slice(0, 8);
  }

  /** Write a message down — or move one along — for the talk page. */
  note(letter: Omit<TalkLetter, "text"> & { text?: string }): void {
    const at = this.log.findIndex((x) => x.id === letter.id);
    if (at === -1) {
      const text = letter.text ?? "";
      this.log.unshift({
        ...letter,
        text: text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text,
      });
      if (this.log.length > KEPT) this.log.length = KEPT;
    } else {
      const { text: _text, ...patch } = letter;
      this.log[at] = { ...this.log[at]!, ...patch };
    }
    this.onChange();
  }

  /** Move a message along, by id. */
  mark(id: string, status: TalkStatus, note?: string): void {
    const letter = this.log.find((x) => x.id === id);
    if (!letter) return;
    letter.status = status;
    if (note) letter.note = note;
    this.onChange();
  }

  /** Whether `from` is waiting — directly, or through the chats it waits
   *  on — on an answer from `to`. Waiting on a chat that is waiting on you
   *  is two tool calls holding each other's turns open for good. */
  waitsOn(from: string, to: string): boolean {
    const seen = new Set<string>();
    let at = from;
    for (;;) {
      if (seen.has(at)) return false;
      seen.add(at);
      const next = [...this.pending.values()].find((p) => p.from === at && p.resolve)?.to;
      if (!next) return false;
      if (next === to) return true;
      at = next;
    }
  }
}

/* ── the tools ────────────────────────────────────────────────────── */

export interface TalkHost {
  /** Who this chat may message, in words. */
  list(channelId: string): string;
  /** Send one message; resolves with what the model should read back. */
  send(channelId: string, args: { to: string; message: string; reply?: TalkReply }): Promise<string>;
}

const REPLY_DOC =
  '"wait" (the default) holds this call until that chat has finished the turn your message starts, and answers with its last message. "later" returns at once, and its answer comes to this chat as a message of its own when it is ready — keep working meanwhile. "none" asks for no answer.';

/** The talk tools, for the `ruri` MCP server a Claude chat gets. */
export function talkTools(host: TalkHost, channelId: string) {
  return [
    tool(
      "list_agents",
      "List the other agents open in ruri that you may message — the chats in this project and in every other open project — with each one's handle, what it is working on, and whether it is busy. The user decides who you may message.",
      {},
      async () => ({ content: [{ type: "text", text: host.list(channelId) }] }),
    ),
    tool(
      "message_agent",
      "Send a message to another agent open in ruri — a chat in this project or in another one — and hear back. It arrives in that chat as a prompt marked as yours, and waits behind whatever it is doing. Use it to ask what another agent knows or has done, to hand it something to do in its project, or to tell it something it needs. Outside bypass mode the user is asked first, on a card.",
      {
        to: z.string().describe("The agent's handle from list_agents (or its project and chat name)"),
        message: z
          .string()
          .describe(
            "What to say. It reads this cold: say who you are working for and what you need, and include anything it cannot know.",
          ),
        reply: z.enum(["wait", "later", "none"]).optional().describe(REPLY_DOC),
      },
      async (args) => ({
        content: [
          {
            type: "text",
            text: await host.send(channelId, {
              to: args.to,
              message: args.message,
              ...(args.reply ? { reply: args.reply } : {}),
            }),
          },
        ],
      }),
    ),
  ];
}

/** What a Claude chat is told about the tools. */
export function talkToolBriefing(): string {
  return [
    "<ruri:talk>",
    "Other agents are working in ruri too — other chats in this project and in the user's other open projects — and you can talk to them. mcp__ruri__list_agents shows who you may message; mcp__ruri__message_agent sends one a message and brings back its answer.",
    "Reach for it when another agent holds what you need — how its side of an API works, what it just changed, a job that belongs in its project — rather than guessing or doing its work for it. A message arriving from another agent shows up as <ruri:message>: answer it by ending your turn with what it needs.",
    "</ruri:talk>",
  ].join("\n");
}

/** The same thing over HTTP, for every other harness. */
export function talkHttpBriefing(endpoint: string): string {
  return [
    "<ruri:talk>",
    "Other agents are working in ruri too — other chats in this project and in the user's other open projects — and you can talk to them. POST JSON to " +
      endpoint +
      ':  {"do": "list"} shows who you may message, each with a handle; {"do": "send", "to": "<handle>", "message": "...", "reply": "later"} sends one a message. It answers {"ok": true, "text": "..."}.',
    `  curl -s -X POST ${endpoint} -H 'content-type: application/json' -d '{"do":"list"}'`,
    `"reply": "later" (the default here) returns at once and its answer comes to this chat as a message when it is ready; "none" asks for no answer; "wait" holds the request until the answer — up to twenty minutes, so give the command that long. Outside bypass mode the user is asked before each message goes.`,
    "A message arriving from another agent shows up as <ruri:message>: answer it by ending your turn with what it needs. Keep the endpoint to yourself.",
    "</ruri:talk>",
  ].join("\n");
}
