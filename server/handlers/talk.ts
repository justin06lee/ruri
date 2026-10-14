/**
 * Agents talking to agents, run against the live server (the rules, the
 * words and the book are server/talk.ts): who a chat may message, a
 * message sent — held to the user's rules, asked about outside bypass
 * mode, delivered into the other chat's line — and the answer taken from
 * that chat's turn when it ends and carried back: to the call waiting on
 * it, or, with none waiting, to the sender's chat as a message. Plus the
 * letters a relaunch finds in flight, and the talk page's two messages —
 * and a job an agent hands to another project.
 *
 * Another project is reached through its liaison (server/team.ts): a
 * message to it — by its name, its liaison's handle, or its lead's — lands
 * there, never at the lead the user talks to, and the liaison is made the
 * first time one does.
 *
 * A lead or a liaison hands its jobs on. A message it is answering is
 * answered when the job is done: by the turn it started when that turn
 * sent nothing on; otherwise by the turn the last answer to what it sent
 * on starts (Pending.for, LetterFrom.owes) — the turn handing it on ends
 * with the sender still waiting, and the lead stays free.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_PERMISSION_MODE,
  leadOf,
  liaisonOf,
  type LetterFrom,
  type PermissionRequest,
  type Project,
  type ServerMessage,
  type SessionInfo,
  type TalkAsk,
  type TalkDelivery,
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
  relayPrompt,
  resumePrompt,
  seatName,
  WAIT_MS,
  type Ending,
  type Pending,
  type ProjectAsk,
  type TalkHost,
} from "../talk.js";
import { expandPath } from "../projects.js";
import type { QueueEntry } from "../queue.js";
import { createManagerHost } from "./projects.js";
import {
  hasSlot,
  headOf,
  isMemberChat,
  noteStarting,
  pushTeamOf,
  releaseWaiting,
  unattended,
  waitForSlot,
} from "./team.js";
import type { Handlers } from "./types.js";

interface Found {
  project: Project;
  session: SessionInfo;
  /** Another project's way in: its liaison — or, until one is made, its
   *  lead standing in for it. A message to it goes to the liaison. */
  door?: boolean;
}

/** Who a chat can reach: the rest of its own project's team — its lead,
 *  its liaison, its members — and every other project, through its door. */
function seats(ctx: ServerContext, self: string): Found[] {
  return ctx.store.list().flatMap((project) => {
    const mine = project.sessions.some((session) => session.id === self);
    if (mine)
      return project.sessions
        .filter((session) => session.id !== self)
        .map((session) => ({ project, session }));
    const door = liaisonOf(project) ?? leadOf(project);
    return door ? [{ project, session: door, door: true }] : [];
  });
}

function nameOf(seat: Found): string {
  return seat.door ? `${seat.project.name}'s liaison` : seatName(seat.project.name, seat.session.title ?? "");
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
  const handle = want.toLowerCase();
  const byHandle = all.find((seat) => ctx.talk.handleOf(seat.session.id) === handle);
  if (byHandle) return byHandle;
  // another project's lead, by the handle it went by before its liaison
  // was made: its door
  const byLead = all.find(
    (seat) => seat.door && ctx.talk.handleOf(leadOf(seat.project)?.id ?? "") === handle,
  );
  if (byLead) return byLead;
  const key = plain(want);
  const named = all.filter((seat) => {
    const title = plain(seat.session.title ?? "");
    const project = plain(seat.project.name);
    return (
      (title !== "" && (key === title || key === `${project} ${title}`)) ||
      // a project by its name alone is its door — or, from inside it, its lead
      (key === project && (seat.door === true || leadOf(seat.project)?.id === seat.session.id))
    );
  });
  if (named.length === 1) return named[0]!;
  // a teammate by the layer it holds
  const layered = all.filter((seat) => !seat.door && seat.session.layers?.includes(handle));
  if (named.length === 0 && layered.length === 1) return layered[0]!;
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
/** How long, in the fewest words: "40s", "12m", "3h 05m". */
function span(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Words on one line, cut to fit. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * What a chat is doing right now, for an agent deciding whether a message
 * is worth interrupting it for: idle, or working — for how long, on what
 * (the prompt, or whose message it is answering), the tool it is running —
 * waiting on an answer of its own, waiting on the user; and how many
 * prompts are queued behind it.
 */
export function doing(ctx: ServerContext, chat: string): string {
  const status = ctx.manager.statuses()[chat];
  const queued = ctx.queues.pending(chat);
  const behind = queued > 0 ? ` · ${queued} queued behind it` : "";
  if (ctx.governor.waiting.includes(chat))
    return `asleep, with ${queued} waiting on a free slot — as many teammates are at work as RURI_TEAM_MAX allows`;
  if (status === "permission") return `waiting on the user to answer a card${behind}`;
  if (status !== "working") {
    const rest = unattended(ctx, chat) && !ctx.manager.live(chat) ? "asleep" : "idle";
    return `${ctx.turns.work.has(chat) ? `${rest}, with agents of its own still working` : rest}${behind}`;
  }
  const events = ctx.archive.events(chat);
  const start = events.findLastIndex((event) => event.kind === "user");
  const prompt = events[start];
  const tool = events.slice(start + 1).findLast((event) => event.kind === "tool");
  const since = ctx.turns.progress.get(chat)?.startedAt;
  const parts = [`working${since ? ` for ${span(Date.now() - since)}` : ""}`];
  if (prompt?.kind === "user") {
    const from = prompt.from;
    if (from && !from.answer) {
      const who = seatName(from.project, from.title);
      parts.push(from.reply === "none" ? `on a job for ${who}` : `answering ${who}`);
    } else parts.push(`on "${clip(prompt.text, 90)}"`);
  }
  if (tool?.kind === "tool") parts.push(`running ${tool.name}: ${clip(tool.summary, 70)}`);
  if (ctx.talk.awaiting(chat)) parts.push("waiting on an answer from another agent");
  return `${parts.join(" — ")}${behind}`;
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
      ? `${barred} other ${barred === 1 ? "project is" : "projects are"} off limits to you by the user's talk settings.`
      : "";
  if (open.length === 0) {
    return offLimits
      ? `There is no one you may message right now: ${offLimits}`
      : "There is no one to message: no teammates yet, and no other project open in ruri.";
  }
  const lines: string[] = ["Agents you may message — handle, chat, model, what it is doing right now:"];
  for (const project of ctx.store.list()) {
    const mine = project.id === me.project.id;
    const lead = leadOf(project)?.id;
    const here = open.filter((seat) => seat.project.id === project.id);
    if (here.length === 0 && !mine) continue;
    lines.push("", `${project.name}${mine ? " (your project, your team)" : ""} — ${project.path}`);
    for (const seat of here) {
      const model = channelProject(ctx, seat.session.id)?.model || ctx.store.defaultModel();
      if (seat.door) {
        // its liaison, or — not made yet — the lead's handle standing in
        const made = seat.session.liaison === true;
        lines.push(
          `  ${ctx.talk.handleOf(seat.session.id)}  its liaison — the lead that takes other projects' messages and hands them to its team · ${
            made ? `${model} — ${doing(ctx, seat.session.id)}` : "made when you first write"
          }`,
        );
        continue;
      }
      const role =
        seat.session.id === lead
          ? "the lead — the user's chat here"
          : seat.session.liaison
            ? "the liaison — takes other projects' messages and hands them to this team"
            : `${seat.session.title || "untitled"}${seat.session.duty ? ` (duty: ${seat.session.duty})` : ""}${
                seat.session.layers?.length ? ` [${seat.session.layers.join(", ")}]` : ""
              }`;
      lines.push(
        `  ${ctx.talk.handleOf(seat.session.id)}  ${role} · ${model} — ${doing(ctx, seat.session.id)}`,
      );
    }
    if (here.length === 0) lines.push("  (no one else on the team yet)");
  }
  lines.push(
    "",
    'A message interrupts an agent that is working unless you send it with delivery "queue"; one asleep wakes for it. ask_project (or {"do": "project"}) hands a job to another project, through its liaison — or to a folder, by its path, opened as a project first.',
  );
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
  return uninterruptible(ctx, chat) === undefined;
}

/**
 * The message a chat's current turn owes an answer to: the one that
 * started it, or the one it carries on with after compacting itself — or,
 * for a turn an answer started, the one the chat sent that message on
 * behalf of (LetterFrom.owes). Nothing when the turn owes no one.
 */
export function owedLetter(ctx: ServerContext, chat: string): Pending | undefined {
  const turn = ctx.archive.events(chat).findLast((event) => event.kind === "user");
  const from = turn?.kind === "user" ? turn.from : undefined;
  const id = !from ? undefined : from.answer ? from.owes : from.letter;
  const letter = id ? ctx.talk.pending.get(id) : undefined;
  return letter && letter.to === chat && !letter.ending ? letter : undefined;
}

/** Who sent a letter, by name. */
function senderOf(letter: Pending): string {
  return letter.sender ? seatName(letter.sender.project, letter.sender.title) : "another agent";
}

/** Why the turn a chat is running can't be stopped for a message, in the
 *  sender's words — or nothing, when it can. */
function uninterruptible(ctx: ServerContext, chat: string): string | undefined {
  if (ctx.manager.statuses()[chat] === "permission") return "it is waiting on the user";
  if (ctx.talk.awaiting(chat)) return "it is waiting on an answer of its own";
  const owed = owedLetter(ctx, chat);
  if (owed && owed.reply !== "none") return `it is answering ${senderOf(owed)}, who is waiting on it`;
  return undefined;
}

/** The tool call a stop of the running turn cuts off — the last the turn
 *  started, as its chip reads ("Bash: npm test") — if it started any. */
export function cutOff(ctx: ServerContext, chat: string): string | undefined {
  const events = ctx.archive.events(chat);
  const start = events.findLastIndex((event) => event.kind === "user");
  const tool = events.slice(start + 1).findLast((event) => event.kind === "tool");
  return tool?.kind === "tool" ? `${tool.name}: ${tool.summary}` : undefined;
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
  delivery: TalkDelivery = "interrupt",
): "queued" | "working" | "cut in" | "waiting" {
  // nobody stands at a member's or the liaison's line to send a held one
  // on by hand, so a hold left by a stop lets go here
  if (unattended(ctx, chat) && !running(ctx, chat)) ctx.queues.releaseQueue(chat);
  // a member asleep wakes for it — unless RURI_TEAM_MAX is set and that
  // many are at work: then it waits in its line for a slot (server/team.ts)
  if (isMemberChat(ctx, chat) && !running(ctx, chat)) {
    ctx.queues.releaseQueue(chat);
    const entry: QueueEntry = { id: randomUUID(), text, uploads: [], silent: false, from };
    const ahead = ctx.queues.pending(chat);
    if (ahead > 0 || !hasSlot(ctx, chat)) {
      waitForSlot(ctx, chat, entry);
      releaseWaiting(ctx);
      if (ctx.governor.waiting.includes(chat)) return "waiting";
      return ahead > 0 ? "queued" : "working";
    }
    noteStarting(ctx, chat);
    dispatch(ctx, chat, text, [], false, from);
    return "working";
  }
  // a chat already stopping for something that cut in takes this straight
  // behind it rather than behind the user's queue; a sender who asked to
  // queue is never let past the turn it is on
  const cut =
    delivery === "interrupt" &&
    (ctx.queues.cutIn.has(chat) || (running(ctx, chat) && interruptible(ctx, chat)));
  if (cut) {
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
            text: resumePrompt(seatName(from.project, from.title), cutOff(ctx, chat)),
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
  args: {
    to: string;
    message: string;
    reply?: TalkReply;
    delivery?: TalkDelivery;
    /** The user has already let this one go — on ask_project's card, with
     *  the folder it opened for it. */
    approved?: boolean;
  },
  opts: WaitOptions = {},
): Promise<TalkResult> {
  const me = ctx.store.findSession(channelId);
  if (!me) return { text: "Only a chat in a project can message other agents." };
  const text = args.message.trim();
  if (!text) return { text: "The message is empty: say something." };
  const found = findSeat(ctx, args.to, channelId);
  if (typeof found === "string") return { text: found };
  // another project's door is its liaison: the one it has, for now — made
  // only once the message may go
  const door = found.door === true;
  const had = door ? liaisonOf(found.project) : found.session;
  let target = had?.id ?? "";
  const toName = nameOf(found);
  // a lead — or the liaison — hands jobs on and stays free: what it sends
  // comes back "later", whatever it asked for
  const head = headOf(ctx, channelId) !== undefined;
  const reply: TalkReply = head ? (args.reply === "none" ? "none" : "later") : (args.reply ?? "wait");
  const book = ctx.talk;
  const id = randomUUID();
  const base = { id, from: channelId, to: target || found.session.id, reply, text, ts: Date.now() };

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
  if (reply === "wait" && target && book.waitsOn(target, channelId)) {
    book.note({ ...base, status: "refused", note: "it is waiting on this chat" });
    return {
      text: `${toName} is waiting on your answer right now, so waiting on it in turn would hold you both for good. Answer it by finishing your turn (your last message goes back to it), or send this with reply "later".`,
    };
  }

  // outside bypass mode, every message waits on the user
  const mode = channelProject(ctx, channelId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  if (mode !== "bypassPermissions" && !args.approved) {
    book.note({ ...base, status: "asking" });
    const allowed = await askUser(ctx, channelId, {
      to: target || found.session.id,
      project: found.project.name,
      // another project, through its liaison, is the project on the card
      title: door ? "" : (found.session.title ?? ""),
      text,
      reply,
    });
    if (!allowed) {
      book.mark(id, "denied");
      return { text: `The user did not let that message go to ${toName}.` };
    }
    if (door ? !ctx.store.get(found.project.id) : !ctx.store.findSession(target)) {
      book.mark(id, "failed", "closed before it went");
      return { text: `${toName} was closed before the message could go.` };
    }
  }
  if (door && !target) {
    // the first agent from another project to write: its liaison is made
    target = ctx.store.liaison(found.project.id)?.id ?? "";
    if (!target) return { text: `Couldn't reach ${toName}.` };
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  }

  // in the book, and on disk, before it goes: whatever happens next —
  // this call cut off, the turn stopped, ruri quitting — it is accounted for
  // sent on behalf of a message this chat's turn owes an answer to: that
  // one waits for this one's answer to come back
  const owes = reply === "none" ? undefined : owedLetter(ctx, channelId)?.id;
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
    ...(owes ? { for: owes } : {}),
    waiters: new Set(),
  };
  book.keep(pending);
  const delivery = args.delivery ?? "interrupt";
  const busyWith = running(ctx, target) ? uninterruptible(ctx, target) : undefined;
  const where = deliver(ctx, target, text, letterFrom(pending), delivery);
  // the team page shows the liaison's letters, both ways
  pushTeamOf(ctx, target);
  pushTeamOf(ctx, channelId);
  // a cut-in waits at the head of the line for the turn it stopped to end:
  // queued, for the moment it takes, and working from when it goes
  book.note({ ...base, to: target, status: where === "cut in" || where === "waiting" ? "queued" : where });
  const queued =
    where === "cut in"
      ? ", which has stopped what it was doing to read it"
      : where === "waiting"
        ? `, which is waiting for a free slot: as many teammates are at work as RURI_TEAM_MAX allows, and it starts the moment one finishes`
        : where !== "queued"
          ? ""
          : delivery === "queue"
            ? ", queued behind what it is doing, as you asked"
            : busyWith
              ? `, queued behind what it is doing — it could not be interrupted: ${busyWith}`
              : ", queued behind what it is doing";
  if (reply === "none")
    return {
      text: `Sent to ${toName}${queued}. You asked for no answer: it has been told nobody is waiting on it, and nothing will come back.`,
      letter: id,
    };
  if (reply === "later" && head)
    return {
      text: `Sent to ${toName}${queued}. Its answer comes to this chat as a message when the job is done${
        args.reply === "wait" ? ' (a lead\'s hand-offs always come back "later", so it stays free)' : ""
      } — hand out the rest of the work, then end your turn.`,
      letter: id,
      answered: false,
    };
  if (reply === "later")
    return {
      text: `Sent to ${toName}${queued}. Its answer will come to this chat as a message when it has finished — carry on meanwhile. (To wait on it after all, ${waitAgain(opts.via, id)}.)`,
      letter: id,
      answered: false,
    };
  return waitOn(ctx, pending, opts);
}

/** A model from the catalog, by its id or its name — or why not. */
export function modelFor(ctx: ServerContext, asked: string): { value: string; name: string } | string {
  const want = asked.trim().toLowerCase();
  const models = ctx.models.allModels();
  const hit =
    models.find((m) => m.value.toLowerCase() === want) ??
    models.find((m) => m.displayName.toLowerCase() === want) ??
    models.find(
      (m) => m.value.toLowerCase().endsWith(`:${want}`) || m.value.toLowerCase().endsWith(`/${want}`),
    );
  if (hit) return { value: hit.value, name: hit.displayName };
  const some = models.slice(0, 16).map((m) => `${m.displayName} (${m.value})`);
  return `No model "${asked}" in ruri's catalog. Some that are: ${some.join(", ")}.`;
}

/**
 * An agent hands a job to another project (ask_project, {"do": "project"}):
 * its liaison gets it, as a message, and hands it on to its team the way
 * the lead would one from the user. A project is a team with one chat the
 * outside talks to — its liaison, made the first time one writes; within
 * the sender's own project the team is already there to message.
 *
 * The project is one open in ruri, by its name, or a folder by its path,
 * opened as a project the way Home opens one — its lead new with it. The
 * user's rules hold as for any message — a project not open yet is
 * reachable only by a sender allowed to message anyone — and outside
 * bypass mode one card asks for both the folder and the message. Then the
 * message goes the way any other does (sendLetter), and its answer comes
 * back the same way.
 */
export async function askProject(
  ctx: ServerContext,
  channelId: string,
  args: ProjectAsk,
  opts: WaitOptions = {},
): Promise<TalkResult> {
  const me = ctx.store.findSession(channelId);
  if (!me) return { text: "Only a chat in a project can hand jobs to other projects." };
  const text = args.message.trim();
  if (!text) return { text: "The message is empty: say what the other project should do." };
  const query = args.project.trim();
  const open = ctx.store.findByQuery(query);
  const dir = open ? open.path : expandPath(query, ctx.store.workspaceDir());
  if (open?.id === me.project.id) {
    return {
      text: headOf(ctx, channelId)
        ? `${open.name} is your own project: hand the job to a teammate with message_agent (team shows who), or add one with add_teammate when no one holds its layer.`
        : `${open.name} is your own project: message the teammate whose part it is (list_agents shows the team), or ask whoever handed you the job.`,
    };
  }
  if (!open) {
    if (!/[/~]/.test(query)) {
      return {
        text: `No project called "${query}" is open in ruri. list_agents shows the open ones; to open a folder, give its path.`,
      };
    }
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      return { text: `There is no folder at ${dir}.` };
  }
  const where = open ? open.name : `${path.basename(dir)} (${dir})`;
  if (
    !mayMessage(
      ctx.talk.policy(),
      { chat: channelId, project: me.project.id },
      { chat: "", project: open?.id ?? "" },
    )
  ) {
    return {
      text: `The user has not let you message ${where}: their talk settings say who you may message. list_agents shows where you can.`,
    };
  }
  const reply: TalkReply = headOf(ctx, channelId)
    ? args.reply === "none"
      ? "none"
      : "later"
    : (args.reply ?? "wait");

  // outside bypass mode, a folder not open yet is asked about with the
  // message, on one card; an open project's lead is asked about the way
  // any message is (sendLetter)
  const mode = channelProject(ctx, channelId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
  let approved = false;
  if (!open && mode !== "bypassPermissions") {
    const allowed = await askUser(ctx, channelId, {
      to: "",
      project: `${path.basename(dir)} — ${dir}, not open yet`,
      title: "",
      text,
      reply,
      opening: true,
    });
    if (!allowed) return { text: `The user did not let you open ${where}.` };
    approved = true;
  }

  // the project — opened now when it wasn't, its lead new with it
  let project = open;
  if (!project) {
    const said = createManagerHost(ctx).openProject({ path: dir });
    project = ctx.store.findByPath(dir);
    if (!project) return { text: `Couldn't open ${dir}: ${said}` };
  }
  // its door: the liaison it has, or its lead's handle, which reaches the
  // liaison made for this message
  const door = liaisonOf(project) ?? leadOf(project);
  if (!door) return { text: `Couldn't reach ${project.name}.` };
  const sent = await sendLetter(
    ctx,
    channelId,
    { to: ctx.talk.handleOf(door.id), message: text, ...(args.reply ? { reply: args.reply } : {}), approved },
    opts,
  );
  const liaison = liaisonOf(project);
  return {
    ...sent,
    text: `${open ? "" : `Opened ${project.name}. `}Handed to ${project.name}'s liaison${
      liaison ? ` — handle ${ctx.talk.handleOf(liaison.id)}, for messaging it again` : ""
    }. ${sent.text}`,
  };
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
  const state = ctx.talk.outstanding(pending.id)
    ? "has handed your message on to its team, and answers when what it is waiting on comes back"
    : pending.stage === "working"
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
  const said = handed(ctx, pending, pending.ending!);
  answerOnward(ctx, pending, { taken: said });
  return { text: said, letter: pending.id, answered: true };
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
    answerOnward(ctx, pending, { taken: said });
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

/** Whether something in a chat's line will start a turn on a message it
 *  owes: the carried continuation of it, or an answer sent back for it —
 *  other than the answer to `except`, the one on its way out. */
function queuedFor(ctx: ServerContext, chat: string, letterId: string, except: string): boolean {
  return (ctx.queues.entries.get(chat) ?? []).some((entry) =>
    entry.from?.answer
      ? entry.from.owes === letterId && entry.from.letter !== except
      : entry.from?.letter === letterId,
  );
}

/**
 * A letter sent on behalf of another (Pending.for) is in its sender's
 * hands some way other than as a prompt of its own — taken by a wait in a
 * turn on something else, or taken out of its line by the user — so the
 * turn that would have answered the message it was sent for will not come.
 * Unless another will (one on that message is running, something in the
 * line starts one, or more answers for it are still to come back), that
 * message is seen to here: an answer taken elsewhere sends the chat back
 * to answer it, with a prompt of ruri's carrying it, the way a compaction
 * does; one taken out of its line ends it, saying why.
 */
function answerOnward(ctx: ServerContext, sub: Pending, how: { taken: string } | { dropped: true }): void {
  const owed = sub.for ? ctx.talk.pending.get(sub.for) : undefined;
  if (!owed || owed.ending || owed.to !== sub.from) return;
  const chat = sub.from;
  if (running(ctx, chat) && owedLetter(ctx, chat)?.id === owed.id) return;
  if (queuedFor(ctx, chat, owed.id, sub.id) || ctx.talk.outstanding(owed.id)) return;
  // nobody is waiting on it: it is done with, without a turn to say so
  if (owed.reply === "none") {
    settle(ctx, owed, "answered", "");
    return;
  }
  if ("dropped" in how) {
    settle(
      ctx,
      owed,
      "failed",
      `${whoIs(ctx, chat)} handed your message on, and the answer it was waiting for was taken out of its queue by the user before it could pass it on.`,
    );
    return;
  }
  // behind whatever it is doing — the turn that took the answer is still
  // running, and is never stopped for this
  deliver(ctx, chat, relayPrompt(senderOf(owed), how.taken), { ...letterFrom(owed), carried: true }, "queue");
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
    // the message the sender sent this one for: the turn this answer
    // starts may be the one that answers it
    ...(pending.for ? { owes: pending.for } : {}),
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
 * A chat's turn ended. If it owes a message an answer (owedLetter), that
 * message is answered — or failed, or waits on the retry already on its
 * way; or, when the turn handed the job on and answers are still to come
 * back for it, waits for the turn the last of them starts; or, when the
 * chat compacted itself mid-job (carryLetter, from the result branch in
 * server/chats.ts), for the turn that carries it on in the fresh session.
 * And whatever the chat itself was waiting on is released with its turn:
 * a call still holding for an answer (a curl the harness left running) is
 * let go, and the answer, when it comes, comes to the chat as a message.
 */
export function talkTurnEnded(
  ctx: ServerContext,
  channelId: string,
  event: Extract<TranscriptEvent, { kind: "result" }>,
): void {
  const book = ctx.talk;
  const stopper = book.stoppedBy.get(channelId);
  book.stoppedBy.delete(channelId);
  if (book.pending.size === 0 && book.asks.size === 0) return;
  const events = ctx.archive.events(channelId);
  const prompt = events.findLast((e) => e.kind === "user");
  const letter = owedLetter(ctx, channelId);
  const carriedFrom = letter ? book.carried.get(letter.id) : undefined;
  if (letter) book.carried.delete(letter.id);
  if (prompt && letter && carriedFrom === prompt.id) {
    // the chat compacted itself mid-job: the turn carrying it on answers
  } else if (prompt && letter) {
    const who = whoIs(ctx, channelId);
    if (event.stopped) {
      const said = saidAfter(events, prompt.id, true);
      settle(
        ctx,
        letter,
        "failed",
        `${stopper ? stopper[0]!.toUpperCase() + stopper.slice(1) : "The user"} stopped ${who}'s turn on your message before it answered.${said ? ` What it had said by then:\n\n${clipAnswer(said)}` : ""}`,
      );
    } else if (event.ok) {
      // handed on, with answers still to come back: the turn the last of
      // them starts is the one that answers
      if (!book.outstanding(letter.id))
        settle(ctx, letter, "answered", saidAfter(events, prompt.id) || "(it finished without a word)");
    } else if (!ctx.retries.has(channelId))
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

/**
 * A chat compacting itself in the middle of a job (server/chats.ts's
 * compaction tool): the message its turn owes an answer to is carried
 * over — this turn's end doesn't answer it — and what comes back is the
 * `from` for the prompt that carries the chat on in its fresh session, as
 * a QueueEntry's or dispatch's. That turn's last words, when the job is
 * done, are the answer, however many times it compacts on the way.
 * Nothing when the turn owes no one: carry on with a plain prompt.
 */
export function carryLetter(ctx: ServerContext, chat: string): LetterFrom | undefined {
  const letter = owedLetter(ctx, chat);
  const prompt = ctx.archive.events(chat).findLast((event) => event.kind === "user");
  if (!letter || !prompt) return undefined;
  ctx.talk.carried.set(letter.id, prompt.id);
  return { ...letterFrom(letter), carried: true };
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
    // an answer this chat was to pass on to whoever it asked for
    answerOnward(ctx, pending, { dropped: true });
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
 * A chat's turn cut off by closing its process — a lead restarting a
 * stuck member, or clearing it — which never says it ended: a message it
 * was working on ends here, with whatever it had said by then.
 */
export function talkTurnCut(ctx: ServerContext, chat: string, why: string): void {
  const events = ctx.archive.events(chat);
  const prompt = events.findLast((e) => e.kind === "user");
  const letter = owedLetter(ctx, chat);
  if (!prompt || !letter) return;
  ctx.talk.carried.delete(letter.id);
  const said = saidAfter(events, prompt.id, true);
  settle(ctx, letter, "failed", `${why}${said ? ` What it had said by then:\n\n${clipAnswer(said)}` : ""}`);
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
    // handed on, and what it was handed to is still out: answered when
    // that comes back, the way it would have been
    else if (book.outstanding(letter.id)) continue;
    else {
      const events = ctx.archive.events(letter.to);
      // the last turn on it: the one it started, one carrying it on after a
      // compaction, or one an answer for it started
      const prompt = events.findLast(
        (e) =>
          e.kind === "user" && (e.from?.answer ? e.from.owes === letter.id : e.from?.letter === letter.id),
      );
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
    ask: async (channelId, args, signal) =>
      (await askProject(ctx, channelId, args, { via: "tool", ...(signal ? { signal } : {}) })).text,
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
