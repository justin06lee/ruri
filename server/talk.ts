/**
 * Agents talking to agents: a chat's model messaging another chat's — in
 * its own project or any other open one — and hearing back.
 *
 * A message arrives in the other chat as a prompt, marked as whose it is
 * (the user event's `from`), and queues behind whatever that chat is doing
 * like any prompt the user sends. What the sender gets back is that chat's
 * last word at the end of the turn the message started — and it always
 * gets it back, unless it said it wanted nothing ("none": do the work, no
 * one is waiting). Waiting ("wait", the default) holds the sender's call
 * until the answer comes; asking for it "later" lets the sender carry on,
 * and the answer comes to its chat as a message of its own.
 *
 * A wait is held in slices, each shorter than the harness lets one call
 * block: Claude's tool call for minutes, a shell command's curl for as
 * long as that harness's command timeout allows (HTTP_WAIT_MS). A slice
 * that ends with no answer says so and hands the model the letter's id,
 * and wait_for_answer (or {"do": "wait"}) picks the wait up again. However
 * a wait ends — its slice, the harness cutting the call, the user stopping
 * the turn, the sender's turn ending, ruri quitting — an answer that finds
 * no call holding for it goes to the sender's chat as a message instead,
 * where a wait that comes back for it still collects it. Nothing is
 * dropped: the letters in flight are kept on disk (talk-letters.json), and
 * a relaunch sends on what never went and reports what never finished.
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
export const TALK_TOOLS = [
  "mcp__ruri__list_agents",
  "mcp__ruri__message_agent",
  "mcp__ruri__wait_for_answer",
];

/**
 * How long one of Claude's tool calls holds a wait before it hands back to
 * the model with "not yet" and the letter's id. The Claude CLI itself would
 * hold an in-process MCP call for a day (MCP_TOOL_TIMEOUT, 1e8 ms, and no
 * timeout on the SDK's side), but a turn can run for hours, and a call
 * that long is a turn nobody can see the end of: every ten minutes the
 * model gets to decide whether to keep waiting.
 */
export const WAIT_MS = 10 * 60_000;

/**
 * How long one HTTP call waits, by harness — each under what that harness
 * lets a shell command block before it cuts it off or hands back to the
 * model without its output, measured against the real CLIs:
 *   - Codex's exec_command returns after 30 seconds at most, whatever
 *     yield time the model asks for; the command goes on in the
 *     background, but the model sees an empty output;
 *   - OpenCode's bash tool kills a command at two minutes unless the model
 *     sets a longer timeout;
 *   - Gemini's shell kills one that has printed nothing for five minutes.
 * Anything else gets Codex's, the shortest. A cut-off call loses nothing —
 * the answer then goes to the chat — but the model reads it as a failure,
 * so the slice stays well inside the limit.
 */
const HTTP_WAIT_MS: Record<string, number> = { codex: 20_000, opencode: 90_000, gemini: 240_000 };
const HTTP_WAIT_DEFAULT_MS = 20_000;

/** How long one HTTP call waits on an answer, for a chat on this harness. */
export function httpWaitMs(harness: string | undefined): number {
  return (harness && HTTP_WAIT_MS[harness]) || HTTP_WAIT_DEFAULT_MS;
}

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
    "It is carrying on with its own work meanwhile: when you finish this turn, your last message goes back to it as its answer, so end with what it needs.",
  none: "It asked for no answer: nobody is waiting on you, and nothing you say goes back to it — just do what it asks.",
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

/** What a call waiting on an answer is handed back: the words, and
 *  whether they are the answer (or how the message ended instead) rather
 *  than "not yet". */
export interface WaitOutcome {
  text: string;
  answered: boolean;
}

/** How a message ended, once the turn it started is over. */
export interface Ending {
  outcome: "answered" | "failed" | "dropped";
  /** The answer itself, or what happened instead. */
  text: string;
}

/** A message sent and not yet answered — or answered, and not yet in the
 *  sender's hands. */
export interface Pending {
  id: string;
  from: string;
  to: string;
  reply: TalkReply;
  depth: number;
  /** The message, whole: a relaunch sends it again if it never went. */
  text: string;
  ts: number;
  /** The sending chat's project and title, as the other chat is told
   *  them — kept for a relaunch to tell them again. */
  sender?: { project: string; title: string };
  /** Where it has got to in the other chat: waiting in its line, or the
   *  turn it started running. */
  stage: "queued" | "working";
  /** The sender's turn that sent it is over (or ruri has been relaunched
   *  since): nothing of it is waiting any more, so the answer goes to its
   *  chat as a message — and it no longer counts as waiting (waitsOn). */
  released?: boolean;
  /** How it ended, once it has: on its way to the sender's chat as a
   *  message, in its line there, where a wait coming back for it still
   *  collects it. */
  ending?: Ending;
  /** The calls holding for the answer right now — Claude's tool call, a
   *  curl. Never kept on disk: no call outlives the process. */
  waiters: Set<(outcome: WaitOutcome) => void>;
}

/** What of a letter in flight is kept on disk. */
type KeptLetter = Omit<Pending, "waiters">;

function policyFile(): string {
  return configPath("talk.json");
}

function lettersFile(): string {
  return configPath("talk-letters.json");
}

const REPLIES = new Set<unknown>(["wait", "later", "none"]);
const OUTCOMES = new Set<unknown>(["answered", "failed", "dropped"]);

/** A letter as it was kept, or nothing when it cannot be read back. */
function parseLetter(raw: unknown): KeptLetter | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const d = raw as Record<string, unknown>;
  const str = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : undefined);
  const id = str("id");
  const from = str("from");
  const to = str("to");
  if (!id || !from || !to || !REPLIES.has(d["reply"])) return undefined;
  const ending = d["ending"] as Record<string, unknown> | undefined;
  const sender = d["sender"] as Record<string, unknown> | undefined;
  return {
    id,
    from,
    to,
    reply: d["reply"] as TalkReply,
    depth: typeof d["depth"] === "number" ? d["depth"] : 1,
    text: str("text") ?? "",
    ts: typeof d["ts"] === "number" ? d["ts"] : Date.now(),
    ...(typeof sender?.["project"] === "string" && typeof sender["title"] === "string"
      ? { sender: { project: sender["project"], title: sender["title"] } }
      : {}),
    stage: d["stage"] === "working" ? "working" : "queued",
    ...(d["released"] === true ? { released: true } : {}),
    ...(ending && OUTCOMES.has(ending["outcome"]) && typeof ending["text"] === "string"
      ? { ending: { outcome: ending["outcome"] as Ending["outcome"], text: ending["text"] } }
      : {}),
  };
}

/** How many settled letters are remembered, for a wait that comes late. */
const REMEMBERED = 200;

/**
 * Who may message whom (kept on disk), the latest messages (kept for this
 * run only, for the talk page), the messages in flight (kept on disk, so a
 * relaunch loses none), and the cards up asking the user.
 */
export class TalkBook {
  private stored: TalkPolicy | null = null;
  private log: TalkLetter[] = [];
  readonly pending = new Map<string, Pending>();
  /** Letters no longer in flight, and where their answer went — so a wait
   *  that comes back for one after it has been handed over is told where. */
  private readonly settled = new Map<string, string>();
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
   *  is two turns holding each other open for good. A chat counts as
   *  waiting from the moment it sends with "wait" until the answer lands
   *  or its turn ends — not only while a call is actually held, since one
   *  polling in slices is between calls most of the time. */
  waitsOn(from: string, to: string): boolean {
    const waiting = (p: Pending) => p.waiters.size > 0 || (p.reply === "wait" && !p.released && !p.ending);
    const seen = new Set<string>();
    let at = from;
    for (;;) {
      if (seen.has(at)) return false;
      seen.add(at);
      const next = [...this.pending.values()].find((p) => p.from === at && waiting(p))?.to;
      if (!next) return false;
      if (next === to) return true;
      at = next;
    }
  }

  /* the letters in flight, kept on disk */

  /** A letter goes into the book (or changed in it). */
  keep(letter: Pending): void {
    this.pending.set(letter.id, letter);
    this.saveLetters();
  }

  /** A letter is done with: its answer is in the sender's hands (`where`
   *  says how, for a wait that comes back for it), or nobody wants it. */
  forget(id: string, where: string): void {
    this.pending.delete(id);
    this.settled.set(id, where);
    if (this.settled.size > REMEMBERED) this.settled.delete(this.settled.keys().next().value!);
    this.saveLetters();
  }

  /** Where a letter no longer in flight went, if it was one. */
  whereIs(id: string): string | undefined {
    return this.settled.get(id);
  }

  /** A letter's prompt has gone into a chat: the other chat has started on
   *  a message, or an answer has reached the chat that asked — which is
   *  that letter in the sender's hands. */
  arrived(from: LetterFrom): void {
    if (from.answer) {
      if (this.pending.has(from.letter))
        this.forget(
          from.letter,
          "That message has been answered, and its answer has already come to this chat as a message.",
        );
      return;
    }
    this.mark(from.letter, "working");
    const letter = this.pending.get(from.letter);
    if (letter && letter.stage !== "working") {
      letter.stage = "working";
      this.saveLetters();
    }
  }

  saveLetters(): void {
    const letters: KeptLetter[] = [...this.pending.values()].map(({ waiters: _waiters, ...kept }) => kept);
    try {
      writeJsonAtomic(lettersFile(), { letters }, 2);
    } catch (err) {
      warn("talk", err, "save letters");
    }
  }

  /** The letters left in flight when ruri last stopped, back in the book:
   *  every one released, since whatever turn was waiting on it went with
   *  the process. The caller decides what becomes of each (restoreTalk). */
  loadLetters(): Pending[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(lettersFile(), "utf8"));
    } catch (err) {
      if (!isMissing(err)) warn("talk", err, "load letters");
      return [];
    }
    const list = (raw as { letters?: unknown } | null)?.letters;
    const letters = (Array.isArray(list) ? list : [])
      .map(parseLetter)
      .filter((letter): letter is KeptLetter => letter !== undefined)
      .map((letter): Pending => ({ ...letter, released: true, waiters: new Set() }));
    for (const letter of letters) this.pending.set(letter.id, letter);
    return letters;
  }
}

/* ── the tools ────────────────────────────────────────────────────── */

export interface TalkHost {
  /** Who this chat may message, in words. */
  list(channelId: string): string;
  /** Send one message; resolves with what the model should read back.
   *  `signal` is the tool call being cancelled (the turn stopped): a wait
   *  it was holding lets go, and the answer goes to the chat instead. */
  send(
    channelId: string,
    args: { to: string; message: string; reply?: TalkReply },
    signal?: AbortSignal,
  ): Promise<string>;
  /** Wait on the answer to a message this chat sent, by its letter id. */
  wait(channelId: string, letter: string, signal?: AbortSignal): Promise<string>;
}

/** The cancellation an MCP tool call's handler is handed, if any. */
function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

const REPLY_DOC =
  'What you get back. By default ("wait") this call waits until that agent has finished the turn your message starts, and returns its answer — its last message. If that takes long, the call returns first with a letter id: call wait_for_answer with it to keep waiting. "later": return at once and keep working; the answer arrives in this chat as a message of its own when it is ready. "none": only when you want the other agent to just do the work in the background and need nothing back — it is told nobody is waiting, and nothing comes back. Unless you say "none", the answer always comes back: if a wait is cut short, stopped or given up, it arrives in this chat as a message instead.';

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
      'Send a message to another agent open in ruri — a chat in this project or in another one — and get its answer back. It arrives in that chat as a prompt marked as yours, and waits behind whatever it is doing. Use it to ask what another agent knows or has done, to hand it something to do in its project, or to tell it something it needs. By default you wait for the answer; say reply "none" only when the other agent should just do the work in the background and you need nothing back. Outside bypass mode the user is asked first, on a card.',
      {
        to: z.string().describe("The agent's handle from list_agents (or its project and chat name)"),
        message: z
          .string()
          .describe(
            "What to say. It reads this cold: say who you are working for and what you need, and include anything it cannot know.",
          ),
        reply: z.enum(["wait", "later", "none"]).optional().describe(REPLY_DOC),
      },
      async (args, extra) => ({
        content: [
          {
            type: "text",
            text: await host.send(
              channelId,
              {
                to: args.to,
                message: args.message,
                ...(args.reply ? { reply: args.reply } : {}),
              },
              signalOf(extra),
            ),
          },
        ],
      }),
    ),
    tool(
      "wait_for_answer",
      'Keep waiting on the answer to a message you sent with message_agent, by the letter id it gave you — when a wait returned before the answer came, or you sent it with reply "later" and now need it. Returns the answer as soon as it comes, or after ten minutes says it is not in yet: call this again to keep waiting, or carry on — the answer then comes to this chat as a message when it is ready.',
      { letter: z.string().describe("The letter id message_agent gave you") },
      async (args, extra) => ({
        content: [{ type: "text", text: await host.wait(channelId, args.letter, signalOf(extra)) }],
      }),
    ),
  ];
}

/** What a Claude chat is told about the tools. */
export function talkToolBriefing(): string {
  return [
    "<ruri:talk>",
    "Other agents are working in ruri too — other chats in this project and in the user's other open projects — and you can talk to them. mcp__ruri__list_agents shows who you may message; mcp__ruri__message_agent sends one a message and brings back its answer.",
    'The answer comes back unless you ask for none: by default message_agent waits for it (a long job returns first with a letter id — mcp__ruri__wait_for_answer keeps waiting); reply "later" keeps you working and brings the answer to this chat as a message; reply "none" is only for work the other agent should just get on with in the background, with nothing sent back.',
    "For the chats in ruri use these tools, not ListAgents or SendMessage: those reach Claude sessions on this machine behind ruri's back — a message waits on another user's approval there, and no answer comes back through ruri.",
    "Reach for it when another agent holds what you need — how its side of an API works, what it just changed, a job that belongs in its project — rather than guessing or doing its work for it. A message arriving from another agent shows up as <ruri:message>: answer it by ending your turn with what it needs.",
    "</ruri:talk>",
  ].join("\n");
}

/** The same thing over HTTP, for every other harness. `waitMs` is how
 *  long one call waits on this chat's harness (httpWaitMs). */
export function talkHttpBriefing(endpoint: string, waitMs = HTTP_WAIT_DEFAULT_MS): string {
  const slice = Math.round(waitMs / 1000);
  const allow = slice + 10;
  const call = (body: string) =>
    `  curl -s -X POST ${endpoint} -H 'content-type: application/json' -d '${body}'`;
  return [
    "<ruri:talk>",
    `Other agents are working in ruri too — other chats in this project and in the user's other open projects — and you can talk to them, by POSTing JSON to ${endpoint}. Each call answers {"ok": true, "text": "...", ...}; read "text".`,
    '  {"do": "list"} — who you may message, each with a handle',
    '  {"do": "send", "to": "<handle>", "message": "...", "reply": "wait"} — send one a message',
    '  {"do": "wait", "letter": "<id>"} — keep waiting on the answer to a message you sent',
    call('{"do":"list"}'),
    `"reply" is what you get back. "wait" (the default) waits for the answer — the other agent's last message when it has finished the turn your message starts. One call waits at most ${slice} seconds: if the answer is not in by then it returns "answered": false with the message's "letter" id, and you run {"do": "wait", "letter": "<id>"} — again and again, as long as it takes — to keep waiting. Let every call run ${allow} seconds before your shell gives up on it (set the command's timeout, or yield time, to at least ${allow * 1000} ms), and read what it prints.`,
    `"later": the call returns at once and you keep working; the answer arrives in this chat as a message when it is ready. "none": only when you want the other agent to just do the work in the background and need nothing back — it is told nobody is waiting, and nothing comes back.`,
    'Unless you say "none", the answer always comes back: if a wait times out, is cut short or you stop waiting, it arrives in this chat as a message instead. Outside bypass mode the user is asked before each message goes.',
    "A message arriving from another agent shows up as <ruri:message>: answer it by ending your turn with what it needs. Keep the endpoint to yourself.",
    "</ruri:talk>",
  ].join("\n");
}
