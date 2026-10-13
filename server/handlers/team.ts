/**
 * A project's team, run against the live server (the budget, the words
 * and the tools are server/team.ts): who is at work and who is waiting on
 * a slot, the roster the lead reads and the team page shows, and what the
 * lead — or the user, from the team page — can do to a member: add one,
 * change its duty, compact, restart or clear it, retire it.
 */
import {
  leadOf,
  type MemberState,
  type Project,
  type ServerMessage,
  type SessionInfo,
  type TeamAction,
  type TeamBudget,
  type TeamMember,
} from "../../shared/protocol.js";
import { channelProject, running } from "../channel.js";
import type { ServerContext } from "../context.js";
import { compactChannel, drainQueue, stopTurn } from "../dispatch.js";
import type { QueueEntry } from "../queue.js";
import { AGENT_BYTES, bytes, slotsFor, type TeamHost } from "../team.js";
import { closeSession } from "./projects.js";
import { modelFor, sendLetter, talkTurnCut, type WaitOptions } from "./talk.js";
import type { Handlers } from "./types.js";

/** The most members one project's team may have. */
export const MAX_MEMBERS = 12;

/** How long a member a slot was just handed to counts as at work before
 *  its turn has said so — the send is a microtask away. */
const STARTING_MS = 10_000;

/** How often members waiting on a slot are looked at again, in case the
 *  memory has freed with nobody finishing. */
const RECHECK_MS = 15_000;

/** Whether a chat is a member of its project's team — not a lead, not Home. */
export function isMemberChat(ctx: ServerContext, chat: string): boolean {
  return ctx.store.isMember(chat);
}

/** Every member in ruri. */
function everyMember(ctx: ServerContext): SessionInfo[] {
  return ctx.store.list().flatMap((project) => {
    const lead = leadOf(project)?.id;
    return project.sessions.filter((session) => session.id !== lead);
  });
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

/**
 * What one agent at work costs: what the statistics page measured lately,
 * when it has been up, else the usual (AGENT_BYTES) — kept within reason,
 * so one huge or tiny process doesn't swing the budget.
 */
function perAgentBytes(ctx: ServerContext): number {
  const last = ctx.meters.latest();
  const sized = last && Date.now() - last.at < 120_000 ? last.agents.filter((a) => a.memory > 0) : [];
  if (sized.length === 0) return AGENT_BYTES;
  const mean = sized.reduce((sum, a) => sum + a.memory, 0) / sized.length;
  return Math.min(1536 * 1024 ** 2, Math.max(150 * 1024 ** 2, mean));
}

/** The machine's budget for members at work, as it stands. */
export function teamBudget(ctx: ServerContext, except?: string): TeamBudget {
  const availableBytes = ctx.governor.availableBytes();
  const perAgent = perAgentBytes(ctx);
  const working = atWork(ctx, except);
  return {
    slots: slotsFor({
      availableBytes,
      totalBytes: ctx.governor.totalBytes,
      perAgentBytes: perAgent,
      atWork: working,
      cap: ctx.governor.cap,
    }),
    atWork: working,
    waiting: [...ctx.governor.waiting],
    availableBytes,
    totalBytes: ctx.governor.totalBytes,
    perAgentBytes: perAgent,
    cap: ctx.governor.cap,
  };
}

/** Whether a member may start work now. */
export function hasSlot(ctx: ServerContext, chat: string): boolean {
  const budget = teamBudget(ctx, chat);
  return budget.atWork < budget.slots;
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
 *  a turn ending frees one for whoever is waiting. */
export function teamStatus(ctx: ServerContext, chat: string, status: string): void {
  if (!isMemberChat(ctx, chat)) return;
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
  const lead = leadOf(project)?.id;
  return project.sessions
    .filter((session) => session.id !== lead)
    .map((session) => {
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

/** The machine, in a line or two, for the lead. */
function machineWords(ctx: ServerContext): string {
  const budget = teamBudget(ctx);
  const free = Math.max(0, budget.slots - budget.atWork);
  return [
    `The machine: ${bytes(budget.availableBytes)} of ${bytes(budget.totalBytes)} memory free; a teammate at work costs about ${bytes(budget.perAgentBytes)}.`,
    `Teammates at work across ruri: ${budget.atWork}, of ${budget.slots} the machine has room for right now (never more than ${budget.cap}) — ${
      free === 0 ? "no slot free: a message to one asleep waits for a slot" : `${free} free`
    }.${budget.waiting.length ? ` Waiting on a slot: ${budget.waiting.length}.` : ""}`,
  ].join("\n");
}

/** The lead's roster: its team and the machine, in words. */
export function rosterText(ctx: ServerContext, leadId: string): string {
  const found = ctx.store.findSession(leadId);
  if (!found) return "Only a project's lead has a team.";
  const { project } = found;
  if (leadOf(project)?.id !== leadId) return "Only the lead of a project manages its team.";
  const members = teamMembers(ctx, project);
  const lines: string[] = [];
  if (members.length === 0) {
    lines.push(
      `No teammates in ${project.name} yet. Add one with add_teammate when work here will come back and needs its own conversation — a part of the project, not a single task.`,
    );
  } else {
    lines.push(`Your team in ${project.name} — handle · name · state:`);
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
  lines.push("", machineWords(ctx));
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

/** A member of the lead's own team, by handle or name — or why not. */
function memberOf(ctx: ServerContext, leadId: string, who: string): SessionInfo | string {
  const found = ctx.store.findSession(leadId);
  if (!found || leadOf(found.project)?.id !== leadId) return "Only the lead of a project manages its team.";
  const lead = leadId;
  const members = found.project.sessions.filter((session) => session.id !== lead);
  const want = who.trim().replace(/^@/, "");
  const byHandle = members.find((member) => ctx.talk.handleOf(member.id) === want.toLowerCase());
  if (byHandle) return byHandle;
  const key = plain(want);
  const named = members.filter((member) => {
    const name = plain(member.title ?? "");
    return name !== "" && (key === name || key === `${plain(found.project.name)} ${name}`);
  });
  if (named.length === 1) return named[0]!;
  if (named.length > 1) return `More than one teammate answers to "${who}": use its handle from team.`;
  return `No teammate answers to "${who}". team shows your team and each one's handle.`;
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

/** A member's line held by the stop moves again, if a slot is free. */
function wakeLine(ctx: ServerContext, chat: string): void {
  ctx.queues.releaseQueue(chat);
  if (ctx.queues.pending(chat) === 0) return;
  ctx.governor.wait(chat);
  releaseWaiting(ctx);
}

/** Do something to a member. Answers what happened, in words. */
export function actOn(ctx: ServerContext, chat: string, action: TeamAction, by: "lead" | "user"): string {
  const found = ctx.store.findSession(chat);
  if (!found) return "There is no such teammate.";
  if (leadOf(found.project)?.id === chat) return "That is the lead, not a teammate.";
  const name = found.session.title || "that teammate";
  const who = by === "lead" ? "the lead" : "the user";
  if (action === "restart") {
    const was = running(ctx, chat);
    stopNow(ctx, chat, `${name}'s turn on your message was cut short: ${who} restarted it.`);
    wakeLine(ctx, chat);
    pushTeamOf(ctx, chat);
    return `Restarted ${name}: ${was ? "the turn it was on is stopped and " : ""}its process is closed. Its conversation is kept, and the next message resumes it.`;
  }
  if (action === "compact") {
    if (running(ctx, chat) || ctx.queues.pending(chat) > 0) {
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
      return `${name} is at work, or has work waiting: it compacts the moment its turn ends, and goes on from the brief.`;
    }
    compactChannel(ctx, chat, `compacted by ${who}`);
    pushTeamOf(ctx, chat);
    return `Compacted ${name}: its conversation is a brief now, and its next session starts from it.`;
  }
  // clear and retire both end the chat; clear puts a fresh one in its place
  stopNow(
    ctx,
    chat,
    `${name} was ${action === "clear" ? "cleared" : "retired"} by ${who} before it answered.`,
  );
  const { project, session } = found;
  // a cleared member is a new chat in the old one's place: its id is what
  // its conversation is kept under, and nothing of that may come back
  const fresh =
    action === "clear"
      ? ctx.store.addMember(project.id, {
          name: session.title ?? "",
          duty: session.duty ?? "general work in this project",
          ...(session.layers ? { layers: session.layers } : {}),
        })
      : undefined;
  if (fresh) ctx.store.copySessionSettings(chat, fresh.id);
  closeSession(ctx, chat);
  if (action === "retire") {
    releaseWaiting(ctx);
    pushTeam(ctx, project.id);
    return `Retired ${name}: it is off the team, and its conversation is gone. What it learned that mattered is in the project's memory.`;
  }
  releaseWaiting(ctx);
  pushTeam(ctx, project.id);
  return fresh
    ? `Cleared ${name}: it starts fresh with its name, duty and layers and nothing else — handle ${ctx.talk.handleOf(fresh.id)} now. Anything it was in the middle of is lost; tell it what it needs.`
    : `Cleared ${name}, but couldn't put it back on the team.`;
}

/** The lead's tools, with the server behind them. */
export function teamHost(ctx: ServerContext): TeamHost {
  return {
    roster: (leadId) => rosterText(ctx, leadId),
    add: async (leadId, args, wait) => {
      const found = ctx.store.findSession(leadId);
      if (!found || leadOf(found.project)?.id !== leadId)
        return "Only the lead of a project adds to its team.";
      const { project } = found;
      const name = args.name.trim();
      const duty = args.duty.trim();
      if (!name || !duty) return "A teammate needs a name and a duty.";
      const members = project.sessions.filter((session) => session.id !== leadId);
      const same = members.find((member) => plain(member.title ?? "") === plain(name));
      if (same)
        return `${name} is on the team already (handle ${ctx.talk.handleOf(same.id)}): message it, or change its duty with update_teammate.`;
      if (members.length >= MAX_MEMBERS)
        return `${project.name}'s team has ${members.length} members, the most it may: widen an existing teammate's duty, or retire one that is no longer needed.`;
      const model = args.model?.trim() ? modelFor(ctx, args.model) : undefined;
      if (typeof model === "string") return model;
      const known = new Set((ctx.briefs.get(project.id)?.layers ?? []).map((layer) => layer.slug));
      const layers = (args.layers ?? []).map((layer) => layer.trim()).filter(Boolean);
      const unknown = known.size ? layers.filter((layer) => !known.has(layer)) : [];
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
      const added = `Added ${name} to the team — handle ${handle}${model ? `, on ${model.name}` : ""}.${
        unknown.length
          ? ` No layer goes by ${unknown.join(", ")} in the stack; check \`ruri architecture\`.`
          : ""
      }`;
      if (!args.message?.trim()) return `${added} It is asleep until you message it.`;
      const opts: WaitOptions = { via: "tool", ...wait };
      const sent = await sendLetter(
        ctx,
        leadId,
        { to: handle, message: args.message, reply: args.reply ?? "wait", approved: true },
        opts,
      );
      return `${added} ${sent.text}`;
    },
    update: (leadId, args) => {
      const member = memberOf(ctx, leadId, args.who);
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
    reset: (leadId, who, how) => {
      const member = memberOf(ctx, leadId, who);
      return typeof member === "string" ? member : actOn(ctx, member.id, how, "lead");
    },
    retire: (leadId, who) => {
      const member = memberOf(ctx, leadId, who);
      return typeof member === "string" ? member : actOn(ctx, member.id, "retire", "lead");
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
