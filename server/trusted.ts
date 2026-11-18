/**
 * Trusted agents: chats the user trusts to decide in their place.
 *
 * The user registers a project as trusted, in Settings; its own chat — the
 * one on their sidebar — is the trusted agent. Nothing else can register
 * one: no tool, no message, nothing a model can say. Being trusted means
 * three things:
 *
 *   - Its cards come to it. A card raised in a turn it prompted (its
 *     message started the turn, server/origin.ts) is handed to it rather
 *     than to the user; it answers with answer_card. A turn the user
 *     prompted asks the user, as ever.
 *   - It is who the others ask. Any chat calls ask_trusted with a question
 *     — may this agent use that password — and the trusted agent's answer
 *     comes back.
 *   - It has the run of ruri: it sees every card (list_cards) and may
 *     answer any, "always allow" included; reads any chat (read_chat);
 *     stops any turn (stop_chat); and messages any chat without the talk
 *     page's limits or the card that asks the user first.
 *
 * The user stays above it. A card asked of a trusted agent is still on
 * the user's screen, theirs to answer at any time; one the agent has not
 * answered within CARD_WAIT_MS becomes the user's outright, and they are
 * told of it then. Every card an agent answers is written into that chat's
 * transcript, so the user can see what was allowed in their name.
 *
 * This file is the part that needs no server: the list on disk, the words
 * each side reads, and the tools. server/handlers/trusted.ts runs it.
 */
import * as fs from "node:fs";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TrustedAgent } from "../shared/protocol.js";
import { writeJsonAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/** The tool every chat has, auto-allowed: the asking is ruri's to route. */
export const ASK_TRUSTED_TOOLS = ["mcp__ruri__ask_trusted"];

/** The tools only a trusted chat has, auto-allowed: each checks, when it
 *  is called, that the chat calling is still trusted. */
export const TRUSTED_TOOLS = [
  "mcp__ruri__list_cards",
  "mcp__ruri__answer_card",
  "mcp__ruri__read_chat",
  "mcp__ruri__stop_chat",
];

/** A wait the environment may shorten, for a test run. */
function waitFrom(name: string, fallback: number): number {
  const set = Number(process.env[name]);
  return Number.isFinite(set) && set > 0 ? set : fallback;
}

/** How long a card waits on a trusted agent before it becomes the user's
 *  (RURI_TRUSTED_WAIT_MS). */
export function cardWaitMs(): number {
  return waitFrom("RURI_TRUSTED_WAIT_MS", 3 * 60_000);
}

/** How long one ask_trusted call holds before it hands back "not yet" and
 *  the ask's id — as a wait on a message does (talk.ts WAIT_MS). */
export const ASK_WAIT_MS = 10 * 60_000;

/** The most trusted agents kept. */
const MOST = 50;

function file(): string {
  return configPath("trusted-agents.json");
}

/** Whatever was stored, as the list: anything unreadable is no one. */
export function parseTrusted(raw: unknown): TrustedAgent[] {
  const list = (raw as { agents?: unknown } | null)?.agents;
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: TrustedAgent[] = [];
  for (const one of list as unknown[]) {
    const data = (one ?? {}) as Record<string, unknown>;
    const project = data["project"];
    if (typeof project !== "string" || !project || seen.has(project)) continue;
    seen.add(project);
    out.push({ project, since: typeof data["since"] === "number" ? data["since"] : 0 });
  }
  return out.slice(0, MOST);
}

/** The agents the user trusts, kept on disk, in the order they are asked. */
export class TrustedBook {
  private stored: TrustedAgent[] | null = null;

  list(): TrustedAgent[] {
    if (this.stored) return this.stored;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file(), "utf8"));
    } catch (err) {
      if (!isMissing(err)) warn("trusted", err, "load");
    }
    this.stored = parseTrusted(raw);
    return this.stored;
  }

  has(project: string): boolean {
    return this.list().some((agent) => agent.project === project);
  }

  /** The list, whole, as the user set it: one already on it keeps the day
   *  it was registered. */
  set(projects: string[], now = Date.now()): TrustedAgent[] {
    const had = new Map(this.list().map((agent) => [agent.project, agent.since]));
    this.stored = parseTrusted({
      agents: projects.map((project) => ({ project, since: had.get(project) ?? now })),
    });
    try {
      writeJsonAtomic(file(), { agents: this.stored }, 2);
    } catch (err) {
      warn("trusted", err, "save");
    }
    return this.stored;
  }
}

/* ── what each side reads ─────────────────────────────────────────── */

/** "3 minutes", "45 seconds". */
export function spanWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? "" : "s"}`;
}

/** How a trusted agent is told to answer a card: by its tool, or — for a
 *  harness that holds none of ruri's tools — over its talk endpoint. */
export type Via = "tool" | "http";

/** One card as a trusted agent is told of it. */
export interface CardWords {
  id: string;
  /** The chat waiting at it, by name. */
  chat: string;
  kind: "permission" | "message" | "question";
  /** What it asks, in a line. */
  title: string;
  /** What it would do, in full. */
  detail?: string;
  /** A question card's questions, each with what may be picked. */
  questions?: Array<{ question: string; options: string[]; multi: boolean; other: boolean }>;
  /** Asked by a chat with ask_trusted, rather than raised by a tool call. */
  asked?: boolean;
}

function howToAnswer(card: CardWords, via: Via): string {
  if (card.kind === "question") {
    const shape = '"answers": [{"picked": ["<an option>"], "other": "<words of your own>"}]';
    return via === "tool"
      ? `Answer it with answer_card: card "${card.id}", and answers — one for each question, in order, each with picked (the options you choose, by their words) and, where you have more to say or none fits, other (your own words).`
      : `Answer it with {"do": "answer", "card": "${card.id}", ${shape}} — one answer for each question, in order.`;
  }
  return via === "tool"
    ? `Answer it with answer_card: card "${card.id}", allow true or false${card.kind === "permission" ? " (with always true, that chat stops asking about this)" : ""}.`
    : `Answer it with {"do": "answer", "card": "${card.id}", "allow": true} — or false${card.kind === "permission" ? '; "always": true stops that chat asking about this' : ""}.`;
}

/** What a card asks, as text. */
export function cardBody(card: CardWords): string {
  const lines = [card.title];
  if (card.detail) lines.push("", card.detail);
  for (const [i, q] of (card.questions ?? []).entries()) {
    lines.push("", `${card.questions!.length > 1 ? `${i + 1}. ` : ""}${q.question}`);
    if (q.options.length)
      lines.push(
        `   ${q.multi ? "Pick any of" : "Pick one of"}: ${q.options.map((o) => `"${o}"`).join(", ")}${q.other ? " — or say it in your own words" : ""}`,
      );
  }
  return lines.join("\n");
}

/**
 * A card handed to a trusted agent: what it asks, and how to answer it.
 * `mine`: it came up in a turn the agent itself prompted. `waitMs`: how
 * long the user leaves it with the agent before it becomes theirs.
 */
export function cardPrompt(card: CardWords, via: Via, waitMs: number, mine = true): string {
  const why = card.asked
    ? `${card.chat} is asking you, as the agent the user trusts to decide in their place.`
    : mine
      ? `${card.chat} is waiting at a card, in the turn your message started. The user trusts you to answer the cards of turns you prompt, in their place.`
      : `${card.chat} is waiting at a card.`;
  return [
    `<ruri:card chat="${card.chat}" card="${card.id}">`,
    cardBody(card),
    "</ruri:card>",
    `${why} ${howToAnswer(card, via)} Only that call reaches the card: saying your answer in words answers nothing. Decide as the user would: allow what the job plainly needs, refuse what it does not, and when you cannot tell, leave it — unanswered for ${spanWords(waitMs)}, or when your turn ends, it goes to the user instead.`,
  ].join("\n");
}

/** The same, handed to a call of the agent's that was waiting on an
 *  answer: it answers the card, then goes back to its wait. */
export function cardWhileWaiting(card: CardWords, via: Via, waitMs: number, letter: string): string {
  const again =
    via === "tool"
      ? `call wait_for_answer with letter "${letter}"`
      : `run {"do": "wait", "letter": "${letter}"}`;
  return `No answer yet — the chat you are waiting on needs you first.\n\n${cardPrompt(card, via, waitMs)}\n\nThen ${again} to go on waiting for its answer.`;
}

/* ── the tools ────────────────────────────────────────────────────── */

/** What a chat asks a trusted agent (ask_trusted, {"do": "trusted"}). */
export interface TrustedAsk {
  /** The question, whole: what is to be approved or decided, and why. */
  question?: string;
  /** What may be picked; "Approve" and "Deny" when none are given. */
  options?: string[];
  /** An ask already made, by its id: keep waiting on its answer. */
  ask?: string;
}

/** A trusted agent's answer to a card. */
export interface CardAnswer {
  card: string;
  allow?: boolean;
  always?: boolean;
  answers?: Array<{ picked?: string[]; other?: string }>;
  dismiss?: boolean;
}

export interface TrustedHost {
  /** Ask whoever the user trusts; resolves with what the model reads. */
  ask(channelId: string, args: TrustedAsk, signal?: AbortSignal): Promise<string>;
  /** Every card up, for a trusted chat. */
  cards(channelId: string): string;
  /** A trusted chat's answer to a card. */
  answer(channelId: string, args: CardAnswer): string;
  /** A chat's recent conversation, for a trusted chat. */
  read(channelId: string, args: { chat: string; last?: number }): string;
  /** A chat's running turn stopped, by a trusted chat. */
  stop(channelId: string, args: { chat: string }): string;
}

function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

const text = (said: string) => ({ content: [{ type: "text" as const, text: said }] });

/** The tools for the `ruri` MCP server a Claude chat gets: ask_trusted for
 *  every chat, and the rest for a chat the user trusts. */
export function trustedTools(host: TrustedHost, channelId: string, trusted: boolean) {
  const ask = tool(
    "ask_trusted",
    "Ask for an approval or a decision that is the user's to give — may an agent use a password, is this the right thing to delete, which of two ways — without stopping them for it: the question goes to the agent the user has registered to decide in their place, and its answer comes back here. If no agent is registered, or it does not answer in a few minutes or cannot tell, the user is asked instead, on a card in this chat, and their answer comes back the same way. Say everything it needs to decide: it knows nothing of what you are doing. Returns who answered and what they said; a long wait returns first with an ask id — call this again with that id to keep waiting.",
    {
      question: z
        .string()
        .optional()
        .describe(
          "What you need approved or decided, and why — whole: who is asking, for what, with what consequence",
        ),
      options: z
        .array(z.string().min(1).max(200))
        .max(8)
        .optional()
        .describe('What may be picked. Leave out for a yes or no: it is "Approve" or "Deny".'),
      ask: z
        .string()
        .optional()
        .describe("An ask id this tool gave you earlier, to keep waiting on its answer"),
    },
    async (args, extra) =>
      text(
        await host.ask(
          channelId,
          {
            ...(args.question ? { question: args.question } : {}),
            ...(args.options?.length ? { options: args.options } : {}),
            ...(args.ask ? { ask: args.ask } : {}),
          },
          signalOf(extra),
        ),
      ),
  );
  if (!trusted) return [ask];
  return [
    ask,
    tool(
      "list_cards",
      "Every card up in ruri right now — a chat waiting on an allow or a deny, on a question, or on leave to send a message — with its id, the chat it is in, what it asks, how long it has waited, and whether it was handed to you or is waiting on the user. The user trusts you to answer them: use answer_card.",
      {},
      async () => text(host.cards(channelId)),
    ),
    tool(
      "answer_card",
      "Answer a card in the user's place, as the agent they trust: allow or refuse a tool call or a message (always true also stops that chat asking about the same thing again), or answer a question. What you answer is written into that chat's transcript, where the user reads it. A card of a turn you prompted is yours to answer; any other card you may answer too, but it is waiting on the user — answer it only when you know what they would say.",
      {
        card: z.string().describe("The card's id, from the message that handed it to you or from list_cards"),
        allow: z.boolean().optional().describe("For an allow-or-deny card: true to allow, false to refuse"),
        always: z
          .boolean()
          .optional()
          .describe("With allow true on a tool's card: stop asking about this in that chat"),
        answers: z
          .array(
            z.object({
              picked: z.array(z.string()).optional().describe("The options chosen, by their words"),
              other: z
                .string()
                .optional()
                .describe("Words of your own: a reason, or an answer no option fits"),
            }),
          )
          .optional()
          .describe("For a question card: one answer for each question, in order"),
        dismiss: z.boolean().optional().describe("For a question card: wave it away unanswered"),
      },
      async (args) =>
        text(
          host.answer(channelId, {
            card: args.card,
            ...(args.allow !== undefined ? { allow: args.allow } : {}),
            ...(args.always ? { always: true } : {}),
            ...(args.answers
              ? {
                  answers: args.answers.map((a) => ({
                    ...(a.picked ? { picked: a.picked } : {}),
                    ...(a.other ? { other: a.other } : {}),
                  })),
                }
              : {}),
            ...(args.dismiss ? { dismiss: true } : {}),
          }),
        ),
    ),
    tool(
      "read_chat",
      "Read a chat's recent conversation — any project's, as the user sees it: their prompts, other agents' messages, the replies in full, the tool calls between them folded into a line of steps — and what it is doing right now.",
      {
        chat: z.string().describe("The project's name, or the chat's handle from list_agents"),
        last: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many of the latest things said (20 if left out)"),
      },
      async (args) =>
        text(host.read(channelId, { chat: args.chat, ...(args.last ? { last: args.last } : {}) })),
    ),
    tool(
      "stop_chat",
      "Stop the turn a chat is running, as the user's Stop button does: what it was doing ends there, its queue stands by, and it is told that you stopped it, not the user. A message it was answering hears it was stopped.",
      { chat: z.string().describe("The project's name, or the chat's handle from list_agents") },
      async (args) => text(host.stop(channelId, { chat: args.chat })),
    ),
  ];
}

/** What a trusted Claude chat is told, once, of what being trusted means. */
export function trustedBriefing(): string {
  return [
    "<ruri:trusted>",
    "The user has registered this chat as an agent they trust to decide in their place in ruri. Three things follow.",
    "Cards come to you. When a turn you started — a message of yours to another chat — stops at a card (leave to run a tool, to send a message, a question), ruri hands you the card instead of the user: it arrives as <ruri:card>, in a call of yours waiting on that chat or as a message here. Answer it with mcp__ruri__answer_card. Other chats ask you outright too, with ask_trusted: those arrive the same way.",
    "You have the run of ruri: mcp__ruri__list_cards shows every card up, and you may answer any; mcp__ruri__read_chat reads any chat; mcp__ruri__stop_chat stops a turn; and your messages to other chats go without the user being asked first.",
    "Decide as the user would, and no further: allow what a job plainly needs, refuse what it does not, and leave alone what you cannot tell — a card you leave goes to the user after a few minutes, which is the right end for a doubtful one. Everything you answer is written where they read it.",
    "</ruri:trusted>",
  ].join("\n");
}

/** The same over HTTP, for every other harness: ask_trusted for every
 *  chat told of the endpoint, the rest for a trusted one. */
export function trustedHttpBriefing(endpoint: string, trusted: boolean): string {
  const lines = [
    "<ruri:trusted>",
    `For an approval or a decision that is the user's to give, ask the agent they trust to decide in their place, on the same endpoint (${endpoint}):`,
    '  {"do": "trusted", "question": "<what you need approved or decided, and why — whole>", "options": ["Approve", "Deny"]} — its answer comes back in "text"; with no such agent, or none answering in a few minutes, the user is asked instead, on a card in this chat',
    '  a call that returns "answered": false gives an "ask" id: run {"do": "trusted", "ask": "<id>"} to keep waiting',
  ];
  if (trusted)
    lines.push(
      "The user has registered this chat as that agent. Cards of the turns you start in other chats come to you, as <ruri:card>, and you have the run of ruri:",
      '  {"do": "cards"} — every card up, each with its id',
      '  {"do": "answer", "card": "<id>", "allow": true, "always": false} — allow or refuse one; for a question, "answers": [{"picked": ["<option>"], "other": "<your own words>"}], one for each question',
      '  {"do": "read", "chat": "<project name or handle>", "last": 20} — a chat\'s recent conversation',
      '  {"do": "stop", "chat": "<project name or handle>"} — stop the turn it is running',
      "Decide as the user would, and no further: a card you leave unanswered goes to them after a few minutes. Everything you answer is written where they read it.",
    );
  lines.push("</ruri:trusted>");
  return lines.join("\n");
}
