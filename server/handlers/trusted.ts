/**
 * Trusted agents, run against the live server (the list, the words and the
 * tools are server/trusted.ts): which chats the user trusts, the cards
 * handed to them, the questions other chats ask them, and what a trusted
 * chat may do to the rest of ruri.
 *
 * A card is handed over when it comes up in a turn a trusted agent
 * prompted (routeCard, from where cards are raised — server/chats.ts and
 * handlers/talk.ts), or when a chat asks outright (askTrusted). Handed
 * over means: marked on the card (`asked`), so the windows show whose it
 * is and nothing tells the user of it yet; and told to the agent — into a
 * call of its own that is waiting on an answer, when there is one, since a
 * chat waiting on another cannot be sent a message; otherwise as a message
 * in its chat. The user may answer it at any time all the same. Left
 * unanswered for cardWaitMs it becomes the user's (fellBack): the mark
 * goes, and they are told as of any card.
 *
 * Whatever a trusted agent answers is written into the transcript of the
 * chat the card was in.
 */
import { randomUUID } from "node:crypto";
import {
  leadOf,
  type AskAnswers,
  type AskQuestions,
  type LetterFrom,
  type PermissionRequest,
  type Project,
  type ServerMessage,
  type SessionInfo,
  type TalkAsk,
  type TranscriptEvent,
} from "../../shared/protocol.js";
import { channelProject, running } from "../channel.js";
import type { ServerContext } from "../context.js";
import { stopTurn } from "../dispatch.js";
import { foldName } from "../finder.js";
import { warn } from "../log.js";
import { promptedBy } from "../origin.js";
import { phoneAnswer, phoneAsk, phoneItems } from "../phoneChat.js";
import { sessionsMode } from "../sessionsMode.js";
import { seatName } from "../talk.js";
import {
  ASK_WAIT_MS,
  cardBody,
  cardPrompt,
  cardWaitMs,
  cardWhileWaiting,
  spanWords,
  TrustedBook,
  type CardAnswer,
  type CardWords,
  type TrustedAsk,
  type TrustedHost,
  type Via,
} from "../trusted.js";
import { cutOff, deliver, doing } from "./talk.js";
import type { Handlers } from "./types.js";

/** A card handed to a trusted agent, until it is answered or falls back. */
interface Routed {
  agent: string;
  timer: NodeJS.Timeout;
  /** The agent has been told of it — in a call of its own that was
   *  waiting, or by a message in its chat. */
  told: boolean;
  how?: "wait" | "message";
}

/** How a question asked with ask_trusted ended. */
export interface AskResult {
  text: string;
  by: "agent" | "user" | "nobody";
  /** What was picked or said. */
  answer?: string;
}

/** A question a chat asked with ask_trusted: a card of ruri's own. */
interface Ask {
  id: string;
  from: string;
  question: string;
  options: string[];
  waiters: Set<(result: AskResult | undefined) => void>;
}

interface State {
  book: TrustedBook;
  routed: Map<string, Routed>;
  asks: Map<string, Ask>;
  /** Answers nobody was holding for when they came — a harness that asks
   *  in slices, between two of them — by ask id, until collected. */
  answered: Map<string, { from: string; result: AskResult }>;
}

const states = new WeakMap<ServerContext, State>();

function stateOf(ctx: ServerContext): State {
  let state = states.get(ctx);
  if (!state) {
    state = { book: new TrustedBook(), routed: new Map(), asks: new Map(), answered: new Map() };
    states.set(ctx, state);
  }
  return state;
}

/* ── who is trusted ───────────────────────────────────────────────── */

/** The agents the user trusts, in the order they are asked: each
 *  registered project's own chat, for those still open. */
export function trustedChats(ctx: ServerContext): Array<{ chat: string; project: Project }> {
  return stateOf(ctx)
    .book.list()
    .flatMap((agent) => {
      const project = ctx.store.get(agent.project);
      const chat = project ? leadOf(project) : undefined;
      return project && chat ? [{ chat: chat.id, project }] : [];
    });
}

/** Whether a chat is one the user trusts: a registered project's own chat. */
export function isTrusted(ctx: ServerContext, chat: string): boolean {
  const found = ctx.store.findSession(chat);
  return !!found && stateOf(ctx).book.has(found.project.id) && leadOf(found.project)?.id === chat;
}

function titleOf(ctx: ServerContext, project: Project, session: SessionInfo): string {
  return sessionsMode(ctx) && leadOf(project)?.id === session.id ? "" : (session.title ?? "");
}

/** A chat by the name the others know it by. */
function nameOf(ctx: ServerContext, chat: string): string {
  const found = ctx.store.findSession(chat);
  return found ? seatName(found.project.name, titleOf(ctx, found.project, found.session)) : "a closed chat";
}

/** Whether a chat is told of things by its tools, or over its endpoint. */
function viaOf(ctx: ServerContext, chat: string): Via {
  try {
    const model = channelProject(ctx, chat)?.model || ctx.store.defaultModel();
    return ctx.models.registry.parse(model).providerId ? "http" : "tool";
  } catch {
    return "tool";
  }
}

/** Whether a chat is on a harness that holds none of ruri's tools, and so
 *  reaches ruri over its talk endpoint (server/routes.ts). */
export function speaksOverHttp(ctx: ServerContext, chat: string): boolean {
  return viaOf(ctx, chat) === "http";
}

/** A line into a chat's transcript, of ruri's own. */
function say(ctx: ServerContext, chat: string, text: string): void {
  const event: TranscriptEvent = { kind: "info", id: randomUUID(), text, ts: Date.now() };
  try {
    ctx.archive.append(chat, event);
    ctx.clients.pushEvent(chat, event);
  } catch (err) {
    warn("trusted", err, "transcript line");
  }
}

const oneLine = (text: string, max = 160) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/* ── cards handed to a trusted agent ──────────────────────────────── */

/** A card as a trusted agent is told of it. */
function wordsOf(ctx: ServerContext, request: PermissionRequest): CardWords {
  const shown = phoneAsk(request);
  const base = { id: request.requestId, chat: nameOf(ctx, request.projectId) };
  if (shown.kind === "question") {
    const asked = stateOf(ctx).asks.has(request.requestId);
    return {
      ...base,
      kind: "question",
      title: asked ? "It asks:" : "It has a question, and waits on the answer:",
      questions: (shown.questions ?? []).map((q) => ({
        question: q.question,
        options: q.options.map((o) => o.label),
        multi: q.multi,
        other: q.other,
      })),
      ...(asked ? { asked: true } : {}),
    };
  }
  if (shown.kind === "message") {
    const ask = request.input as TalkAsk;
    const whom = `${ask.project}${ask.title ? ` · ${ask.title}` : ""}`;
    return {
      ...base,
      kind: "message",
      title: ask.opening
        ? `It wants to open ${ask.project} as a project and send it this message:`
        : `It wants to send ${whom} this message:`,
      ...(shown.detail ? { detail: shown.detail } : {}),
    };
  }
  return {
    ...base,
    kind: "permission",
    title:
      request.toolName === "ExitPlanMode"
        ? "It has finished planning and wants to start building from this plan:"
        : `It wants to use ${request.toolName}${shown.detail ? ":" : "."}`,
    ...(shown.detail ? { detail: shown.detail } : {}),
  };
}

/** What a card was about, in a line, for the transcript. */
function whatOf(request: PermissionRequest): string {
  if (request.kind === "message") {
    const ask = request.input as TalkAsk;
    return `the message to ${ask.project}${ask.title ? ` · ${ask.title}` : ""}`;
  }
  if (request.kind === "question") return "the question";
  const detail = phoneAsk(request).detail;
  return `${request.toolName}${detail ? `: ${oneLine(detail)}` : ""}`;
}

/**
 * A card about to go up: handed to the trusted agent that prompted the
 * turn it comes up in, when one did — marked as asked of it, and told to
 * it once it is up. Any other card is returned as it came: the user's.
 * Never a component to name, nor a card of one of the user's own agents.
 */
export function routeCard(ctx: ServerContext, request: PermissionRequest): PermissionRequest {
  if (request.kind === "component" || request.agent || request.asked) return request;
  let agent: string | undefined;
  try {
    const origin = promptedBy(ctx, request.projectId);
    if (origin.by === "agent" && origin.chat !== request.projectId && isTrusted(ctx, origin.chat))
      agent = origin.chat;
  } catch (err) {
    warn("trusted", err, "routing a card");
  }
  return agent ? handTo(ctx, request, agent) : request;
}

/** Mark a card as asked of an agent, and see that it is told. */
function handTo(ctx: ServerContext, request: PermissionRequest, agent: string): PermissionRequest {
  const state = stateOf(ctx);
  const wait = cardWaitMs();
  const id = request.requestId;
  const timer = setTimeout(() => fellBack(ctx, id), wait);
  timer.unref?.();
  state.routed.set(id, { agent, timer, told: false });
  // told once the card is up, where whoever raised it puts it
  setImmediate(() => {
    try {
      handOver(ctx, id);
    } catch (err) {
      warn("trusted", err, "handing a card over");
    }
  });
  return { ...request, asked: { agent, name: nameOf(ctx, agent), until: Date.now() + wait } };
}

/** The prompt a card rides into its agent's chat on, when no call of the
 *  agent's is waiting to be handed it: marked as from the chat at the
 *  card, in ruri's own words. */
function cardFrom(ctx: ServerContext, request: PermissionRequest): LetterFrom {
  const found = ctx.store.findSession(request.projectId);
  return {
    agent: request.projectId,
    project: found?.project.name ?? "a closed project",
    title: found ? titleOf(ctx, found.project, found.session) : "",
    letter: `card:${request.requestId}`,
    reply: "none",
    depth: 1,
    carried: true,
  };
}

/**
 * Tell an agent of a card handed to it. A call of its own holding for an
 * answer is handed the card as what its wait came back with — a chat
 * waiting on another is never interrupted, and the chat it waits on is
 * most likely the one at the card. One between two such calls gets it
 * with its next (cardsFor), or when its turn ends (trustedTurnEnded).
 * Anything else is sent a message, which cuts in on a turn at work.
 */
function handOver(ctx: ServerContext, id: string): void {
  const routed = stateOf(ctx).routed.get(id);
  const request = ctx.permissions.get(id);
  if (!routed || !request || routed.told) return;
  const agent = routed.agent;
  if (!ctx.store.findSession(agent)) {
    fellBack(ctx, id);
    return;
  }
  const card = wordsOf(ctx, request);
  const via = viaOf(ctx, agent);
  const held = [...ctx.talk.pending.values()].filter((p) => p.from === agent && p.waiters.size > 0);
  const letter = held.find((p) => p.to === request.projectId) ?? held[0];
  if (letter) {
    routed.told = true;
    routed.how = "wait";
    const said = cardWhileWaiting(card, via, cardWaitMs(), letter.id);
    for (const waiter of [...letter.waiters]) waiter({ text: said, answered: false });
    return;
  }
  if (ctx.talk.awaiting(agent)) return;
  routed.told = true;
  routed.how = "message";
  deliver(ctx, agent, cardPrompt(card, via, cardWaitMs(), !card.asked), cardFrom(ctx, request), "interrupt");
}

/**
 * The cards handed to a chat that it has not been told of yet, for a wait
 * of its own that is about to hold (handlers/talk.ts waitOn): the wait
 * comes back with them instead. Nothing when there are none.
 */
export function cardsFor(
  ctx: ServerContext,
  chat: string,
  letter: string,
  via: Via = "tool",
): string | undefined {
  const state = states.get(ctx);
  if (!state || state.routed.size === 0) return undefined;
  const said: string[] = [];
  for (const [id, routed] of state.routed) {
    const request = ctx.permissions.get(id);
    if (routed.agent !== chat || routed.told || !request) continue;
    routed.told = true;
    routed.how = "wait";
    said.push(cardWhileWaiting(wordsOf(ctx, request), via, cardWaitMs(), letter));
  }
  return said.length ? said.join("\n\n") : undefined;
}

/** A card left unanswered by its agent — or whose agent is gone: it is the
 *  user's now, and they are told of it as of any card. */
function fellBack(ctx: ServerContext, id: string, why?: string): void {
  const state = stateOf(ctx);
  const routed = state.routed.get(id);
  if (!routed) return;
  clearTimeout(routed.timer);
  state.routed.delete(id);
  const request = ctx.permissions.get(id);
  if (!request?.asked) return;
  const { asked, ...rest } = request;
  ctx.permissions.set(id, rest);
  ctx.clients.broadcast({ type: "permission_request", request: rest });
  say(
    ctx,
    request.projectId,
    why ??
      `${asked.name} left this card unanswered for ${spanWords(cardWaitMs())} — it is yours to answer now`,
  );
}

/** A card is gone — answered, or its turn moved on. */
export function cardGone(ctx: ServerContext, id: string): void {
  const state = states.get(ctx);
  const routed = state?.routed.get(id);
  if (!state || !routed) return;
  clearTimeout(routed.timer);
  state.routed.delete(id);
}

/* ── asking a trusted agent ───────────────────────────────────────── */

/** What a call asking a trusted agent hands back. */
export interface AskOutcome {
  text: string;
  /** The ask's id, to keep waiting by. */
  ask?: string;
  answered?: boolean;
  by?: AskResult["by"];
  answer?: string;
}

export interface AskOptions {
  via?: Via;
  /** How long this one call may hold (ASK_WAIT_MS for a tool call). */
  waitMs?: number;
  signal?: AbortSignal;
}

const QUESTION_MAX = 6_000;
const DEFAULT_OPTIONS = ["Approve", "Deny"];

/** Whether a chat has a question of its own out with ask_trusted: its turn
 *  is waiting on the answer, and is not stopped for a message. */
export function askingTrusted(ctx: ServerContext, chat: string): boolean {
  const state = states.get(ctx);
  if (!state) return false;
  for (const ask of state.asks.values()) if (ask.from === chat) return true;
  return false;
}

/**
 * A chat asks whoever the user trusts (ask_trusted, {"do": "trusted"}).
 * The question goes up as a card in the asking chat — handed to the first
 * trusted agent that is open and is not the asker; with none, it is the
 * user's from the start — and the call waits for it to be answered, by
 * the agent, or by the user, who may answer at any time and is asked
 * outright once the agent has left it too long.
 */
export async function askTrusted(
  ctx: ServerContext,
  channelId: string,
  args: TrustedAsk,
  opts: AskOptions = {},
): Promise<AskOutcome> {
  const state = stateOf(ctx);
  if (args.ask) {
    const id = args.ask.trim();
    const done = state.answered.get(id);
    if (done && done.from === channelId) {
      state.answered.delete(id);
      return outcomeOf(id, done.result);
    }
    const waiting = state.asks.get(id);
    if (!waiting || waiting.from !== channelId)
      return {
        text: `No question of this chat's is waiting as "${args.ask}": it was answered and collected, or the turn that asked it ended.`,
        ask: id,
      };
    return waitAsk(ctx, waiting, opts);
  }
  const me = ctx.store.findSession(channelId);
  if (!me) return { text: "Only a chat in a project can ask." };
  const question = (args.question ?? "").trim();
  if (!question) return { text: "The question is empty: say what you need approved or decided, and why." };
  const options = [...new Set((args.options ?? []).map((o) => o.trim()).filter(Boolean))].slice(0, 8);
  const id = randomUUID();
  const ask: Ask = {
    id,
    from: channelId,
    question: question.length > QUESTION_MAX ? `${question.slice(0, QUESTION_MAX)}\n… (cut short)` : question,
    options: options.length ? options : DEFAULT_OPTIONS,
    waiters: new Set(),
  };
  const input: AskQuestions = {
    questions: [
      {
        question: ask.question,
        header: "Decide",
        options: ask.options.map((label) => ({ label, description: "" })),
        multiSelect: false,
        allowOther: true,
      },
    ],
  };
  const card: PermissionRequest = {
    requestId: id,
    projectId: channelId,
    toolName: "ask_trusted",
    kind: "question",
    input,
    ts: Date.now(),
  };
  state.asks.set(id, ask);
  const agent = trustedChats(ctx).find((one) => one.chat !== channelId)?.chat;
  const request = agent ? handTo(ctx, card, agent) : card;
  ctx.permissions.set(id, request);
  ctx.clients.broadcast({ type: "permission_request", request });
  return waitAsk(ctx, ask, opts);
}

function outcomeOf(id: string, result: AskResult): AskOutcome {
  return {
    text: result.text,
    ask: id,
    // ended with nobody answering — its turn over, its chat closed — is no answer
    answered: result.by !== "nobody",
    by: result.by,
    ...(result.answer !== undefined ? { answer: result.answer } : {}),
  };
}

/** Hold a call until its question is answered, the slice runs out, or the
 *  call goes away. */
function waitAsk(ctx: ServerContext, ask: Ask, opts: AskOptions): Promise<AskOutcome> {
  const { signal } = opts;
  return new Promise<AskOutcome>((resolve) => {
    const again =
      opts.via === "http"
        ? `run {"do": "trusted", "ask": "${ask.id}"}`
        : `call ask_trusted with ask "${ask.id}"`;
    const notYet = (): AskOutcome => {
      const asked = ctx.permissions.get(ask.id)?.asked;
      return {
        text: `No answer yet: ${asked ? `${asked.name} has the question, and the user is asked if it leaves it` : "the user has the question, on a card in this chat"}. To keep waiting, ${again} — as often as it takes.`,
        ask: ask.id,
        answered: false,
      };
    };
    const timer = setTimeout(() => finish(notYet()), opts.waitMs ?? ASK_WAIT_MS);
    timer.unref?.();
    const finish = (outcome: AskOutcome) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", gone);
      if (!ask.waiters.delete(waiter)) return;
      resolve(outcome);
    };
    const waiter = (result: AskResult | undefined) => finish(result ? outcomeOf(ask.id, result) : notYet());
    const gone = () => finish({ text: "Stopped waiting.", ask: ask.id, answered: false });
    ask.waiters.add(waiter);
    if (signal?.aborted) gone();
    else signal?.addEventListener("abort", gone, { once: true });
  });
}

/** A question asked with ask_trusted is over: its card comes down, and
 *  whoever is holding for it is told — or it is kept for the next ask. */
function finishAsk(ctx: ServerContext, ask: Ask, result: AskResult): void {
  const state = stateOf(ctx);
  state.asks.delete(ask.id);
  cardGone(ctx, ask.id);
  if (ctx.permissions.delete(ask.id))
    ctx.clients.broadcast({ type: "permission_resolved", requestId: ask.id });
  if (ask.waiters.size > 0) {
    for (const waiter of [...ask.waiters]) waiter(result);
    return;
  }
  if (result.by === "nobody") return;
  state.answered.set(ask.id, { from: ask.from, result });
  if (state.answered.size > 100) state.answered.delete(state.answered.keys().next().value!);
}

/**
 * The user answered a card that is a question asked with ask_trusted —
 * theirs from the start, theirs once the agent left it, or one they chose
 * to answer first. False when the card is not one.
 */
export function answerTrustedAsk(ctx: ServerContext, requestId: string, answers?: AskAnswers): boolean {
  const ask = states.get(ctx)?.asks.get(requestId);
  if (!ask) return false;
  const said = (answers?.answers[ask.question] ?? answers?.response ?? "").trim();
  finishAsk(
    ctx,
    ask,
    said
      ? { by: "user", answer: said, text: `The user answered: ${said}` }
      : {
          by: "user",
          text: "The user waved the question away without answering. Take that as a no: don't do what you asked leave for.",
        },
  );
  return true;
}

/* ── a chat's turn ending, chats closing ──────────────────────────── */

/**
 * A chat's turn ended. A question it asked with ask_trusted and never
 * collected is taken down: nothing is waiting on it any more. A card it
 * was handed as a trusted agent and ended its turn without answering — it
 * had the card in hand, in a wait or as the message that started the turn
 * — is the user's now, without the rest of the wait: the agent has had its
 * say. And a card handed to it that it was not told of — it was between
 * two waits — goes to it now, as a message.
 */
export function trustedTurnEnded(ctx: ServerContext, chat: string): void {
  const state = states.get(ctx);
  if (!state) return;
  for (const ask of [...state.asks.values()]) {
    if (ask.from !== chat) continue;
    finishAsk(ctx, ask, { by: "nobody", text: "Your turn ended before the question was answered." });
  }
  for (const [id, done] of state.answered) if (done.from === chat) state.answered.delete(id);
  const read = new Set(
    ctx.archive
      .events(chat)
      .flatMap((event) => (event.kind === "user" && event.from ? [event.from.letter] : [])),
  );
  for (const [id, routed] of [...state.routed]) {
    if (routed.agent !== chat || !routed.told) continue;
    // a message still in its line has not been read yet: it gets its turn
    if (routed.how === "message" && !read.has(`card:${id}`)) continue;
    fellBack(
      ctx,
      id,
      `${nameOf(ctx, chat)} ended its turn without answering this card — it is yours to answer now`,
    );
  }
  const owed = [...state.routed.entries()].filter(([, routed]) => routed.agent === chat && !routed.told);
  if (owed.length === 0) return;
  // a moment on, once the chat's status has left the turn that just ended
  setTimeout(() => {
    for (const [id] of owed) {
      try {
        handOver(ctx, id);
      } catch (err) {
        warn("trusted", err, "handing a card over");
      }
    }
  }, 1500).unref?.();
}

/** Chats closing: what they asked goes with them, and a card handed to
 *  one of them is the user's. */
export function trustedChatsClosed(ctx: ServerContext, chats: string[]): void {
  const state = states.get(ctx);
  if (!state) return;
  const closing = new Set(chats);
  for (const ask of [...state.asks.values()])
    if (closing.has(ask.from)) finishAsk(ctx, ask, { by: "nobody", text: "This chat was closed." });
  for (const [id, routed] of [...state.routed])
    if (closing.has(routed.agent))
      fellBack(ctx, id, `${nameOf(ctx, routed.agent)} was closed — this card is yours to answer`);
}

/* ── what a trusted chat may do ───────────────────────────────────── */

const NOT_TRUSTED =
  "Only a chat the user has registered as a trusted agent may do that (Settings → Trusted agents). Use ask_trusted to ask one.";

/** Any open chat by a handle, a project's name, or its own id. */
function findChat(ctx: ServerContext, to: string): { chat: string; name: string } | string {
  const want = to.trim().replace(/^@/, "");
  const key = foldName(want);
  const all = ctx.store
    .list()
    .flatMap((project) => project.sessions.map((session) => ({ project, session })));
  const spaced = (text: string) =>
    foldName(text)
      .replace(/[·/:|—–-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  const hit =
    all.find((one) => one.session.id === want) ??
    all.find((one) => ctx.talk.handleOf(one.session.id) === want.toLowerCase()) ??
    all.find((one) => foldName(one.project.name) === key && leadOf(one.project)?.id === one.session.id) ??
    all.find(
      (one) => !!one.session.title && spaced(`${one.project.name} ${one.session.title}`) === spaced(want),
    );
  return hit
    ? { chat: hit.session.id, name: nameOf(ctx, hit.session.id) }
    : `No chat answers to "${to}". list_agents shows the open projects, and each one's handle.`;
}

/** Every card up, as a trusted chat reads them. */
export function listCards(ctx: ServerContext, by: string): string {
  if (!isTrusted(ctx, by)) return NOT_TRUSTED;
  const now = Date.now();
  const cards = [...ctx.permissions.values()]
    .filter((request) => request.kind !== "component")
    .sort((a, b) => a.ts - b.ts);
  if (cards.length === 0) return "No card is up: no chat is waiting on an answer.";
  const lines = ["Cards up — answer one with answer_card and its id:"];
  for (const request of cards) {
    const whose =
      request.projectId === by
        ? "in your own chat: the user's to answer"
        : request.asked?.agent === by
          ? "handed to you"
          : request.asked
            ? `handed to ${request.asked.name}`
            : "waiting on the user";
    const waited = spanWords(Math.max(0, now - (request.ts || now)));
    lines.push(
      "",
      `card "${request.requestId}" — ${whose}, up for ${waited}`,
      cardBody(wordsOf(ctx, request)),
    );
  }
  return lines.join("\n");
}

/**
 * A trusted chat's answer to a card: any card but one in its own chat. A
 * tool or a message allowed or refused — "always" as the user's own Always
 * allow — or a question answered; and the transcript of the chat the card
 * was in says who answered, and what.
 */
export function answerCard(ctx: ServerContext, by: string, args: CardAnswer): string {
  if (!isTrusted(ctx, by)) return NOT_TRUSTED;
  const id = args.card.trim();
  const request = ctx.permissions.get(id);
  if (!request || request.kind === "component")
    return `No card "${args.card}" is up: it was answered already, or its turn moved on. list_cards shows what is up.`;
  if (request.projectId === by)
    return "That card is in your own chat: it is the user's to answer, not yours.";
  const me = nameOf(ctx, by);
  const chat = nameOf(ctx, request.projectId);
  const signed = `${me}, trusted to answer for you,`;
  const state = stateOf(ctx);
  const ask = state.asks.get(id);
  if (ask) {
    // left to the user: theirs now, without the wait
    if (args.dismiss) {
      fellBack(ctx, id, `${me} left this question to you`);
      return `Left to the user: the question is on a card in ${chat}'s chat for them.`;
    }
    const one = args.answers?.[0];
    const wanted = [
      ...(one?.picked ?? []),
      ...(args.allow === true ? ["Approve"] : args.allow === false ? ["Deny"] : []),
    ].map((label) => foldName(label));
    const picked = ask.options.filter((option) => wanted.includes(foldName(option)));
    const words = one?.other?.trim() ?? "";
    if (picked.length === 0 && !words)
      return `Say what you decide: answers with one of ${ask.options.map((o) => `"${o}"`).join(", ")} in picked, and your reason in other.`;
    const answer = [picked.join(", "), words].filter(Boolean).join(" — ");
    finishAsk(ctx, ask, {
      by: "agent",
      answer,
      text: `${me}, whom the user trusts to decide in their place, answered: ${answer}`,
    });
    say(ctx, request.projectId, `${signed} answered what this chat asked: ${oneLine(answer, 300)}`);
    return `Answered ${chat}: ${answer}`;
  }
  const what = whatOf(request);
  if (request.kind === "question") {
    const answers = (args.answers ?? []).map((a) => ({
      picked: a.picked ?? [],
      ...(a.other ? { other: a.other } : {}),
    }));
    const done = phoneAnswer(ctx, {
      id: request.projectId,
      ask: id,
      ...(args.dismiss ? { dismiss: true as const } : { answers }),
    });
    if (!done.ok)
      return `Not answered: ${done.error.replace("on your Mac", "by the user, at their computer")}`;
    const said = answers.map((a) => [...a.picked, a.other ?? ""].filter(Boolean).join(", ")).join("; ");
    say(
      ctx,
      request.projectId,
      args.dismiss
        ? `${signed} waved the question away`
        : `${signed} answered the question: ${oneLine(said, 300)}`,
    );
    return args.dismiss ? `Waved ${chat}'s question away.` : `Answered ${chat}'s question.`;
  }
  if (args.allow === undefined) return "This card is allowed or refused: say allow true or false.";
  const always = args.allow && args.always === true && request.kind !== "message";
  const done = phoneAnswer(ctx, { id: request.projectId, ask: id, allow: args.allow }, always);
  if (!done.ok) return `Not answered: ${done.error}`;
  say(
    ctx,
    request.projectId,
    `${signed} ${args.allow ? "allowed" : "refused"} ${what}${always ? " — and to stop asking about it in this chat" : ""}`,
  );
  return `${args.allow ? "Allowed" : "Refused"} ${chat}'s ${request.kind === "message" ? "message" : request.toolName}${always ? ", and it stops asking about it" : ""}.`;
}

const READ_DEFAULT = 20;
const READ_CHARS = 30_000;

/** A chat's recent conversation, as a trusted chat reads it. */
export function readChat(ctx: ServerContext, by: string, args: { chat: string; last?: number }): string {
  if (!isTrusted(ctx, by)) return NOT_TRUSTED;
  const found = findChat(ctx, args.chat);
  if (typeof found === "string") return found;
  const last = Math.min(100, Math.max(1, Math.round(args.last ?? READ_DEFAULT)));
  const items = phoneItems(ctx.archive.events(found.chat)).slice(-last);
  const lines = [`${found.name} — ${doing(ctx, found.chat)}`];
  for (const item of items) {
    const who =
      item.kind === "user"
        ? item.from
          ? `message from ${item.from}`
          : "the user"
        : item.kind === "assistant"
          ? found.name
          : item.kind === "steps"
            ? "steps"
            : "note";
    const body = item.kind === "steps" ? `${item.text}: ${(item.steps ?? []).join("; ")}` : item.text;
    lines.push("", `[${who} · ${item.at}]`, body);
  }
  if (items.length === 0) lines.push("", "(nothing said yet)");
  const text = lines.join("\n");
  return text.length > READ_CHARS
    ? `… (the start is cut: ask for fewer with last)\n${text.slice(-READ_CHARS)}`
    : text;
}

/** A chat's running turn stopped by a trusted chat, as the user's Stop
 *  stops one — and the chat is told who did it. */
export function stopChat(ctx: ServerContext, by: string, args: { chat: string }): string {
  if (!isTrusted(ctx, by)) return NOT_TRUSTED;
  const found = findChat(ctx, args.chat);
  if (typeof found === "string") return found;
  if (found.chat === by) return "That is your own chat: end your turn instead.";
  if (!running(ctx, found.chat)) return `${found.name} isn't at work: there is no turn to stop.`;
  const who = nameOf(ctx, by);
  const call = cutOff(ctx, found.chat);
  ctx.talk.stoppedBy.set(found.chat, who);
  ctx.talk.stopNotes.set(found.chat, { who, ...(call ? { call } : {}) });
  ctx.queues.cutIn.delete(found.chat);
  stopTurn(ctx, found.chat);
  say(ctx, found.chat, `${who}, trusted to act for you, stopped this turn`);
  return `Stopped ${found.name}'s turn. Its queue stands by until it is sent a prompt; a message it was answering is told it was stopped.`;
}

/** The tools' way into all of this. */
export function trustedHost(ctx: ServerContext): TrustedHost {
  return {
    ask: async (channelId, args, signal) =>
      (await askTrusted(ctx, channelId, args, { via: "tool", ...(signal ? { signal } : {}) })).text,
    cards: (channelId) => listCards(ctx, channelId),
    answer: (channelId, args) => answerCard(ctx, channelId, args),
    read: (channelId, args) => readChat(ctx, channelId, args),
    stop: (channelId, args) => stopChat(ctx, channelId, args),
  };
}

/* ── the Settings page ────────────────────────────────────────────── */

/**
 * The user's list, set whole. A project struck from it stops being asked
 * at once: cards handed to its chat become the user's. A chat whose
 * standing changed and is at rest starts its next turn in a fresh process,
 * so the tools it holds are the ones it now may use — one at work keeps
 * what it has, and each tool checks for itself when it is called.
 */
export function setTrusted(ctx: ServerContext, projects: string[]): void {
  const state = stateOf(ctx);
  const before = new Set(trustedChats(ctx).map((one) => one.chat));
  state.book.set(projects.filter((id) => ctx.store.get(id) !== undefined));
  const after = new Set(trustedChats(ctx).map((one) => one.chat));
  for (const [id, routed] of [...state.routed])
    if (!after.has(routed.agent))
      fellBack(ctx, id, `${nameOf(ctx, routed.agent)} is no longer trusted — this card is yours to answer`);
  for (const chat of new Set([...before, ...after])) {
    if (before.has(chat) === after.has(chat) || running(ctx, chat)) continue;
    try {
      const work = ctx.manager.backgroundWork(chat);
      if (work.agents === 0 && work.scripts === 0) ctx.manager.dispose(chat);
    } catch (err) {
      warn("trusted", err, "restarting a chat with its new tools");
    }
  }
  ctx.clients.broadcast(trustedMessage(ctx));
}

function trustedMessage(ctx: ServerContext): ServerMessage {
  return { type: "trusted", agents: stateOf(ctx).book.list() };
}

export const trustedHandlers = {
  trusted_get: (ctx, ws) => {
    ws.send(JSON.stringify(trustedMessage(ctx)));
  },
  trusted_set: (ctx, _ws, msg) => {
    setTrusted(ctx, msg.projects);
  },
} satisfies Partial<Handlers>;
