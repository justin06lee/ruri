/**
 * Agents talking to agents, run against the live server (the rules, the
 * words and the book are server/talk.ts): who a chat may message, a
 * message sent — held to the user's rules, asked about outside bypass
 * mode, delivered into the other chat's line — and the answer taken from
 * that chat's turn when it ends and carried back. Plus the talk page's
 * two messages.
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
import { dispatch } from "../dispatch.js";
import {
  clipAnswer,
  MAX_DEPTH,
  mayMessage,
  seatName,
  WAIT_MS,
  type Pending,
  type TalkHost,
} from "../talk.js";
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

/** Into a chat's line: now if it is free, else behind what it is doing
 *  and whatever the user has queued ahead of it. */
function deliver(ctx: ServerContext, chat: string, text: string, from: LetterFrom): "queued" | "working" {
  if (running(ctx, chat) || ctx.queues.pending(chat) > 0) {
    const queue = ctx.queues.entries.get(chat) ?? [];
    queue.push({ id: randomUUID(), text, uploads: [], silent: false, from });
    ctx.queues.entries.set(chat, queue);
    ctx.queues.broadcastQueue(chat);
    return "queued";
  }
  dispatch(ctx, chat, text, [], false, from);
  return "working";
}

/** One message from a chat's model: held to the rules, asked about,
 *  delivered, and — when it waits — answered. */
export async function sendLetter(
  ctx: ServerContext,
  channelId: string,
  args: { to: string; message: string; reply?: TalkReply },
): Promise<string> {
  const me = ctx.store.findSession(channelId);
  if (!me) return "Only a chat in a project can message other agents.";
  const text = args.message.trim();
  if (!text) return "The message is empty: say something.";
  const found = findSeat(ctx, args.to, channelId);
  if (typeof found === "string") return found;
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
    return `The user has not let you message ${toName}: their talk settings say who you may message. list_agents shows who you can.`;
  }
  const depth = depthOf(ctx, channelId) + 1;
  if (depth > MAX_DEPTH) {
    book.note({ ...base, status: "refused", note: `${MAX_DEPTH} agents deep` });
    return `This has gone ${MAX_DEPTH} agents deep since the user last spoke. Stop passing it on: finish your turn with what you have.`;
  }
  if (reply === "wait" && book.waitsOn(target, channelId)) {
    book.note({ ...base, status: "refused", note: "it is waiting on this chat" });
    return `${toName} is waiting on your answer right now, so waiting on it in turn would hold you both for good. Answer it by finishing your turn (your last message goes back to it), or send this with reply "later".`;
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
      return `The user did not let that message go to ${toName}.`;
    }
    if (!ctx.store.findSession(target)) {
      book.mark(id, "failed", "closed before it went");
      return `${toName} was closed before the message could go.`;
    }
  }

  const from: LetterFrom = {
    agent: channelId,
    project: me.project.name,
    title: me.session.title ?? "",
    letter: id,
    reply,
    depth,
  };
  const pending: Pending = { id, from: channelId, to: target, reply, depth };
  book.pending.set(id, pending);
  const where = deliver(ctx, target, text, from);
  book.note({ ...base, status: where });
  const queued = where === "queued" ? ", queued behind what it is doing" : "";
  if (reply === "none") return `Sent to ${toName}${queued}. No answer was asked for.`;
  if (reply === "later")
    return `Sent to ${toName}${queued}. Its answer will come to this chat as a message when it has finished — carry on meanwhile.`;
  return new Promise<string>((resolve) => {
    pending.resolve = resolve;
    pending.timer = setTimeout(() => {
      if (!pending.resolve) return;
      pending.resolve = undefined;
      pending.reply = "later";
      resolve(
        `No answer from ${toName} after twenty minutes: it is still at it. Its answer will come to this chat as a message when it has finished — carry on meanwhile.`,
      );
    }, WAIT_MS);
    pending.timer.unref?.();
  });
}

/** A message's end: answered, failed, or taken out of the line. The
 *  sender hears it the way it asked to — in its waiting call, or in its
 *  chat — or not at all. */
function settle(
  ctx: ServerContext,
  pending: Pending,
  outcome: "answered" | "failed" | "dropped",
  text: string,
): void {
  const book = ctx.talk;
  book.pending.delete(pending.id);
  clearTimeout(pending.timer);
  book.mark(pending.id, outcome, outcome === "answered" ? undefined : text);
  const found = ctx.store.findSession(pending.to);
  const who = found ? seatName(found.project.name, found.session.title ?? "") : "that agent";
  const said = outcome === "answered" ? clipAnswer(text) : text;
  if (pending.resolve) {
    const resolve = pending.resolve;
    pending.resolve = undefined;
    resolve(outcome === "answered" ? `${who} answered:\n\n${said}` : said);
    return;
  }
  if (pending.reply !== "later" || !ctx.store.findSession(pending.from) || !found) return;
  deliver(ctx, pending.from, said, {
    agent: pending.to,
    project: found.project.name,
    title: found.session.title ?? "",
    letter: pending.id,
    reply: "none",
    answer: true,
    depth: pending.depth,
  });
}

/** The last thing a chat said after a prompt. */
function lastSaid(events: TranscriptEvent[], promptId: string): string {
  const at = events.findIndex((event) => event.id === promptId);
  const said = events.slice(at + 1).findLast((event) => event.kind === "assistant");
  return said?.kind === "assistant" && said.text.trim() ? said.text.trim() : "(it finished without a word)";
}

/**
 * A chat's turn ended. If a message started it, that message is answered
 * — or failed, or waits on the retry already on its way. And whatever the
 * chat itself was waiting on or asking about is over with its turn: the
 * tool call that was waiting has gone, so the answer stays where it lands.
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
  if (prompt && letter && letter.to === channelId) {
    const found = ctx.store.findSession(channelId);
    const who = found ? seatName(found.project.name, found.session.title ?? "") : "that agent";
    if (event.stopped)
      settle(ctx, letter, "failed", `The user stopped ${who}'s turn on your message before it answered.`);
    else if (event.ok) settle(ctx, letter, "answered", lastSaid(events, prompt.id));
    else if (!ctx.retries.has(channelId))
      settle(
        ctx,
        letter,
        "failed",
        `${who}'s turn on your message failed: ${event.error ?? "no reason given"}.`,
      );
  }
  for (const pending of book.pending.values()) {
    if (pending.from !== channelId || !pending.resolve) continue;
    clearTimeout(pending.timer);
    pending.resolve = undefined;
    pending.reply = "none";
  }
  for (const [requestId, ask] of book.asks) if (ask.from === channelId) answerTalk(ctx, requestId, false);
}

/** A message taken out of a chat's queue by the user before it went. */
export function talkDropped(ctx: ServerContext, from: LetterFrom | undefined): void {
  if (!from || from.answer) return;
  const pending = ctx.talk.pending.get(from.letter);
  if (!pending) return;
  const found = ctx.store.findSession(pending.to);
  const who = found ? seatName(found.project.name, found.session.title ?? "") : "that agent";
  settle(ctx, pending, "dropped", `The user took your message out of ${who}'s queue before it was read.`);
}

/** The tools' way into all of this. */
export function talkHost(ctx: ServerContext): TalkHost {
  return {
    list: (channelId) => listSeats(ctx, channelId),
    send: (channelId, args) => sendLetter(ctx, channelId, args),
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
