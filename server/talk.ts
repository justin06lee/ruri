/**
 * Agents talking to agents: a chat's model messaging another's — a
 * teammate in its own project, or another project, through its liaison —
 * and hearing back.
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
 * The user decides which projects may reach which (the talk page,
 * TalkPolicy): one rule for every project, which a project's own
 * overrides; a team talking within its project is that project's own
 * business. ruri holds every message to that rule, and outside bypass mode it
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
  TalkDelivery,
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
  "mcp__ruri__ask_project",
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
  return { to: "anyone", projects: [] };
}

/** Until the user says otherwise, any project may reach any other: every
 *  message still waits on the user outside bypass mode. */
export function defaultPolicy(): TalkPolicy {
  return { everyone: openRule(), projects: {} };
}

/** A project's id for a chat's — for the old per-chat rules' lists. */
type ProjectOf = (chat: string) => string | undefined;

function parseRule(raw: unknown, projectOf?: ProjectOf): TalkRule | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  const to = data["to"];
  if (to !== "anyone" && to !== "listed" && to !== "nobody") return undefined;
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((x): x is string => typeof x === "string" && x !== "") : [];
  // a chat a rule from before teams named is its project now: the outside
  // reaches a project through its lead
  const chats = projectOf ? ids(data["chats"]).flatMap((chat) => projectOf(chat) ?? []) : [];
  return { to, projects: [...new Set([...ids(data["projects"]), ...chats])] };
}

function parseRules(raw: unknown, projectOf?: ProjectOf): Record<string, TalkRule> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, TalkRule> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const rule = parseRule(value, projectOf);
    if (rule && key) out[key] = rule;
  }
  return out;
}

/** Whatever was stored, as a policy: anything unreadable is the default,
 *  and an unreadable rule is no rule (its project falls back to everyone's).
 *  A chat's own rule, from before a project was one chat for the user, is
 *  let go: a project's rule speaks for its whole team. */
export function parsePolicy(raw: unknown, projectOf?: ProjectOf): TalkPolicy {
  if (!raw || typeof raw !== "object") return defaultPolicy();
  const data = raw as Record<string, unknown>;
  return {
    everyone: parseRule(data["everyone"], projectOf) ?? openRule(),
    projects: parseRules(data["projects"], projectOf),
  };
}

/** The rule a project goes by, and whose rule it is. */
export function ruleFor(policy: TalkPolicy, project: string): { rule: TalkRule; by: "project" | "everyone" } {
  const own = policy.projects[project];
  return own ? { rule: own, by: "project" } : { rule: policy.everyone, by: "everyone" };
}

export interface Seat {
  chat: string;
  project: string;
}

/** Whether one chat may message another, by the user's rules. A team
 *  talking within its own project always may; the rules are for reaching
 *  other projects. */
export function mayMessage(policy: TalkPolicy, from: Seat, to: Seat): boolean {
  if (from.chat === to.chat) return false;
  if (from.project === to.project) return true;
  const { rule } = ruleFor(policy, from.project);
  if (rule.to === "anyone") return true;
  if (rule.to === "nobody") return false;
  return rule.projects.includes(to.project);
}

/* ── what each side reads ─────────────────────────────────────────── */

/** "ruri · Frontend UI" — or just the project, for a chat with no title. */
export function seatName(project: string, title: string): string {
  return title ? `${project} · ${title}` : `${project} (an untitled chat)`;
}

/** What a lead or a liaison — which hands its jobs on — is told a sender
 *  waiting on it gets back. */
const HEAD_REPLY_LINE =
  'It is waiting on your answer. When you can answer at once, end this turn with what it needs. When you hand the job on (reply "later"), just end your turn: it keeps waiting, and your last words in the turn the last answer you are waiting on starts go back to it.';

const REPLY_LINE: Record<TalkReply, string> = {
  wait: "It is waiting on your answer: when you finish this turn, your last message goes straight back to it, so end with what it needs.",
  later:
    "It is carrying on with its own work meanwhile: when you finish this turn, your last message goes back to it as its answer, so end with what it needs.",
  none: "It asked for no answer: nobody is waiting on you, and nothing you say goes back to it — just do what it asks.",
};

/** A message from another agent, as the model it is for reads it. `head`:
 *  the model is a lead or a liaison, which hands jobs on. */
export function letterPrompt(from: LetterFrom, handle: string, text: string, head = false): string {
  const who = seatName(from.project, from.title);
  const reply = head && from.reply !== "none" ? HEAD_REPLY_LINE : REPLY_LINE[from.reply];
  return [
    `<ruri:message from="${who}" agent="${handle}">`,
    text,
    "</ruri:message>",
    `This came from another agent working in ruri — ${who} — not from the user. ${reply} To message it yourself later, use message_agent with to "${handle}".`,
    ...(from.cutIn ? [CUT_IN_LINE] : []),
  ].join("\n");
}

/** ruri's own prompt carrying a chat on with a message after it compacted
 *  itself in the middle of the job (LetterFrom.carried). */
export function carriedPrompt(from: LetterFrom, handle: string, text: string): string {
  const who = seatName(from.project, from.title);
  return [
    text,
    "",
    `(You are still on the message from ${who} (agent "${handle}") — the job you were doing when you compacted. ${
      from.reply === "none"
        ? REPLY_LINE.none
        : "When it is done, your last words in that turn go back to it as your answer, so end with what it needs."
    })`,
  ].join("\n");
}

/** What a model interrupted by a message or an answer is told: the turn it
 *  was running was stopped for this, and it will be sent back to it. This
 *  turn is the message's alone — for one wanting an answer, its last words
 *  are the answer — so the work waits for the prompt that follows
 *  (resumePrompt). */
const CUT_IN_LINE =
  "It interrupted you: ruri stopped the turn you were running so you would read this now — the user did not, and a tool call of yours that shows as rejected or interrupted was not refused. Deal with this and only this now — you will be sent back to what you were doing straight after, so don't pick that up again in this turn.";

/**
 * ruri's own prompt after a message cut in: back to the work it stopped.
 * `running` is the tool call the stop cut off, as the transcript shows it
 * ("Bash: for i in …") — named, because the harness hands the model that
 * call back as "rejected", which a model reads as the user saying no and
 * leaves alone unless it is told otherwise.
 */
export function resumePrompt(who: string, running?: string): string {
  const cut = running
    ? ` When you were stopped you were running ${running.length > 200 ? `${running.slice(0, 199)}…` : running} — start that again first.`
    : "";
  return `↩ Back to what you were doing: ${who}'s message interrupted you, and you've dealt with it. Carry on exactly where you left off — whatever the user asked of you before still stands. It was ruri that stopped you, not the user: a tool call that came back rejected or interrupted was not refused, so run it again.${cut}`;
}

/** An answer coming back to the chat that asked, for its model. `owed`:
 *  the message the chat sent this one on behalf of, still waiting on it —
 *  who sent that, and whether other answers for it are still to come. */
export function answerPrompt(
  from: LetterFrom,
  handle: string,
  text: string,
  owed?: { who: string; more: boolean },
): string {
  const who = seatName(from.project, from.title);
  return [
    `<ruri:answer from="${who}" agent="${handle}">`,
    text,
    "</ruri:answer>",
    `That is ${who}'s answer to the message you sent it.`,
    ...(owed
      ? [
          owed.more
            ? `You sent it for ${owed.who}'s message, which is still waiting on you — and other answers for it are still to come: end this turn short, and answer when the last has landed.`
            : `You sent it for ${owed.who}'s message, which is still waiting on you: your last words in this turn go back to it as your answer — so end with what it needs (unless you hand more of the job on).`,
        ]
      : []),
    ...(from.cutIn ? [CUT_IN_LINE] : []),
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
  /** The message the sender owes an answer to and sent this one on behalf
   *  of — a lead handing a job on. That one is answered by the turn the
   *  last such answer starts, not by the turn that handed it on. */
  for?: string;
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
    ...(str("for") ? { for: str("for")! } : {}),
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
  /** For reading old rules that named chats: the project each is in. */
  constructor(private readonly projectOf?: ProjectOf) {}
  private log: TalkLetter[] = [];
  readonly pending = new Map<string, Pending>();
  /** Letters no longer in flight, and where their answer went — so a wait
   *  that comes back for one after it has been handed over is told where. */
  private readonly settled = new Map<string, string>();
  /** Cards up asking the user whether a message may go, by request id. */
  readonly asks = new Map<string, { from: string; answer: (allow: boolean) => void }>();
  /** Messages whose turn is ending because the chat compacted itself in
   *  the middle of the job, and the prompt of that turn: its end does not
   *  answer them — the turn carrying them on does (carryLetter). */
  readonly carried = new Map<string, string>();
  /** Who stopped a chat's turn, when it was not the user — for the sender
   *  of a message that turn was answering. */
  readonly stoppedBy = new Map<string, string>();
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
    this.stored = parsePolicy(raw, this.projectOf);
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

  /** Whether a message still has answers to come back for it: messages
   *  its receiver sent on its behalf that are not in its hands yet. */
  outstanding(letterId: string, except?: string): boolean {
    return [...this.pending.values()].some((p) => p.for === letterId && p.id !== except);
  }

  /** Whether a chat is waiting on an answer to a message it sent: a call
   *  holding for one, or a turn that sent with "wait" and hasn't ended —
   *  between two of its slices, or with the answer already in its line for
   *  the next ask to collect. */
  awaiting(chat: string): boolean {
    return [...this.pending.values()].some(
      (p) => p.from === chat && (p.waiters.size > 0 || (p.reply === "wait" && !p.released)),
    );
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
    args: { to: string; message: string; reply?: TalkReply; delivery?: TalkDelivery },
    signal?: AbortSignal,
  ): Promise<string>;
  /** Hand a job or a question to another project's lead. */
  ask(channelId: string, args: ProjectAsk, signal?: AbortSignal): Promise<string>;
  /** Wait on the answer to a message this chat sent, by its letter id. */
  wait(channelId: string, letter: string, signal?: AbortSignal): Promise<string>;
}

/** The cancellation an MCP tool call's handler is handed, if any. */
function signalOf(extra: unknown): AbortSignal | undefined {
  const signal = (extra as { signal?: unknown } | undefined)?.signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/** A job or a question for another project's lead (ask_project,
 *  {"do": "project"}). */
export interface ProjectAsk {
  /** An open project's name, or a folder's path (opened if it isn't). */
  project: string;
  message: string;
  reply?: TalkReply;
}

const DELIVERY_DOC =
  'How it reaches a chat that is busy. "interrupt" (the default) stops the turn it is running so it reads this now; it is sent back to that work straight after. "queue" waits in its line until the turn it is on is done — for when list_agents shows it deep in something and your message can wait. A chat answering another agent, waiting on an answer of its own, or waiting on the user is never interrupted: it gets the message when that is over.';

const REPLY_DOC =
  'What you get back. By default ("wait") this call waits until that agent has finished the turn your message starts, and returns its answer — its last message. If that takes long, the call returns first with a letter id: call wait_for_answer with it to keep waiting. "later": return at once and keep working; the answer arrives in this chat as a message of its own when it is ready. "none": only when you want the other agent to just do the work in the background and need nothing back — it is told nobody is waiting, and nothing comes back. Unless you say "none", the answer always comes back: if a wait is cut short, stopped or given up, it arrives in this chat as a message instead.';

const HEAD_REPLY_DOC =
  'What you get back. For a lead the default is "later": the call returns at once, you end your turn and stay free, and the answer arrives in this chat as a message of its own when the job is done. "wait": this call waits until that agent has finished the turn your message starts and returns its answer — for a quick question whose answer you need before you can go on; if it takes long, the call returns first with a letter id for wait_for_answer. "none": the other agent just does the work and nothing comes back. Unless you say "none", the answer always comes back.';

/** The talk tools, for the `ruri` MCP server a Claude chat gets. `head`:
 *  the chat is a lead or a liaison, which hands jobs on, and hears back
 *  "later" unless it says otherwise. */
export function talkTools(host: TalkHost, channelId: string, head = false) {
  return [
    tool(
      "list_agents",
      "List the other agents open in ruri that you may message — your project's team, and every other open project (through its liaison, the lead that takes other projects' messages) — with each one's handle, its model, and what it is doing right now: idle, or working (for how long, on what, the tool it is running, how many prompts are queued behind it), answering another agent, waiting on an answer, or waiting on the user. Use it to decide whether a message is worth interrupting a chat for. The user decides who you may message.",
      {},
      async () => ({ content: [{ type: "text", text: host.list(channelId) }] }),
    ),
    tool(
      "message_agent",
      'Send a message to another agent open in ruri — a teammate in this project, or another project (its liaison gets it) — and get its answer back. It arrives in that chat as a prompt marked as yours. A chat at work is interrupted for it by default (delivery "queue" waits instead). Use it to ask what another agent knows or has done, to hand it something to do in its project, or to tell it something it needs. By default you wait for the answer; say reply "none" only when the other agent should just do the work in the background and you need nothing back. Outside bypass mode the user is asked first, on a card.',
      {
        to: z.string().describe("The agent's handle from list_agents (or its project and chat name)"),
        message: z
          .string()
          .describe(
            "What to say. It reads this cold: say who you are working for and what you need, and include anything it cannot know.",
          ),
        reply: z
          .enum(["wait", "later", "none"])
          .optional()
          .describe(head ? HEAD_REPLY_DOC : REPLY_DOC),
        delivery: z.enum(["interrupt", "queue"]).optional().describe(DELIVERY_DOC),
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
                ...(args.delivery ? { delivery: args.delivery } : {}),
              },
              signalOf(extra),
            ),
          },
        ],
      }),
    ),
    tool(
      "ask_project",
      "Hand a job, or a question, to another project: its liaison — the lead that takes other projects' messages — gets it and hands it on to its own team, and answers the way message_agent does (reply \"wait\" by default). Any project open in ruri (list_agents lists them), or a folder path, which is opened as a project — its lead new with it — if it isn't. Not for your own project: there, message a teammate. Outside bypass mode the user is asked first, on a card.",
      {
        project: z
          .string()
          .describe("An open project's name (as list_agents shows it), or a folder path to open"),
        message: z
          .string()
          .describe(
            "What its liaison reads. It knows nothing of you: say who you are working for, what you need, and anything it cannot find in its folder.",
          ),
        reply: z.enum(["wait", "later", "none"]).optional().describe(REPLY_DOC),
      },
      async (args, extra) => ({
        content: [
          {
            type: "text",
            text: await host.ask(
              channelId,
              {
                project: args.project,
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

/** What a Claude chat is told about the tools. `head`: a lead or a
 *  liaison, whose messages come back "later" unless it says otherwise. */
export function talkToolBriefing(head = false): string {
  return [
    "<ruri:talk>",
    "Other agents are working in ruri too — your project's team, and the user's other open projects, each reached through its liaison — and you can talk to them. mcp__ruri__list_agents shows who you may message and what each is doing right now; mcp__ruri__message_agent sends one a message and brings back its answer; mcp__ruri__ask_project hands a job or a question to another project (or to a folder, opened as a project first).",
    'A message interrupts a chat at work by default — it stops, reads yours, and goes back to what it was doing. When list_agents shows it deep in something your message can wait for, send it with delivery "queue".',
    head
      ? 'The answer comes back unless you ask for none: by default — you are a lead — message_agent returns at once and the answer comes to this chat as a message when it is ready ("later"); reply "wait" holds the call for it (a long job returns first with a letter id — mcp__ruri__wait_for_answer keeps waiting); reply "none" is only for work the other agent should just get on with in the background, with nothing sent back.'
      : 'The answer comes back unless you ask for none: by default message_agent waits for it (a long job returns first with a letter id — mcp__ruri__wait_for_answer keeps waiting); reply "later" keeps you working and brings the answer to this chat as a message; reply "none" is only for work the other agent should just get on with in the background, with nothing sent back.',
    "For the chats in ruri use these tools, not ListAgents or SendMessage: those reach Claude sessions on this machine behind ruri's back — a message waits on another user's approval there, and no answer comes back through ruri.",
    "Reach for it when another agent holds what you need — how its side of an API works, what it just changed, a job that belongs in its project — rather than guessing or doing its work for it. A message arriving from another agent shows up as <ruri:message>: answer it by ending your turn with what it needs.",
    "</ruri:talk>",
  ].join("\n");
}

/** The same thing over HTTP, for every other harness. `waitMs` is how
 *  long one call waits on this chat's harness (httpWaitMs); `head`, as for
 *  the tools. */
export function talkHttpBriefing(endpoint: string, waitMs = HTTP_WAIT_DEFAULT_MS, head = false): string {
  const slice = Math.round(waitMs / 1000);
  const allow = slice + 10;
  const call = (body: string) =>
    `  curl -s -X POST ${endpoint} -H 'content-type: application/json' -d '${body}'`;
  return [
    "<ruri:talk>",
    `Other agents are working in ruri too — your project's team, and the user's other open projects, each reached through its liaison — and you can talk to them, by POSTing JSON to ${endpoint}. Each call answers {"ok": true, "text": "...", ...}; read "text".`,
    '  {"do": "list"} — who you may message, each with a handle',
    '  {"do": "list"} also says what each is doing right now — idle, or working (for how long, on what), answering another agent, waiting on the user',
    '  {"do": "send", "to": "<handle>", "message": "...", "reply": "wait", "delivery": "interrupt"} — send one a message',
    '  {"do": "project", "project": "<open project name, or a folder path>", "message": "...", "reply": "wait"} — hand a job or a question to another project, through its liaison (a folder is opened as a project first)',
    '  {"do": "wait", "letter": "<id>"} — keep waiting on the answer to a message you sent',
    '"delivery": "interrupt" (the default) stops the turn a busy chat is running so it reads yours now, and sends it back to that work after; "queue" waits in its line instead — for when it is deep in something your message can wait for.',
    call('{"do":"list"}'),
    `"reply" is what you get back. ${head ? 'For you, a lead, "later" is the default — see below. "wait"' : '"wait" (the default)'} waits for the answer — the other agent's last message when it has finished the turn your message starts. One call waits at most ${slice} seconds: if the answer is not in by then it returns "answered": false with the message's "letter" id, and you run {"do": "wait", "letter": "<id>"} — again and again, as long as it takes — to keep waiting. Let every call run ${allow} seconds before your shell gives up on it (set the command's timeout, or yield time, to at least ${allow * 1000} ms), and read what it prints.`,
    `"later"${head ? " (your default)" : ""}: the call returns at once and you keep working; the answer arrives in this chat as a message when it is ready. "none": only when you want the other agent to just do the work in the background and need nothing back — it is told nobody is waiting, and nothing comes back.`,
    'Unless you say "none", the answer always comes back: if a wait times out, is cut short or you stop waiting, it arrives in this chat as a message instead. Outside bypass mode the user is asked before each message goes.',
    "A message arriving from another agent shows up as <ruri:message>: answer it by ending your turn with what it needs. Keep the endpoint to yourself.",
    "</ruri:talk>",
  ].join("\n");
}
