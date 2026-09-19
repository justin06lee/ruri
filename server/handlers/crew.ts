/**
 * The user's own agents, started from a chat's agents page (the crew,
 * server/agents.ts keeps their cards and logs): their session manager,
 * their cards moving along, and the agents page's messages.
 */
import { briefLine, type PermissionRequest, type ServerMessage, type SubagentState, type TranscriptEvent } from "../../shared/protocol.js";
import { sessionBriefing } from "../briefing.js";
import { channelProject, ownerProject } from "../channel.js";
import type { ServerContext } from "../context.js";
import { redacted } from "../events.js";
import { HOME_ID } from "../manager.js";
import { SessionManager } from "../sessions.js";
import type { Handlers } from "./types.js";

/**
 * The agents the user starts themselves, from a chat's agents page (the
 * crew, server/agents.ts). Each is a session of its own on a manager of
 * its own, so nothing that watches the chats — their status, the sidebar,
 * the queue, retries, the recall notes — ever sees one: its channel is its
 * card's key, and everything it does goes to its log and its card, both
 * filed under the chat that started it. It runs in the chat's project at
 * the chat's effort and permissions (on the chat's model unless another
 * was picked), and closes a moment after each turn, like a chat nobody
 * has open.
 */
const CREW_BRIEFING = [
  "<ruri:agent>",
  "The user started you from a ruri chat's agents page, as an agent of their own, and the brief is your task.",
  "Work in this project on your own — ask only if you are truly stuck — and finish with a short report of what you did and what you found: that report is what the user reads first, and what they may hand back to the chat.",
  "</ruri:agent>",
].join("\n");

/** An agent of the user's as a Project: the chat's, under the agent's key. */
function crewProject(ctx: ServerContext, chatId: string, key: string, model?: string) {
  const chat = channelProject(ctx, chatId);
  return chat && { ...chat, id: key, ...(model ? { model } : {}) };
}

/** Move one of the user's agents' cards along, and show the chat its crew. */
function crewCard(ctx: ServerContext, key: string, patch: Partial<SubagentState>): void {
  const chatId = ctx.crew.owner(key);
  if (!chatId || !ctx.crew.update(key, patch)) return;
  ctx.clients.toViewers(chatId, { type: "crew", projectId: chatId, agents: ctx.crew.list(chatId) });
}

/** Something one of the user's agents did, into a log (its own, or an
 *  agent of its own's): true when it is new there. */
function crewLog(ctx: ServerContext, key: string, logKey: string, raw: TranscriptEvent): boolean {
  const chatId = ctx.crew.owner(key);
  if (!chatId) return false;
  const event = redacted(ctx, raw);
  ctx.readable.allowReadImages(chatId, [event]);
  const added = ctx.agentLogs.append(chatId, logKey, event);
  ctx.clients.toViewers(chatId, { type: "agent_event", projectId: chatId, key: logKey, event });
  return added;
}

/** Another turn for one of the user's agents, once it is done: more to
 *  do, or the answers to its questions. */
export function followCrew(ctx: ServerContext, key: string, text: string): void {
  const chatId = ctx.crew.owner(key);
  const member = ctx.crew.member(key);
  const project = chatId && member ? crewProject(ctx, chatId, key, member.agent.model) : undefined;
  if (!project || member?.agent.status === "running") return;
  ctx.crewSaid.delete(key);
  crewCard(ctx, key, { status: "running", startedAt: Date.now(), endedAt: undefined, result: undefined, activity: undefined });
  ctx.crewManager.send(project, text);
}

/** One of the user's agents finished a turn: its card says how, and
 *  what it came back with; what it spent is its project's. */
function settleCrew(ctx: ServerContext, key: string, event: Extract<TranscriptEvent, { kind: "result" }>): void {
  const chatId = ctx.crew.owner(key);
  const card = ctx.crew.member(key)?.agent;
  if (!chatId || !card) return;
  const said = ctx.crewSaid.get(key);
  ctx.crewSaid.delete(key);
  crewCard(ctx, key, {
    status: event.stopped ? "stopped" : event.ok ? "done" : "failed",
    endedAt: Date.now(),
    activity: undefined,
    ...(event.tokens ? { tokens: (card.tokens ?? 0) + event.tokens } : {}),
    ...(said ? { result: said } : event.error && !event.ok ? { result: ctx.secrets.redact(event.error) } : {}),
  });
  const owner = ownerProject(ctx, chatId);
  if (owner && (event.tokens || event.costUsd || event.durationMs)) {
    ctx.ledger.record(owner.id, {
      ...(event.tokens ? { tokens: event.tokens } : {}),
      ...(event.costUsd ? { costUsd: event.costUsd } : {}),
      ...(event.durationMs ? { ms: event.durationMs } : {}),
    });
    ctx.clients.broadcast({ type: "stats", projectId: owner.id, stats: ctx.ledger.stats(owner.id) });
  }
  ctx.usage.pushUsage();
}

export function createCrewManager(ctx: ServerContext): SessionManager {
  return new SessionManager(
    {
      onEvent: (key, raw) => {
        if (raw.kind === "result") {
          settleCrew(ctx, key, raw);
          return;
        }
        const added = crewLog(ctx, key, key, raw);
        if (raw.kind === "assistant") ctx.crewSaid.set(key, ctx.secrets.redact(raw.text));
        if (raw.kind === "tool" && added) {
          const card = ctx.crew.member(key)?.agent;
          crewCard(ctx, key, {
            tools: (card?.tools ?? 0) + 1,
            activity: ctx.secrets.redact(`${raw.name} ${raw.summary}`.trim()),
          });
        }
      },
      // its own agents' cards moving along, and what they did: its log
      onEventUpdate: (key, raw) => void crewLog(ctx, key, key, raw),
      onAgentEvent: (key, nested, raw) => void crewLog(ctx, key, nested, raw),
      // its log takes whole messages, the way a harness's agents' logs do
      onDelta: () => {},
      onStatus: (key, status) => {
        if (ctx.crew.member(key)?.agent.status !== "running") return;
        if (status === "permission") crewCard(ctx, key, { activity: "waiting on you: allow or deny it" });
        // a process gone without a word about its turn
        else if (status === "error") crewCard(ctx, key, { status: "failed", endedAt: Date.now() });
      },
      onPermission: (raw) => {
        // the chat's card — marked as this agent's — so it shows wherever
        // the chat does, and on the agent's own page
        const chatId = ctx.crew.owner(raw.projectId);
        if (!chatId) return;
        const request: PermissionRequest = {
          ...raw,
          projectId: chatId,
          agent: raw.projectId,
          input: ctx.secrets.redactInput(raw.input),
        };
        ctx.permissions.set(request.requestId, request);
        ctx.clients.broadcast({ type: "permission_request", request });
      },
      onPermissionResolved: (requestId) => {
        ctx.permissions.delete(requestId);
        ctx.clients.broadcast({ type: "permission_resolved", requestId });
      },
      onQuestionLate: (requestId) => {
        const request = ctx.permissions.get(requestId);
        if (!request || request.late) return;
        const late = { ...request, late: true };
        ctx.permissions.set(requestId, late);
        ctx.clients.broadcast({ type: "permission_request", request: late });
      },
      onModels: () => {},
      onSessionId: (key, sessionId) => ctx.crew.setSessionId(key, sessionId),
      onContext: () => {},
      onProgress: () => {},
      onChain: () => {},
    },
    (key) => ctx.crew.sessionId(key),
    (project) => {
      const claude = !ctx.models.registry.parse(project.model || ctx.store.defaultModel()).providerId;
      const note = [
        sessionBriefing({ projectDir: project.path, projectName: project.name, secrets: ctx.secrets, claude, naming: "" }),
        CREW_BRIEFING,
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        fillSecrets: (input) => (ctx.secrets.wanted(JSON.stringify(input)) ? ctx.secrets.fillInput(input) : undefined),
        options: { env: ctx.secrets.env(), systemPrompt: { type: "preset", preset: "claude_code", append: note } },
        providerSystem: note,
      };
    },
    {
      parse: (model) => ctx.models.registry.parse(model),
      create: (id, workDir) => ctx.models.registry.createFor(id, workDir, ctx.secrets.env()),
      canFork: (id) => ctx.models.registry.canForkSession(id),
    },
  );
}

export const crewHandlers = {
  agent_log: (ctx, ws, msg) => {
    const id = msg.projectId;
    if (id !== HOME_ID && !ctx.store.sessionIds().includes(id)) return;
    const events = ctx.agentLogs.read(id, msg.key);
    ctx.readable.allowReadImages(id, events);
    ws.send(JSON.stringify({ type: "agent_log", projectId: id, key: msg.key, events } satisfies ServerMessage));
  },
  agent_start: (ctx, _ws, msg) => {
    const chatId = msg.projectId;
    const text = msg.text.trim();
    if (chatId === HOME_ID || !text || !/^crew-[a-z0-9]{6,32}$/.test(msg.key) || ctx.crew.owner(msg.key)) return;
    const project = crewProject(ctx, chatId, msg.key, msg.model);
    if (!project) return;
    ctx.crew.add(chatId, {
      key: msg.key,
      description: briefLine(text),
      prompt: text,
      model: project.model || ctx.store.defaultModel(),
      status: "running",
      mine: true,
      startedAt: Date.now(),
    });
    ctx.clients.toViewers(chatId, { type: "crew", projectId: chatId, agents: ctx.crew.list(chatId) });
    ctx.crewManager.send(project, text);
  },
  agent_send: (ctx, _ws, msg) => {
    if (ctx.crew.owner(msg.key) !== msg.projectId || !msg.text.trim()) return;
    followCrew(ctx, msg.key, msg.text.trim());
  },
  agent_stop: (ctx, _ws, msg) => {
    if (ctx.crew.owner(msg.key) !== msg.projectId) return;
    const status = ctx.crewManager.statuses()[msg.key];
    if (status && status !== "idle") ctx.crewManager.interrupt(msg.key);
    // nothing running to stop: only the card still thought so
    else crewCard(ctx, msg.key, { status: "stopped", endedAt: Date.now(), activity: undefined });
  },
} satisfies Partial<Handlers>;
