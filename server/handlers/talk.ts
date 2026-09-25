/**
 * Agents talking to agents, run against the live server (the rules, the
 * words and the book are server/talk.ts): who a chat may message, a
 * message sent — held to the user's rules, asked about outside bypass
 * mode, delivered into the other chat's line — and the answer taken from
 * that chat's turn when it ends and carried back: to the call waiting on
 * it, or, with none waiting, to the sender's chat as a message. Plus the
 * letters a relaunch finds in flight, and the talk page's two messages.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PERMISSION_MODE,
  type LetterFrom,
  type PermissionRequest,
  type Project,
  type ServerMessage,
  type SessionInfo,
  type TalkAsk,
  type TalkReply,
  type TranscriptEvent,
} from "../../shared/protocol.js";
import { channelProject, running } from "../channel.js";
import type { ServerContext } from "../context.js";
import { cutInWith, dispatch } from "../dispatch.js";
import {
  clipAnswer,
  httpWaitMs,
  MAX_DEPTH,
  mayMessage,
  resumePrompt,
  seatName,
  WAIT_MS,
  type Ending,
  type Pending,
  type TalkHost,
} from "../talk.js";
import type { QueueEntry } from "../queue.js";
import type { Handlers } from "./types.js";

interface Found {
  project: Project;
  session: SessionInfo;
}

/** Every chat in every open project, but one. */
function seats(ctx: ServerContext, except: string): Found[] {
  return ctx.store
    .list()
    .flatMap((project) => project.sessions.map((session) => ({ project, session })))
    .filter((seat) => seat.session.id !== except);
}

function nameOf(seat: Found): string {
  return seatName(seat.project.name, seat.session.title ?? "");
}

/** "Frontend UI", "ruri · frontend ui", "ruri/Frontend UI" all read alike. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[·/:|—–-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The chat a message is for: by handle, or by a name only it answers to. */
function findSeat(ctx: ServerContext, to: string, self: string): Found | string {
  const want = to.trim().replace(/^@/, "");
  const all = seats(ctx, self);
  const byHandle = all.find((seat) => ctx.talk.handleOf(seat.session.id) === want.toLowerCase());
  if (byHandle) return byHandle;
  const key = plain(want);
  const named = all.filter((seat) => {
    const title = plain(seat.session.title ?? "");
    const project = plain(seat.project.name);
    return (
      (title !== "" && (key === title || key === `${project} ${title}`)) ||
      // a project by its name alone, when it has the one chat to be
      (key === project && seats(ctx, self).filter((s) => s.project.id === seat.project.id).length === 1)
    );
  });
  if (named.length === 1) return named[0]!;
  if (named.length > 1)
    return `More than one agent answers to "${to}": use its handle from list_agents (${named
      .map((seat) => `${ctx.talk.handleOf(seat.session.id)} is ${nameOf(seat)}`)
      .join(", ")}).`;
  return `No agent answers to "${to}". list_agents shows who you may message, and each one's handle.`;
}

/** How many agents deep the turn a chat is on has gone since the user. */
function depthOf(ctx: ServerContext, channelId: string): number {
  const prompt = ctx.archive.events(channelId).findLast((event) => event.kind === "user");
  return prompt?.kind === "user" ? (prompt.from?.depth ?? 0) : 0;
}

/** What a chat is doing, in a word or two. */
function doing(ctx: ServerContext, chat: string): string {
  const status = ctx.manager.statuses()[chat];
  if (status === "working") return "working";
  if (status === "permission") return "waiting on the user";
  if (ctx.turns.work.has(chat)) return "its agents are working";
  return "idle";
}

/** Who a chat may message, as its model reads it. */
export function listSeats(ctx: ServerContext, channelId: string): string {
  const me = ctx.store.findSession(channelId);
  if (!me) return "Only a chat in a project can message other agents.";
  const policy = ctx.talk.policy();
  const from = { chat: channelId, project: me.project.id };
  const open = seats(ctx, channelId).filter((seat) =>
    mayMessage(policy, from, { chat: seat.session.id, project: seat.project.id }),
  );
  const barred = seats(ctx, channelId).length - open.length;
  const offLimits =
    barred > 0
      ? `${barred} other ${barred === 1 ? "agent is" : "agents are"} off limits to you by the user's talk settings.`
      : "";
  if (open.length === 0) {
    return offLimits
      ? `There is no one you may message right now: ${offLimits}`
      : "There is no one to message: no other chats are open in ruri.";
  }
  const lines: string[] = ["Agents you may message — handle, chat, what it is doing, model:"];
  for (const project of ctx.store.list()) {
    const here = open.filter((seat) => seat.project.id === project.id);
    if (here.length === 0) continue;
    lines.push(
      "",
      `${project.name}${project.id === me.project.id ? " (your project)" : ""} — ${project.path}`,
    );
    for (const seat of here) {
      const model = channelProject(ctx, seat.session.id)?.model || ctx.store.defaultModel();
      lines.push(
        `  ${ctx.talk.handleOf(seat.session.id)}  ${seat.session.title || "untitled chat"} — ${doing(ctx, seat.session.id)} · ${model}`,
      );
    }
  }
  if (offLimits) lines.push("", offLimits);
  return lines.join("\n");
}

/** Put the card up in the sender's chat, and wait for the user. */
function askUser(ctx: ServerContext, channelId: string, ask: TalkAsk): Promise<boolean> {
  return new Promise((answer) => {
    const requestId = randomUUID();
    ctx.talk.asks.set(requestId, { from: channelId, answer });
    const request: PermissionRequest = {
      requestId,
      projectId: channelId,
      toolName: "message_agent",
      kind: "message",
      input: ask,
      ts: Date.now(),
    };
    ctx.permissions.set(requestId, request);
    ctx.clients.broadcast({ type: "permission_request", request });
  });
}

/** The user answered a message card. False when the card is not one. */
export function answerTalk(ctx: ServerContext, requestId: string, allow: boolean): boolean {
  const ask = ctx.talk.asks.get(requestId);
  if (!ask) return false;
  ctx.talk.asks.delete(requestId);
  ctx.permissions.delete(requestId);
  ctx.clients.broadcast({ type: "permission_resolved", requestId });
  ask.answer(allow);
  return true;
}

/**
 * Whether the turn a chat is running may be stopped for a message. Not when
 * it is another agent's message being answered for someone who wants the
 * answer — stopping it would end that answer half-said; not while it waits
 * on an answer of its own (TalkBook.awaiting), which stopping would break
 * off — and with every message now cutting in, that answer is on its way;
 * and not while it waits on the user at a card, where the user is already
 * in the middle of it. Anything else — the user's own work, a job another
 * agent handed over with no answer wanted, an answer this chat is acting
 * on — gives way.
 */
function interruptible(ctx: ServerContext, chat: string): boolean {
  if (ctx.manager.statuses()[chat] === "permission") return false;
  if (ctx.talk.awaiting(chat)) return false;
  const turn = ctx.archive.events(chat).findLast((event) => event.kind === "user");
  const from = turn?.kind === "user" ? turn.from : undefined;
  return !from || from.answer === true || from.reply === "none";
}

/**
 * Into a chat's line. A chat at work is interrupted for it: its turn is
 * stopped and this goes first, ahead of anything the user has queued, and
 * the model is told to take up what it was doing again once it has dealt
 * with it (talk.ts CUT_IN_LINE) — a message left in a queue behind a
 * three-hour turn is a message nobody reads for three hours. Where the turn
 * can't be cut short (interruptible), it waits behind it instead; so does
 * one reaching an idle chat whose queue is standing by (after a stop, or
 * held for the network or a limit), which keeps its place in that line.
 */
function deliver(
  ctx: ServerContext,
  chat: string,
  text: string,
  from: LetterFrom,
): "queued" | "working" | "cut in" {
  // a chat already stopping for something that cut in takes this straight
  // behind it rather than behind the user's queue
  if (ctx.queues.cutIn.has(chat) || (running(ctx, chat) && interruptible(ctx, chat))) {
    const letter: QueueEntry = {
      id: randomUUID(),
      text,
      uploads: [],
      silent: false,
      from: { ...from, cutIn: true },
    };
    // and behind it, once however many cut in, the prompt that sends the
    // chat back to the work they stopped
    const back: QueueEntry[] = ctx.queues.entries.get(chat)?.some((entry) => entry.resume)
      ? []
      : [
          {
            id: randomUUID(),
            text: resumePrompt(seatName(from.project, from.title)),
            uploads: [],
            silent: false,
            resume: true,
          },
        ];
    cutInWith(ctx, chat, [letter, ...back]);
    return "cut in";
  }
  if (running(ctx, chat) || ctx.queues.pending(chat) > 0) {
    const queue = ctx.queues.entries.get(chat) ?? [];
    // a chat on its way back to work a message stopped hears this first
    const back = queue.findIndex((entry) => entry.resume);
    queue.splice(back === -1 ? queue.length : back, 0, {
      id: randomUUID(),
      text,
      uploads: [],
      silent: false,
      from,
    });
    ctx.queues.entries.set(chat, queue);
    ctx.queues.broadcastQueue(chat);
    return "queued";
  }
  dispatch(ctx, chat, text, [], false, from);
  return "working";
}

/** What a call waiting on an answer hands back: the words the model
 *  reads, and — over HTTP — the letter they are about, and whether they
 *  are its answer (or its end) rather than "not yet". */
export interface TalkResult {
  text: string;
  letter?: string;
  answered?: boolean;
}

/** How a call waits. */
export interface WaitOptions {
  /** Which way the model called — its tool, or POST /talk — for the
   *  words it is told to wait again with. */
  via?: "tool" | "http";
  /** How long this one call may hold (WAIT_MS for a tool call). */
  waitMs?: number;
  /** The call going away: the tool call cancelled, the curl cut off. */
  signal?: AbortSignal;
}

/** How to wait again, in the words of the way the model called. */
function waitAgain(via: WaitOptions["via"], letter: string): string {
  return via === "http"
    ? `run {"do": "wait", "letter": "${letter}"}`
    : `call wait_for_answer with letter "${letter}"`;
}

function whoIs(ctx: ServerContext, chat: string): string {
  const found = ctx.store.findSession(chat);
  return found ? seatName(found.project.name, found.session.title ?? "") : "that agent";
}

/** The message as the other chat receives it: whose, and what it wants back. */
function letterFrom(letter: Pending): LetterFrom {
  return {
    agent: letter.from,
    project: letter.sender?.project ?? "",
    title: letter.sender?.title ?? "",
    letter: letter.id,
    // nobody holds a call on a released wait any more: its answer comes
    // back as a message, and the other chat is told as much
    reply: letter.reply === "wait" && letter.released ? "later" : letter.reply,
    depth: letter.depth,
  };
}

/** One message from a chat's model: held to the rules, asked about,
 *  delivered, and — when it waits — answered. */
export async function sendLetter(
  ctx: ServerContext,
  channelId: string,
  args: { to: string; message: string; reply?: TalkReply },
  opts: WaitOptions = {},
): Promise<TalkResult> {
  const me = ctx.store.findSession(channelId);
  if (!me) return { text: "Only a chat in a project can message other agents." };
  const text = args.message.trim();
  if (!text) return { text: "The message is empty: say something." };
  const found = findSeat(ctx, args.to, channelId);
  if (typeof found === "string") return { text: found };
  const target = found.session.id;
  const toName = nameOf(found);
  const reply = args.reply ?? "wait";
  const book = ctx.talk;
  const id = randomUUID();
  const base = { id, from: channelId, to: target, reply, text, ts: Date.now() };

  if (
    !mayMessage(
      book.policy(),
      { chat: channelId, project: me.project.id },
      { chat: target, project: found.project.id },
    )
  ) {
    book.note({ ...base, status: "refused", note: "off limits by the talk settings" });
    return {
      text: `The user has not let you message ${toName}: their talk settings say who you may message. list_agents shows who you can.`,
    };
  }
  const depth = depthOf(ctx, channelId) + 1;
  if (depth > MAX_DEPTH) {
    book.note({ ...base, status: "refused", note: `${MAX_DEPTH} agents deep` });
    return {
      text: `This has gone ${MAX_DEPTH} agents deep since the user last spoke. Stop passing it on: finish your turn with what you have.`,
    };
  }
  if (reply === "wait" && book.waitsOn(target, channelId)) {
    book.note({ ...base, status: "refused", note: "it is waiting on this chat" });
    return {
      text: `${toName} is waiting on your answer right now, so waiting on it in turn would hold you both for good. Answer it by finishing your turn (your last message goes back to it), or send this with reply "later".`,
    };
  }

  // outside bypass mode, every message waits on the user
  const mode = channelProject(ctx, channelId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  if (mode !== "bypassPermissions") {
    book.note({ ...base, status: "asking" });
    const allowed = await askUser(ctx, channelId, {
      to: target,
      project: found.project.name,
      title: found.session.title ?? "",
      text,
      reply,
    });
    if (!allowed) {
      book.mark(id, "denied");
      return { text: `The user did not let that message go to ${toName}.` };
    }
    if (!ctx.store.findSession(target)) {
      book.mark(id, "failed", "closed before it went");
      return { text: `${toName} was closed before the message could go.` };
    }
  }

  // in the book, and on disk, before it goes: whatever happens next —
  // this call cut off, the turn stopped, ruri quitting — it is accounted for
  const pending: Pending = {
    id,
    from: channelId,
    to: target,
    reply,
    depth,
    text,
    ts: base.ts,
    sender: { project: me.project.name, title: me.session.title ?? "" },
    stage: "queued",
    waiters: new Set(),
  };
  book.keep(pending);
  const where = deliver(ctx, target, text, letterFrom(pending));
  // a cut-in waits at the head of the line for the turn it stopped to end:
  // queued, for the moment it takes, and working from when it goes
  book.note({ ...base, status: where === "cut in" ? "queued" : where });
  const queued =
    where === "queued"
      ? ", queued behind what it is doing"
      : where === "cut in"
        ? ", which has stopped what it was doing to read it"
        : "";
  if (reply === "none")
    return {
      text: `Sent to ${toName}${queued}. You asked for no answer: it has been told nobody is waiting on it, and nothing will come back.`,
      letter: id,
    };
  if (reply === "later")
    return {
      text: `Sent to ${toName}${queued}. Its answer will come to this chat as a message when it has finished — carry on meanwhile. (To wait on it after all, ${waitAgain(opts.via, id)}.)`,
      letter: id,
      answered: false,
    };
  return waitOn(ctx, pending, opts);
}

/** Wait on the answer to a message this chat sent, by its letter id. */
export async function waitAnswer(
  ctx: ServerContext,
  channelId: string,
  letterId: string,
  opts: WaitOptions = {},
): Promise<TalkResult> {
  const id = letterId.trim();
  const pending = ctx.talk.pending.get(id);
  if (!pending) {
    // over with: said where its answer went, and that there is no more to wait for
    const where = ctx.talk.whereIs(id);
    return where
      ? { text: where, letter: id, answered: true }
      : {
          text: `No message of yours is in flight as "${letterId}": check the letter id message_agent gave you.`,
          letter: id,
        };
  }
  if (pending.from !== channelId)
    return { text: `The message "${letterId}" is not one this chat sent.`, letter: id };
  if (pending.reply === "none")
    return {
      text: `You asked for no answer to that message, so none is coming: the other agent was told nobody is waiting on it.`,
      letter: id,
      answered: false,
    };
  return waitOn(ctx, pending, opts);
}

/** Hold this call until the letter's answer lands, or the slice runs out,
 *  or the call goes away — in which case an answer landing later finds no
 *  one holding, and goes to the sender's chat as a message (settle). */
function waitOn(ctx: ServerContext, pending: Pending, opts: WaitOptions): Promise<TalkResult> {
  if (pending.ending) return Promise.resolve(collect(ctx, pending));
  const { signal } = opts;
  const id = pending.id;
  return new Promise<TalkResult>((resolve) => {
    // whichever comes first — the answer, the slice's end, the call going
    // away — ends the wait, and the others find it gone
    const timer = setTimeout(
      () => finish({ text: notYet(ctx, pending, opts.via), letter: id, answered: false }),
      opts.waitMs ?? WAIT_MS,
    );
    timer.unref?.();
    const finish = (result: TalkResult) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", gone);
      if (!pending.waiters.delete(waiter)) return;
      resolve(result);
    };
    const waiter = (outcome: { text: string; answered: boolean }) =>
      finish({ text: outcome.text, letter: id, answered: outcome.answered });
    const gone = () => finish({ text: "Stopped waiting.", letter: id, answered: false });
    pending.waiters.add(waiter);
    if (signal?.aborted) gone();
    else signal?.addEventListener("abort", gone, { once: true });
  });
}

/** A slice run out with no answer: where the message has got to, and how
 *  to go on waiting. */
function notYet(ctx: ServerContext, pending: Pending, via: WaitOptions["via"]): string {
  const who = whoIs(ctx, pending.to);
  const state =
    pending.stage === "working"
      ? doing(ctx, pending.to) === "waiting on the user"
        ? "is on your message, waiting on its user"
        : "is still working on your message"
      : "has yet to start on your message — it is busy with something else first";
  return `No answer yet: ${who} ${state}. To keep waiting, ${waitAgain(via, pending.id)} — as often as it takes. Or carry on with something else: if your turn ends first, its answer comes to this chat as a message when it is ready.`;
}

/** Where the answer went, for a wait that comes back after a call has it. */
const HANDED =
  "That message has been answered, and its answer was handed to an earlier wait: look back for it.";

/** What a wait is handed when the message has ended. */
function handed(ctx: ServerContext, pending: Pending, ending: Ending): string {
  return ending.outcome === "answered"
    ? `${whoIs(ctx, pending.to)} answered:\n\n${clipAnswer(ending.text)}`
    : ending.text;
}

/** An answer that landed with nobody holding for it, collected by a wait
 *  that came back for it: it leaves the sender's line, where it was
 *  waiting to go in as a message, and goes to the wait instead. */
function collect(ctx: ServerContext, pending: Pending): TalkResult {
  const queue = ctx.queues.entries.get(pending.from);
  const at = queue?.findIndex((entry) => entry.from?.answer && entry.from.letter === pending.id) ?? -1;
  if (queue && at >= 0) {
    queue.splice(at, 1);
    if (queue.length === 0) {
      ctx.queues.entries.delete(pending.from);
      ctx.queues.held.delete(pending.from);
    }
    ctx.queues.broadcastQueue(pending.from);
  }
  ctx.talk.forget(pending.id, HANDED);
  return { text: handed(ctx, pending, pending.ending!), letter: pending.id, answered: true };
}

/** A message's end: answered, failed, or taken out of the line. A call
 *  holding for it gets it; with none holding it goes to the sender's chat
 *  as a message (sendBack) — unless the sender asked for nothing back. */
function settle(ctx: ServerContext, pending: Pending, outcome: Ending["outcome"], text: string): void {
  const book = ctx.talk;
  book.mark(pending.id, outcome, outcome === "answered" ? undefined : text);
  const ending: Ending = { outcome, text };
  if (pending.waiters.size > 0) {
    const said = handed(ctx, pending, ending);
    for (const waiter of [...pending.waiters]) waiter({ text: said, answered: true });
    book.forget(pending.id, HANDED);
    return;
  }
  if (pending.reply === "none") {
    book.forget(pending.id, "You asked for no answer to that message, so none is coming.");
    return;
  }
  pending.ending = ending;
  book.keep(pending);
  sendBack(ctx, pending);
}

/** An ended message into its sender's chat, as a message of its own:
 *  now when the chat is free, else in its line — where a wait coming back
 *  for it still collects it. It leaves the book when it goes in
 *  (TalkBook.arrived), not before, so a relaunch in between loses nothing. */
function sendBack(ctx: ServerContext, pending: Pending): void {
  const ending = pending.ending;
  if (!ending || pending.reply === "none" || !ctx.store.findSession(pending.from)) {
    ctx.talk.forget(pending.id, "That message has ended, with nobody left to hand its answer to.");
    return;
  }
  const found = ctx.store.findSession(pending.to);
  // a sender still in the turn waiting on this — between two of its
  // slices, about to ask again — is not stopped for it (interruptible): it
  // waits in the line, where that next ask collects it
  deliver(ctx, pending.from, ending.outcome === "answered" ? clipAnswer(ending.text) : ending.text, {
    agent: pending.to,
    project: found?.project.name ?? "a closed project",
    title: found?.session.title ?? "",
    letter: pending.id,
    reply: "none",
    answer: true,
    depth: pending.depth,
  });
}

/** What a chat said after a prompt: its last word, or — `all` — every
 *  word, for a turn that never finished. Empty when it said nothing. */
function saidAfter(events: TranscriptEvent[], promptId: string, all = false): string {
  const at = events.findIndex((event) => event.id === promptId);
  const said = events
    .slice(at + 1)
    .flatMap((event) => (event.kind === "assistant" && event.text.trim() ? [event.text.trim()] : []));
  return all ? said.join("\n\n") : (said.at(-1) ?? "");
}

/**
 * A chat's turn ended. If a message started it, that message is answered
 * — or failed, or waits on the retry already on its way. And whatever the
 * chat itself was waiting on is released with its turn: a call still
 * holding for an answer (a curl the harness left running) is let go, and
 * the answer, when it comes, comes to the chat as a message.
 */
export function talkTurnEnded(
  ctx: ServerContext,
  channelId: string,
  event: Extract<TranscriptEvent, { kind: "result" }>,
): void {
  const book = ctx.talk;
  if (book.pending.size === 0 && book.asks.size === 0) return;
  const events = ctx.archive.events(channelId);
  const prompt = events.findLast((e) => e.kind === "user");
  const from = prompt?.kind === "user" ? prompt.from : undefined;
  const letter = from && !from.answer ? book.pending.get(from.letter) : undefined;
  if (prompt && letter && letter.to === channelId && !letter.ending) {
    const who = whoIs(ctx, channelId);
    if (event.stopped) {
      const said = saidAfter(events, prompt.id, true);
      settle(
        ctx,
        letter,
        "failed",
        `The user stopped ${who}'s turn on your message before it answered.${said ? ` What it had said by then:\n\n${clipAnswer(said)}` : ""}`,
      );
    } else if (event.ok)
      settle(ctx, letter, "answered", saidAfter(events, prompt.id) || "(it finished without a word)");
    else if (!ctx.retries.has(channelId))
      settle(
        ctx,
        letter,
        "failed",
        `${who}'s turn on your message failed: ${event.error ?? "no reason given"}.`,
      );
  }
  let released = false;
  for (const pending of book.pending.values()) {
    if (pending.from !== channelId) continue;
    for (const waiter of [...pending.waiters])
      waiter({
        text: "Your turn ended before the answer came: it will come to this chat as a message when it is ready.",
        answered: false,
      });
    if (!pending.released) {
      pending.released = true;
      released = true;
    }
  }
  if (released) book.saveLetters();
  for (const [requestId, ask] of book.asks) if (ask.from === channelId) answerTalk(ctx, requestId, false);
}

/** A message — or an answer — taken out of a chat's queue by the user
 *  before it went. A message's sender hears so; an answer the user takes
 *  out of its own chat's line is theirs to throw away. */
export function talkDropped(ctx: ServerContext, from: LetterFrom | undefined): void {
  if (!from) return;
  const pending = ctx.talk.pending.get(from.letter);
  if (!pending) return;
  if (from.answer) {
    ctx.talk.forget(
      pending.id,
      "The user took that message's answer out of this chat's queue before it went in.",
    );
    return;
  }
  settle(
    ctx,
    pending,
    "dropped",
    `The user took your message out of ${whoIs(ctx, pending.to)}'s queue before it was read.`,
  );
}

/**
 * Chats closing — one, or a whole project's. What they had sent is no
 * one's to answer to any more; what they had yet to answer is over, and
 * each sender hears so, in its waiting call or its chat. Called before
 * the chats leave the store, so they still have names to be told by.
 */
export function talkChatsClosed(ctx: ServerContext, chats: string[]): void {
  const book = ctx.talk;
  const closing = new Set(chats);
  for (const pending of [...book.pending.values()]) {
    if (!closing.has(pending.from)) continue;
    for (const waiter of [...pending.waiters]) waiter({ text: "This chat was closed.", answered: false });
    book.forget(pending.id, "The chat that sent that message was closed.");
  }
  for (const pending of [...book.pending.values()]) {
    if (!closing.has(pending.to) || pending.ending) continue;
    settle(ctx, pending, "failed", `${whoIs(ctx, pending.to)} was closed before it answered your message.`);
  }
}

/**
 * The letters left in flight when ruri last stopped. None is waited on
 * any more — whatever turn was holding for it went with the process — so
 * each goes on as if its sender had moved on: an answer that had landed
 * goes to its sender's chat; a message still in the other chat's line
 * (the queue is not kept, the letter is) goes into it again; and one the
 * other chat was working on when ruri stopped is reported to its sender
 * with whatever that turn had said — unless the turn had in fact finished,
 * when that is its answer.
 */
export function restoreTalk(ctx: ServerContext): void {
  const book = ctx.talk;
  for (const letter of book.loadLetters()) {
    const receiver = ctx.store.findSession(letter.to);
    const who = whoIs(ctx, letter.to);
    book.note({
      id: letter.id,
      from: letter.from,
      to: letter.to,
      reply: letter.reply,
      text: letter.text,
      ts: letter.ts,
      status: letter.ending?.outcome ?? letter.stage,
    });
    if (letter.ending) sendBack(ctx, letter);
    else if (!receiver) settle(ctx, letter, "failed", `${who} was closed before it answered your message.`);
    else if (letter.stage === "queued") deliver(ctx, letter.to, letter.text, letterFrom(letter));
    else {
      const events = ctx.archive.events(letter.to);
      const prompt = events.findLast((e) => e.kind === "user" && e.from?.letter === letter.id);
      const result = prompt
        ? events.slice(events.indexOf(prompt) + 1).find((e) => e.kind === "result")
        : undefined;
      if (prompt && result?.kind === "result" && result.ok)
        settle(ctx, letter, "answered", saidAfter(events, prompt.id) || "(it finished without a word)");
      else {
        const said = prompt ? saidAfter(events, prompt.id, true) : "";
        settle(
          ctx,
          letter,
          "failed",
          `ruri was restarted while ${who} was working on your message, so that turn never finished.${said ? ` What it had said by then:\n\n${clipAnswer(said)}` : ""}`,
        );
      }
    }
  }
}

/** How long one HTTP call waits on an answer for this chat: by the harness
 *  it runs on, whose shell cuts off a command that blocks too long. */
export function httpWaitFor(ctx: ServerContext, channelId: string): number {
  const model = channelProject(ctx, channelId)?.model || ctx.store.defaultModel();
  return httpWaitMs(ctx.models.registry.parse(model).providerId);
}

/** The tools' way into all of this. */
export function talkHost(ctx: ServerContext): TalkHost {
  return {
    list: (channelId) => listSeats(ctx, channelId),
    send: async (channelId, args, signal) =>
      (await sendLetter(ctx, channelId, args, { via: "tool", ...(signal ? { signal } : {}) })).text,
    wait: async (channelId, letter, signal) =>
      (await waitAnswer(ctx, channelId, letter, { via: "tool", ...(signal ? { signal } : {}) })).text,
  };
}

/** Everyone looking hears who may message whom, and the latest. */
export function pushTalk(ctx: ServerContext): void {
  ctx.clients.broadcast({ type: "talk", policy: ctx.talk.policy(), letters: ctx.talk.letters() });
}

export const talkHandlers = {
  talk_get: (ctx, ws) => {
    ws.send(
      JSON.stringify({
        type: "talk",
        policy: ctx.talk.policy(),
        letters: ctx.talk.letters(),
      } satisfies ServerMessage),
    );
  },
  talk_set: (ctx, _ws, msg) => {
    ctx.talk.setPolicy(msg.policy);
  },
} satisfies Partial<Handlers>;
