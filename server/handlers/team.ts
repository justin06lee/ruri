/**
 * A project's team, run against the live server (the cap, the words and
 * the tools are server/team.ts): who is at work and who is waiting on a
 * slot, the roster the leads read and the team page shows, and what the
 * lead or the liaison — or the user, from the team page — can do to a
 * member: add one, change its duty, stop, compact, refresh or restart it,
 * retire it.
 */
import {
  leadOf,
  liaisonOf,
  type MemberState,
  type Project,
  type ServerMessage,
  type SessionInfo,
  type StackLayer,
  type TeamAction,
  type TeamBudget,
  type TeamMember,
} from "../../shared/protocol.js";
import { channelProject, running } from "../channel.js";
import type { ServerContext } from "../context.js";
import { compactChannel, drainQueue, stopTurn } from "../dispatch.js";
import type { QueueEntry } from "../queue.js";
import type { AddArgs, Head, TeamHost } from "../team.js";
import { closeMember } from "./projects.js";
import { doing, modelFor, sendLetter, talkTurnCut, type WaitOptions } from "./talk.js";
import type { Handlers } from "./types.js";

/** The most members one project's team may have: one per layer, with
 *  room to spare for a stack that grows. */
export const MAX_MEMBERS = 32;

/** How long a member a slot was just handed to counts as at work before
 *  its turn has said so — the send is a microtask away. */
const STARTING_MS = 10_000;

/** How often members waiting on a slot are looked at again. */
const RECHECK_MS = 15_000;

/** Whether a chat is a member of its project's team — not a lead, not the
 *  liaison, not Home. */
export function isMemberChat(ctx: ServerContext, chat: string): boolean {
  return ctx.store.isMember(chat);
}

/** Whether nobody stands at a chat's line — a member, or the liaison —
 *  so nobody sends a held one on by hand. */
export function unattended(ctx: ServerContext, chat: string): boolean {
  return ctx.store.isMember(chat) || ctx.store.findSession(chat)?.session.liaison === true;
}

/** Whether a chat is one of its project's two leads, and which. */
export function headOf(ctx: ServerContext, chat: string): { project: Project; head: Head } | undefined {
  const found = ctx.store.findSession(chat);
  if (!found) return undefined;
  if (found.session.liaison) return { project: found.project, head: "liaison" };
  return leadOf(found.project)?.id === chat ? { project: found.project, head: "lead" } : undefined;
}

/** A project's members: everyone but its lead and its liaison. */
function membersOf(project: Project): SessionInfo[] {
  const lead = leadOf(project)?.id;
  return project.sessions.filter((session) => session.id !== lead && !session.liaison);
}

/** Every member in ruri. */
function everyMember(ctx: ServerContext): SessionInfo[] {
  return ctx.store.list().flatMap(membersOf);
}

/** A member is at work while its turn runs — unless it is holding on an
 *  answer from another agent, parked in a tool call — and for a moment
 *  after a slot is handed to it, before its turn has said so. */
function workingNow(ctx: ServerContext, chat: string): boolean {
  if (running(ctx, chat)) return !ctx.talk.awaiting(chat);
  const at = ctx.governor.starting.get(chat);
  if (at !== undefined && Date.now() - at < STARTING_MS) return true;
  ctx.governor.starting.delete(chat);
  return false;
}

/** How many members are at work across ruri, leaving one out. */
export function atWork(ctx: ServerContext, except?: string): number {
  return everyMember(ctx).filter((member) => member.id !== except && workingNow(ctx, member.id)).length;
}

/** Members at work, and the cap when the user has set one. */
export function teamBudget(ctx: ServerContext, except?: string): TeamBudget {
  const cap = ctx.governor.cap;
  return {
    atWork: atWork(ctx, except),
    waiting: [...ctx.governor.waiting],
    ...(cap !== undefined ? { cap } : {}),
  };
}

/** Whether a member may start work now: always, unless RURI_TEAM_MAX is
 *  set and that many are at work. */
export function hasSlot(ctx: ServerContext, chat: string): boolean {
  const cap = ctx.governor.cap;
  return cap === undefined || atWork(ctx, chat) < cap;
}

/** A member is about to start a turn: it holds a slot from now. */
export function noteStarting(ctx: ServerContext, chat: string): void {
  if (isMemberChat(ctx, chat)) ctx.governor.starting.set(chat, Date.now());
}

/** Something for a member with no slot free: into its line, and the
 *  member into the line for a slot. */
export function waitForSlot(ctx: ServerContext, chat: string, entry: QueueEntry): void {
  ctx.queues.push(chat, entry);
  ctx.queues.broadcastQueue(chat);
  ctx.governor.wait(chat);
  armRecheck(ctx);
  pushTeamOf(ctx, chat);
}

function armRecheck(ctx: ServerContext): void {
  const governor = ctx.governor;
  if (governor.recheck || governor.waiting.length === 0) return;
  governor.recheck = setTimeout(() => {
    governor.recheck = undefined;
    releaseWaiting(ctx);
  }, RECHECK_MS);
  governor.recheck.unref?.();
}

/**
 * Members waiting on a slot go, oldest first, while there is one. Asked
 * whenever a member's turn ends (or it starts holding on an answer), a
 * member leaves, and every RECHECK_MS while anyone waits. A member no
 * longer waiting on anything — its line emptied, or already at work, its
 * line going out behind its turn — just leaves the line for a slot.
 */
export function releaseWaiting(ctx: ServerContext): void {
  for (const chat of [...ctx.governor.waiting]) {
    if (!ctx.store.findSession(chat) || ctx.queues.pending(chat) === 0 || running(ctx, chat)) {
      ctx.governor.unwait(chat);
      continue;
    }
    if (!hasSlot(ctx, chat)) break;
    ctx.governor.unwait(chat);
    // nobody stands at a member's line to send a held one on by hand
    ctx.queues.releaseQueue(chat);
    noteStarting(ctx, chat);
    if (!drainQueue(ctx, chat)) ctx.governor.starting.delete(chat);
    pushTeamOf(ctx, chat);
  }
  armRecheck(ctx);
}

/** A member's turn moved: it holds its slot from the moment it runs, and
 *  a turn ending frees one for whoever is waiting. The liaison's moving is
 *  the lead's roster changing. */
export function teamStatus(ctx: ServerContext, chat: string, status: string): void {
  if (!unattended(ctx, chat)) return;
  if (status === "working" || status === "permission") ctx.governor.starting.delete(chat);
  else releaseWaiting(ctx);
  pushTeamOf(ctx, chat);
}

/* ── the roster ───────────────────────────────────────────────────── */

function memberState(ctx: ServerContext, chat: string): MemberState {
  if (ctx.governor.waiting.includes(chat)) return "queued";
  const status = ctx.manager.statuses()[chat];
  if (status === "permission") return "permission";
  if (status === "working") return ctx.talk.awaiting(chat) ? "waiting" : "working";
  return ctx.manager.live(chat) ? "idle" : "asleep";
}

/** Words on one line, cut to fit. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** A project's members, as the team page shows them. */
export function teamMembers(ctx: ServerContext, project: Project): TeamMember[] {
  return membersOf(project).map((session) => {
    const events = ctx.archive.events(session.id);
    const ended = events.findLast((event) => event.kind === "result");
    const said = events.findLast((event) => event.kind === "assistant" && event.text.trim() !== "");
    const context = ctx.turns.contexts.get(session.id);
    return {
      id: session.id,
      name: session.title ?? "",
      duty: session.duty ?? "",
      layers: session.layers ?? [],
      model: channelProject(ctx, session.id)?.model || ctx.store.defaultModel(),
      state: memberState(ctx, session.id),
      ...(context ? { context } : {}),
      ...(ended ? { lastActive: ended.ts } : {}),
      exchanges: ctx.archive.turnIds(session.id).length,
      ...(said?.kind === "assistant" ? { lastWords: clip(said.text, 200) } : {}),
    };
  });
}

/** "40s", "12m", "3h", "2d" ago. */
function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const STATE_WORDS: Record<MemberState, string> = {
  asleep: "asleep",
  idle: "just finished",
  working: "working",
  waiting: "working, waiting on an answer",
  queued: "queued for a free slot",
  permission: "waiting on the user at a card",
};

/** The stack's layers that can have a teammate: those with a handle. */
function stackLayers(ctx: ServerContext, project: Project): StackLayer[] {
  return (ctx.briefs.get(project.id)?.layers ?? []).filter((layer) => layer.slug);
}

/** The layers no teammate holds yet, for the roster. */
function freeLayers(ctx: ServerContext, project: Project): string {
  const held = new Set(membersOf(project).flatMap((member) => member.layers ?? []));
  const free = stackLayers(ctx, project).filter((layer) => !held.has(layer.slug!));
  if (stackLayers(ctx, project).length === 0) return "";
  return free.length === 0
    ? "Every layer of the stack has its teammate."
    : `Layers with no teammate yet — add_teammate with the layer's handle the first time a job for one comes up:\n${free
        .map((layer) => `  ${layer.slug} — ${layer.name}`)
        .join("\n")}`;
}

/** The letters a chat has in flight: being answered, and handed out. */
function lettersOf(ctx: ServerContext, chat: string): string[] {
  const named = (id: string) => {
    const found = ctx.store.findSession(id);
    return found ? `${found.project.name} · ${found.session.title || "untitled"}` : "a closed chat";
  };
  const pending = [...ctx.talk.pending.values()].filter((letter) => !letter.ending);
  const owed = pending.filter((letter) => letter.to === chat);
  const out = pending.filter((letter) => letter.from === chat);
  return [
    ...(owed.length
      ? [
          `    answering: ${owed
            .map((letter) => `${named(letter.from)} (${ago(letter.ts)}): "${clip(letter.text, 80)}"`)
            .join("; ")}`,
        ]
      : []),
    ...(out.length
      ? [`    waiting on: ${out.map((letter) => `${named(letter.to)} (${ago(letter.ts)})`).join(", ")}`]
      : []),
  ];
}

/** The project's other lead, for a lead's roster: the liaison for the
 *  lead, the lead for the liaison. */
function otherHead(ctx: ServerContext, project: Project, head: Head): string[] {
  if (head === "liaison") {
    const lead = leadOf(project);
    return lead ? [`The lead — the user's chat, ${ctx.talk.handleOf(lead.id)}: ${doing(ctx, lead.id)}.`] : [];
  }
  const liaison = liaisonOf(project);
  if (!liaison)
    return [
      "The liaison: none yet — no agent from another project has written to this one. Their messages go to it, never to you, and it hands their jobs to this team.",
    ];
  return [
    `The liaison — other projects' agents reach it, and it hands their jobs to this team — ${ctx.talk.handleOf(liaison.id)}: ${doing(ctx, liaison.id)}.`,
    ...lettersOf(ctx, liaison.id),
  ];
}

/** The roster a lead — or the liaison — reads: its team, the layers with
 *  no teammate yet, and the other lead. */
export function rosterText(ctx: ServerContext, headId: string): string {
  const head = headOf(ctx, headId);
  if (!head) return "Only a project's lead, or its liaison, manages its team.";
  const { project } = head;
  const members = teamMembers(ctx, project);
  const lines: string[] = [];
  if (members.length === 0) {
    lines.push(
      `No teammates in ${project.name} yet. Add one with add_teammate the first time a job comes up — for its layer, or a part of the project — and give it the job in the same call.`,
    );
  } else {
    lines.push(`The team in ${project.name} — handle · name · state:`);
    for (const member of members) {
      const usage = member.context
        ? ` · context ${Math.round((member.context.tokens / Math.max(1, member.context.window)) * 100)}% of ${Math.round(member.context.window / 1000)}k`
        : "";
      const when = member.lastActive
        ? ` · last worked ${ago(member.lastActive)}`
        : member.exchanges === 0
          ? " · has not worked yet"
          : "";
      lines.push(
        "",
        `  ${ctx.talk.handleOf(member.id)}  ${member.name || "untitled"} — ${STATE_WORDS[member.state]}${usage}${when} · ${member.exchanges} exchange${member.exchanges === 1 ? "" : "s"} · ${member.model}`,
        `    duty: ${member.duty || "(none given)"}${
          member.duty && member.duty === member.name
            ? " — only the title of the chat it was before it joined: sharpen it with update_teammate once you know what it covers"
            : ""
        }`,
        ...(member.layers.length ? [`    layers: ${member.layers.join(", ")}`] : []),
        ...(member.lastWords ? [`    last said: ${member.lastWords}`] : []),
      );
    }
  }
  const free = freeLayers(ctx, project);
  if (free) lines.push("", free);
  lines.push("", ...otherHead(ctx, project, head.head));
  const cap = ctx.governor.cap;
  if (cap !== undefined) {
    const waiting = ctx.governor.waiting.length;
    lines.push(
      "",
      `At most ${cap} teammate${cap === 1 ? "" : "s"} across ruri work at once (RURI_TEAM_MAX): ${atWork(ctx)} at work${waiting ? `, ${waiting} waiting for a slot` : ""}.`,
    );
  }
  return lines.join("\n");
}

/* ── what can be done to a member ─────────────────────────────────── */

/** "Frontend UI", "frontend-ui", "ruri · Frontend UI" read alike. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[·/:|—–_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A member of the project's team, by handle, name or layer — for its
 *  lead or its liaison — or why not. */
function memberOf(ctx: ServerContext, headId: string, who: string): SessionInfo | string {
  const head = headOf(ctx, headId);
  if (!head) return "Only a project's lead, or its liaison, manages its team.";
  const { project } = head;
  const members = membersOf(project);
  const want = who.trim().replace(/^@/, "");
  const byHandle = members.find((member) => ctx.talk.handleOf(member.id) === want.toLowerCase());
  if (byHandle) return byHandle;
  const key = plain(want);
  const named = members.filter((member) => {
    const name = plain(member.title ?? "");
    return name !== "" && (key === name || key === `${plain(project.name)} ${name}`);
  });
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return `More than one teammate answers to "${who}": use its handle from team.`;
  const layered = members.filter((member) => member.layers?.some((layer) => layer === want.toLowerCase()));
  if (layered.length === 1) return layered[0]!;
  return `No teammate answers to "${who}". team shows your team and each one's handle.`;
}

/** Who did it, in the words a sender is told. */
function byWords(by: Head | "user"): string {
  return by === "lead" ? "the lead" : by === "liaison" ? "the liaison" : "the user";
}

/**
 * Stop a member's turn and close its process now. A turn cut off by
 * closing its process never says it ended, so a message it was working on
 * is ended for it, and its sender told.
 */
function stopNow(ctx: ServerContext, chat: string, why: string): void {
  if (running(ctx, chat)) {
    stopTurn(ctx, chat);
    talkTurnCut(ctx, chat, why);
  }
  ctx.manager.dispose(chat);
  ctx.governor.starting.delete(chat);
}

/** A member's line held by a stop moves again, when there is a slot. */
function wakeLine(ctx: ServerContext, chat: string): void {
  ctx.queues.releaseQueue(chat);
  if (ctx.queues.pending(chat) === 0) return;
  ctx.governor.wait(chat);
  releaseWaiting(ctx);
}

/** The messages waiting in a member's line, moved to the fresh member put
 *  in its place: their senders are still owed an answer. */
function moveLetters(ctx: ServerContext, from: string, to: string): number {
  const queue = ctx.queues.entries.get(from) ?? [];
  const letters = queue.filter((entry) => entry.from && !entry.from.answer && !entry.resume);
  for (const entry of letters) {
    const pending = ctx.talk.pending.get(entry.from!.letter);
    if (pending) {
      pending.to = to;
      ctx.talk.keep(pending);
    }
    ctx.queues.push(to, { ...entry, cut: false, from: { ...entry.from!, cutIn: false } });
  }
  ctx.queues.entries.set(
    from,
    queue.filter((entry) => !letters.includes(entry)),
  );
  return letters.length;
}

/** Do something to a member. Answers what happened, in words. */
export function actOn(ctx: ServerContext, chat: string, action: TeamAction, by: Head | "user"): string {
  const found = ctx.store.findSession(chat);
  if (!found) return "There is no such teammate.";
  if (leadOf(found.project)?.id === chat) return "That is the lead, not a teammate.";
  if (found.session.liaison) return "That is the liaison, not a teammate.";
  const name = found.session.title || "that teammate";
  const who = byWords(by);
  const was = running(ctx, chat);
  if (action === "stop") {
    if (!was) {
      return ctx.governor.waiting.includes(chat)
        ? `${name} isn't at work: it is waiting for a free slot, with ${ctx.queues.pending(chat)} in its line. Nothing to stop.`
        : `${name} isn't at work (${memberState(ctx, chat) === "asleep" ? "asleep" : "between turns"}): nothing to stop.`;
    }
    ctx.talk.stoppedBy.set(chat, who);
    ctx.talk.stopNotes.set(chat, who);
    stopTurn(ctx, chat);
    // stopping is stopping the work: ruri's own prompt sending it back to
    // work a message interrupted goes too — but other agents' messages
    // waiting behind it are still owed, and go on once the turn has ended
    const queue = ctx.queues.entries.get(chat) ?? [];
    const kept = queue.filter((entry) => !entry.resume);
    if (kept.length) ctx.queues.entries.set(chat, kept);
    else ctx.queues.entries.delete(chat);
    ctx.queues.cutIn.delete(chat);
    ctx.queues.releaseQueue(chat);
    ctx.queues.broadcastQueue(chat);
    pushTeamOf(ctx, chat);
    return `Stopped ${name}'s turn. ${
      kept.length
        ? `${kept.length} message${kept.length === 1 ? "" : "s"} waiting in its line go${kept.length === 1 ? "es" : ""} on now.`
        : "Nothing new was sent: it waits for the next message."
    } A message it was answering is told it was stopped.`;
  }
  if (action === "restart") {
    if (was) ctx.talk.stopNotes.set(chat, who);
    stopNow(ctx, chat, `${name}'s turn on your message was cut short: ${who} restarted it.`);
    wakeLine(ctx, chat);
    pushTeamOf(ctx, chat);
    return was
      ? `Restarted ${name}: the turn it was on is stopped and its process is closed. Its conversation is kept, and the next message resumes it.`
      : `Restarted ${name}: it wasn't at work, and its process is closed. Its conversation is kept, and the next message resumes it.`;
  }
  if (action === "compact") {
    if (was || ctx.queues.pending(chat) > 0) {
      // in its line, ahead of anything else waiting: it runs the moment
      // its turn ends, and the rest goes on in the fresh session
      const queue = ctx.queues.entries.get(chat) ?? [];
      const front = queue.findIndex((entry) => !entry.silent);
      queue.splice(front === -1 ? queue.length : front, 0, {
        id: `compact-${Date.now()}`,
        text: "/compact",
        uploads: [],
        silent: false,
      });
      ctx.queues.entries.set(chat, queue);
      ctx.queues.broadcastQueue(chat);
      if (!was) wakeLine(ctx, chat);
      return `${name} is at work, or has work waiting: it compacts the moment its turn ends, and goes on from the brief.`;
    }
    compactChannel(ctx, chat, `compacted by ${who}`);
    pushTeamOf(ctx, chat);
    return `Compacted ${name}: its conversation is a brief now, and its next session starts from it.`;
  }
  const refresh = action === "refresh" || action === "clear";
  // refresh and retire both end the chat; refresh puts a fresh one in its
  // place
  stopNow(ctx, chat, `${name} was ${refresh ? "refreshed" : "retired"} by ${who} before it answered.`);
  const { project, session } = found;
  // a refreshed member is a new chat in the old one's place: its id is
  // what its conversation is kept under, and nothing of that may come back
  const fresh = refresh
    ? ctx.store.addMember(project.id, {
        name: session.title ?? "",
        duty: session.duty ?? "general work in this project",
        ...(session.layers ? { layers: session.layers } : {}),
      })
    : undefined;
  if (fresh) ctx.store.copySessionSettings(chat, fresh.id);
  const moved = fresh ? moveLetters(ctx, chat, fresh.id) : 0;
  closeMember(ctx, chat);
  if (fresh && moved) wakeLine(ctx, fresh.id);
  releaseWaiting(ctx);
  pushTeam(ctx, project.id);
  if (!refresh)
    return `Retired ${name}: it is off the team, and its conversation is gone. What it learned that mattered is in the project's memory.`;
  return fresh
    ? `Refreshed ${name}: a fresh session in its place with its name, duty and layers and nothing else — handle ${ctx.talk.handleOf(fresh.id)} now.${
        was ? " The turn it was on is lost, and its sender told; hand on what still needs doing." : ""
      }${moved ? ` ${moved} message${moved === 1 ? "" : "s"} waiting for it went to the fresh one.` : ""}`
    : `Refreshed ${name}, but couldn't put it back on the team.`;
}

/** A layer of the project's stack, by its handle or its name — or why not. */
function layerFor(ctx: ServerContext, project: Project, asked: string): StackLayer | string {
  const layers = stackLayers(ctx, project);
  if (layers.length === 0)
    return `${project.name} has no stack of layers yet: give the teammate a name and a duty instead.`;
  const want = plain(asked);
  const hit =
    layers.find((layer) => layer.slug === asked.trim().toLowerCase()) ??
    layers.find((layer) => plain(layer.slug ?? "") === want || plain(layer.name) === want);
  return (
    hit ??
    `No layer goes by "${asked}" in ${project.name}'s stack. Its layers: ${layers.map((layer) => layer.slug).join(", ")}.`
  );
}

/** The leads' tools, with the server behind them. */
export function teamHost(ctx: ServerContext): TeamHost {
  return {
    roster: (headId) => rosterText(ctx, headId),
    add: async (headId, args: AddArgs, wait) => {
      const head = headOf(ctx, headId);
      if (!head) return "Only a project's lead, or its liaison, adds to its team.";
      const { project } = head;
      const layer = args.layer?.trim() ? layerFor(ctx, project, args.layer) : undefined;
      if (typeof layer === "string") return layer;
      const members = membersOf(project);
      if (layer) {
        const holder = members.find((member) => member.layers?.includes(layer.slug!));
        if (holder)
          return `${holder.title || "A teammate"} holds ${layer.slug} already (handle ${ctx.talk.handleOf(holder.id)}): message it.`;
      }
      const name = args.name?.trim() || layer?.name || "";
      const duty = args.duty?.trim() || (layer ? layer.what.trim() || `the ${layer.name} layer` : "");
      if (!name || !duty) return "A teammate needs a layer's handle, or a name and a duty.";
      const same = members.find((member) => plain(member.title ?? "") === plain(name));
      if (same)
        return `${name} is on the team already (handle ${ctx.talk.handleOf(same.id)}): message it, or change its duty with update_teammate.`;
      if (members.length >= MAX_MEMBERS)
        return `${project.name}'s team has ${members.length} members, the most it may: widen an existing teammate's duty, or retire one that is no longer needed.`;
      const model = args.model?.trim() ? modelFor(ctx, args.model) : undefined;
      if (typeof model === "string") return model;
      const known = new Set(stackLayers(ctx, project).map((l) => l.slug));
      const extra = (args.layers ?? []).map((l) => l.trim()).filter(Boolean);
      const layers = [...new Set([...(layer ? [layer.slug!] : []), ...extra])];
      const unknown = known.size ? extra.filter((l) => !known.has(l)) : [];
      const member = ctx.store.addMember(project.id, {
        name,
        duty,
        ...(layers.length ? { layers } : {}),
        ...(model ? { model: model.value } : {}),
      });
      if (!member) return `Couldn't add ${name}.`;
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      pushTeam(ctx, project.id);
      const handle = ctx.talk.handleOf(member.id);
      const added = `Added ${name} to the team — handle ${handle}${model ? `, on ${model.name}` : ""}${
        layers.length ? `, holding ${layers.join(", ")}` : ""
      }.${unknown.length ? ` No layer goes by ${unknown.join(", ")} in the stack; check \`ruri architecture\`.` : ""}`;
      if (!args.message?.trim()) return `${added} It is asleep until you message it.`;
      const opts: WaitOptions = { via: "tool", ...wait };
      const sent = await sendLetter(
        ctx,
        headId,
        { to: handle, message: args.message, reply: args.reply ?? "later", approved: true },
        opts,
      );
      return `${added} ${sent.text}`;
    },
    update: (headId, args) => {
      const member = memberOf(ctx, headId, args.who);
      if (typeof member === "string") return member;
      ctx.store.setMember(member.id, {
        ...(args.name?.trim() ? { name: args.name.trim() } : {}),
        ...(args.duty?.trim() ? { duty: args.duty.trim() } : {}),
        ...(args.layers ? { layers: args.layers.map((l) => l.trim()).filter(Boolean) } : {}),
      });
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      // its next session reads the new words: a warm one is let go of
      // once it is idle (an asleep one has nothing to let go of)
      if (!running(ctx, member.id)) ctx.manager.dispose(member.id);
      pushTeamOf(ctx, member.id);
      return `Updated ${member.title || "that teammate"}: its next session reads the new ${[
        args.name ? "name" : "",
        args.duty ? "duty" : "",
        args.layers ? "layers" : "",
      ]
        .filter(Boolean)
        .join(" and ")}.`;
    },
    manage: (headId, who, action) => {
      const member = memberOf(ctx, headId, who);
      return typeof member === "string" ? member : actOn(ctx, member.id, action, headOf(ctx, headId)!.head);
    },
    retire: (headId, who) => {
      const member = memberOf(ctx, headId, who);
      return typeof member === "string" ? member : actOn(ctx, member.id, "retire", headOf(ctx, headId)!.head);
    },
  };
}

/* ── the team page ────────────────────────────────────────────────── */

/** Projects someone has opened the team page on: only theirs are pushed. */
const watched = new Set<string>();
const pushing = new Map<string, NodeJS.Timeout>();

function teamMessage(ctx: ServerContext, project: Project): ServerMessage {
  return { type: "team", projectId: project.id, members: teamMembers(ctx, project), budget: teamBudget(ctx) };
}

/** A project's team to every window, a moment after it changes. */
export function pushTeam(ctx: ServerContext, projectId: string): void {
  if (!watched.has(projectId) || pushing.has(projectId)) return;
  const timer = setTimeout(() => {
    pushing.delete(projectId);
    const project = ctx.store.get(projectId);
    if (project) ctx.clients.broadcast(teamMessage(ctx, project));
  }, 300);
  timer.unref?.();
  pushing.set(projectId, timer);
}

function pushTeamOf(ctx: ServerContext, chat: string): void {
  const project = ctx.store.findSession(chat)?.project;
  if (project) pushTeam(ctx, project.id);
}

export const teamHandlers = {
  team_get: (ctx, ws, msg) => {
    const project = ctx.store.get(msg.projectId);
    if (!project) return;
    watched.add(project.id);
    ws.send(JSON.stringify(teamMessage(ctx, project)));
  },
  team_member: (ctx, _ws, msg) => {
    const project = ctx.store.findSession(msg.memberId)?.project;
    actOn(ctx, msg.memberId, msg.action, "user");
    if (project) pushTeam(ctx, project.id);
  },
} satisfies Partial<Handlers>;
