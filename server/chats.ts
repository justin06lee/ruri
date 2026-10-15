/**
 * The chats' session manager: Home and every project session, wired to
 * the rest of the server — each event recorded and pushed, a finished
 * turn's spend, queue and retry, the cards a turn raises, and what each
 * session is told and given (its briefing, the vault, ruri's tools).
 */
import { leadOf, type ContextUsage, type PermissionRequest } from "../shared/protocol.js";
import { stackBriefing } from "./brief.js";
import { BRIDGE_TOOLS, bridgeHttpBriefing, bridgeTools, bridgeToolBriefing } from "./bridge.js";
import { sessionBriefing } from "./briefing.js";
import { channelProject, ownerProject } from "./channel.js";
import { COMPONENT_TOOLS, componentTools } from "./components.js";
import type { ServerContext } from "./context.js";
import { autoCompactDue, compactChannel, drainQueue, holdForTheWorld, maybeRetry } from "./dispatch.js";
import { recordEvent, redacted } from "./events.js";
import { afterCompactBrief, noteSelfCompaction, recoverLostStart } from "./handoff.js";
import { ensureLibrarySkill, libraryEndpoint } from "./handlers/components.js";
import { cliEnv, skillDir } from "./library.js";
import { HOME_ID, managerExtras } from "./manager.js";
import { carryLetter, talkHost, talkTurnEnded } from "./handlers/talk.js";
import { teamHost, teamStatus } from "./handlers/team.js";
import { ParagraphGate } from "./paragraphs.js";
import {
  CONTEXT_TOOLS,
  contextBriefing,
  contextNotice,
  contextTools,
  selfCompact,
  selfCompactDue,
} from "./selfCompaction.js";
import { SessionManager, type SessionExtras } from "./sessions.js";
import { httpWaitMs, TALK_TOOLS, talkHttpBriefing, talkToolBriefing, talkTools } from "./talk.js";
import {
  headWatch,
  leadBriefing,
  memberBriefing,
  refusal,
  refusedFor,
  TEAM_TOOLS,
  teamTools,
  type Head,
} from "./team.js";
import { contextWindow, pushContexts, pushWork } from "./turns.js";

/**
 * A chat's extras, with the chat's own id in the harness's environment.
 *
 * ruri starts a harness process per chat, and a process on this machine
 * has nothing on it that says which conversation it is having — a fresh
 * session has no session id to be told, so its command line says nothing
 * either. This is what lets the statistics page point at a process and
 * name the chat (server/resources.ts). Every branch of the extras goes
 * through here, so a path added later cannot quietly miss it.
 */
function tagged(channelId: string, extras: SessionExtras): SessionExtras {
  return {
    ...extras,
    options: { ...extras.options, env: { ...extras.options?.env, RURI_CHANNEL: channelId } },
  };
}

/** Write down the files as a finished turn left them, under its prompt. */
function settleCheckpoint(ctx: ServerContext, channelId: string): void {
  if (channelId === HOME_ID) return;
  const project = channelProject(ctx, channelId);
  const prompt = ctx.archive.events(channelId).findLast((event) => event.kind === "user");
  if (!project?.path || !prompt) return;
  void ctx.checkpoints.settle(project, channelId, prompt.id).catch(() => false);
}

/** A lead's or the liaison's own tool calls, watched turn by turn — the
 *  turn in flight is what tells one from the next (server/team.ts). */
function leadOnTools(ctx: ServerContext, channelId: string, head: Head): SessionExtras["afterTools"] {
  const watch = headWatch(head);
  return (calls) => watch(ctx.turns.progress.get(channelId)?.startedAt, calls);
}

export function createChatManager(ctx: ServerContext): SessionManager {
  const manager = new SessionManager(
    {
      onEvent: (projectId, event) => {
        // the finished message carries its whole text — the held tail too
        if (event.kind === "assistant" && ctx.turns.gates.get(projectId)?.messageId === event.id)
          ctx.turns.gates.delete(projectId);
        ctx.readable.allowReadImages(projectId, [event]);
        recordEvent(ctx, projectId, event);
        if (event.kind === "result") {
          // the files as the turn left them: the other half of what it did,
          // which is what lets a rewind take back this turn and only this
          // turn. Written before the queue moves, so the next prompt's own
          // capture lands after it.
          settleCheckpoint(ctx, projectId);
          ctx.usage.pushUsage();
          pushContexts(ctx);
          // the turn's spend lands in its project's ledger (Home in its own)
          const spender = projectId === HOME_ID ? HOME_ID : ownerProject(ctx, projectId)?.id;
          if (spender && (event.tokens || event.costUsd || event.durationMs)) {
            ctx.ledger.record(spender, {
              ...(event.tokens ? { tokens: event.tokens } : {}),
              ...(event.costUsd ? { costUsd: event.costUsd } : {}),
              ...(event.durationMs ? { ms: event.durationMs } : {}),
            });
            ctx.clients.broadcast({ type: "stats", projectId: spender, stats: ctx.ledger.stats(spender) });
          }
          if (event.blocked && !event.ok) {
            // the connection or the account let the turn down, and every
            // prompt behind it would meet the same, one after another: the
            // queue stands by for the user, and the dropped turn waits for
            // the line to come back
            holdForTheWorld(ctx, projectId, event.blocked, event.resetsAt);
            maybeRetry(ctx, projectId, event);
          } else {
            // a turn that landed is the line answering
            if (event.ok) ctx.queues.connectionBack(projectId);
            // the chat asked to compact itself, with a note: it is compacted
            // now, and a prompt with its note carries on in the fresh session
            // — ahead of the queue, which follows it there
            const self = selfCompactDue(ctx, projectId, event);
            // a context past its share of the window is compacted now, by
            // ruri, before the harness's own compaction would — and the
            // queue moves after it, into the fresh session
            const due = event.ok && self === undefined ? autoCompactDue(ctx, projectId) : undefined;
            if (self !== undefined) {
              ctx.retries.cancelRetry(projectId);
              // a message the job was answering goes on with it: this turn's
              // end doesn't answer it (marked now, before talkTurnEnded
              // below), the fresh session's turn that finishes the job does
              const from = carryLetter(ctx, projectId);
              setImmediate(() => selfCompact(ctx, projectId, self, from));
            } else if (due) {
              ctx.retries.cancelRetry(projectId);
              setImmediate(() => compactChannel(ctx, projectId, due));
            } else if (!drainQueue(ctx, projectId)) maybeRetry(ctx, projectId, event);
            // a prompt already waiting is a better answer to a dropped turn
            // than a nudge is, and it has just gone out
            else ctx.retries.cancelRetry(projectId);
          }
          // a message from another agent that started this turn is answered
          // by it — read before the next prompt (a microtask away) lands
          talkTurnEnded(ctx, projectId, event);
        }
      },
      onCompacted: (projectId, info) => noteSelfCompaction(ctx, projectId, info),
      onEventUpdate: (projectId, raw) => {
        // a subagent's card moving along: replaced where it stands, and
        // only while it still stands in the live transcript
        const event = redacted(ctx, raw);
        if (ctx.archive.replace(projectId, event)) ctx.clients.pushEvent(projectId, event);
      },
      onAgentEvent: (projectId, key, raw) => {
        const event = redacted(ctx, raw);
        ctx.readable.allowReadImages(projectId, [event]);
        ctx.agentLogs.append(projectId, key, event);
        // an agent's log is only ever open in the chat that started it
        ctx.clients.toViewers(projectId, { type: "agent_event", projectId, key, event });
      },
      onDelta: (projectId, messageId, delta) => {
        let held = ctx.turns.gates.get(projectId);
        if (!held || held.messageId !== messageId) {
          held = { messageId, gate: new ParagraphGate(), shown: "" };
          ctx.turns.gates.set(projectId, held);
        }
        const ready = held.gate.push(delta);
        if (!ready) return;
        held.shown += ready;
        ctx.clients.toViewers(projectId, { type: "delta", projectId, messageId, delta: ready });
      },
      onStatus: (projectId, status) => {
        if (status === "working" || status === "permission") {
          ctx.bridge.cancelBridgeClose(projectId);
          ctx.turns.startTurn(projectId);
          // coming back from a card the user sat on for ten minutes is not
          // a silence the model owes anyone an explanation for
          const turn = ctx.turns.progress.get(projectId);
          if (turn && status === "working") turn.at = Date.now();
        } else {
          ctx.turns.endTurn(projectId);
          ctx.turns.gates.delete(projectId);
          ctx.bridge.closeBridgeSoon(projectId);
        }
        ctx.clients.broadcast({ type: "status", projectId, status });
        // a member at work holds a slot; one done frees it for the next
        teamStatus(ctx, projectId, status);
      },
      onProgress: ctx.turns.advance,
      // an agent or a script started, ended, or was picked back up
      onBackground: (projectId) => pushWork(ctx, projectId),
      onPermission: (raw) => {
        // PreToolUse hooks run before the approval, so the input reaching
        // here may already hold a real vault value — the card shows handles
        const request: PermissionRequest = { ...raw, input: ctx.secrets.redactInput(raw.input) };
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
      onModels: ctx.models.report,
      onSessionId: (projectId, sessionId) => ctx.archive.setLastSessionId(projectId, sessionId),
      // what a harness's session holds moves on only as its turns end
      onSeen: (projectId, sessionId, eventId) => ctx.archive.noteSeen(projectId, sessionId, eventId),
      onLostStart: (projectId, sessionId, lost, prompts) =>
        recoverLostStart(ctx, projectId, sessionId, lost, prompts),
      onContext: (projectId, tokens, window) => {
        // the window is recorded first: contextWindow() reads it back, so a
        // harness that names its own is answered with that same number — and
        // recorded against the model that named it, so it dies with it
        const model = channelProject(ctx, projectId)?.model || ctx.store.defaultModel();
        ctx.archive.setContextTokens(projectId, tokens, window, model);
        if (window) ctx.models.windows.set(model, window);
        // and against the turn in flight, for a rewind to go back to
        ctx.archive.noteTurnContext(projectId, tokens);
        const context: ContextUsage = { tokens, window: contextWindow(ctx, projectId) };
        ctx.turns.contexts.set(projectId, context);
        ctx.clients.broadcast({ type: "context", projectId, context });
      },
      onChain: (projectId, eventId, kind, uuid, harness) =>
        ctx.archive.setChain(projectId, eventId, kind, uuid, harness),
    },
    // the chat's session on the harness being built for — each harness it
    // has run on keeps its own, so a switch back resumes where it left off
    (projectId, harness) => ctx.archive.sessionOn(projectId, harness),
    (project) => {
      if (project.id === HOME_ID) {
        return tagged(
          project.id,
          managerExtras(ctx.managerHost, ctx.store.workspaceDir(), ctx.homeLog.path()),
        );
      }
      // the same words wherever the session runs: Claude takes them as an
      // append to its own preset, everything else as its whole system prompt
      const harness = ctx.models.registry.parse(project.model || ctx.store.defaultModel()).providerId;
      const claude = !harness;
      // the bridge reaches Claude as tools and everything else as one HTTP
      // endpoint on this server — whose port is only known once it listens,
      // which is long before any session is made
      const owner = ownerProject(ctx, project.id);
      const bridgeCtx = { channelId: project.id, projectId: owner?.id ?? project.id };
      // the project's lead runs its team, and so does its liaison — the lead
      // other projects' agents reach; every other chat is on it
      const seat = owner?.sessions.find((session) => session.id === project.id);
      const head: Head | undefined = !owner
        ? undefined
        : seat?.liaison
          ? "liaison"
          : leadOf(owner)?.id === project.id
            ? "lead"
            : undefined;
      const role = head ?? "member";
      const talkEndpoint = `http://127.0.0.1:${ctx.listeningPort}/talk/${project.id}`;
      const team = !owner
        ? ""
        : head
          ? leadBriefing(owner.name, claude ? "tool" : "http", talkEndpoint, head)
          : memberBriefing({
              project: owner.name,
              name: seat?.title ?? "",
              duty: seat?.duty ?? "general work in this project",
              ...(seat?.layers ? { layers: seat.layers } : {}),
            });
      if (owner) ensureLibrarySkill(ctx, owner.id);
      const bridge = !ctx.options.bridge
        ? ""
        : claude
          ? bridgeToolBriefing()
          : bridgeHttpBriefing(`http://127.0.0.1:${ctx.listeningPort}/bridge/${project.id}`);
      const note = sessionBriefing({
        projectDir: project.path,
        projectName: project.name,
        secrets: ctx.secrets,
        claude,
        // Claude gets a tool for naming, and asks the user; everything
        // else registers from the shell with `ruri register`
        naming: claude ? "tool" : "",
        bridge,
        // the other agents open in ruri: tools, or the same over HTTP —
        // told how long one call waits on this harness
        talk: claude ? talkToolBriefing(!!head) : talkHttpBriefing(talkEndpoint, httpWaitMs(harness), !!head),
        team,
        // how full its context is, and compacting itself: the same words
        // in every session, the figures riding in with each prompt
        context: owner ? contextBriefing(claude ? undefined : talkEndpoint) : "",
        stack: owner ? stackBriefing(ctx.briefs.get(owner.id)) : "",
      });
      return tagged(project.id, {
        transcript: () => ctx.archive.events(project.id),
        // Claude Code compacted on its own: ruri's context goes back in
        afterCompact: async () => afterCompactBrief(ctx, project.id) || undefined,
        // and how full its context is, as it climbs mid-turn
        ...(owner ? { contextNotice: (added: number) => contextNotice(ctx, project.id, added) } : {}),
        // a lead and the liaison delegate: no changing files, no subagents
        // of their own — refused with whom to hand the job instead — and a
        // member and the liaison ask no questions on cards; then a word
        // mid-turn when a lead's shell starts doing the job for it
        ...(owner
          ? { refuse: { tools: refusedFor(role), reason: (tool: string) => refusal(tool, role) } }
          : {}),
        ...(head ? { afterTools: leadOnTools(ctx, project.id, head) } : {}),
        fillSecrets: (input) =>
          ctx.secrets.wanted(JSON.stringify(input)) ? ctx.secrets.fillInput(input) : undefined,
        beforeTools: () => ctx.checkpoints.idle(project.id),
        // ruri asks the user about these itself, message by message
        autoAllow: [
          ...COMPONENT_TOOLS,
          ...BRIDGE_TOOLS,
          ...TALK_TOOLS,
          ...(owner ? CONTEXT_TOOLS : []),
          ...(head ? TEAM_TOOLS : []),
        ],
        options: {
          // the vault rides into the harness process here, and only here —
          // beside the `ruri` command and where it posts
          env: { ...ctx.secrets.env(), ...cliEnv(libraryEndpoint(ctx, project.id)) },
          mcpServers: {
            ruri: componentTools(ctx.componentHost, project.id, [
              ...talkTools(talkHost(ctx), project.id, !!head),
              ...(owner ? contextTools(ctx, project.id) : []),
              ...(head ? teamTools(teamHost(ctx), project.id) : []),
            ]),
            bridge: bridgeTools(ctx.options.bridge, bridgeCtx),
          },
          // the component library as a skill, whose list changes and whose
          // description never does (server/library.ts)
          ...(owner
            ? { plugins: [{ type: "local", path: skillDir(owner.id), skipMcpDiscovery: true }] }
            : {}),
          ...(note ? { systemPrompt: { type: "preset", preset: "claude_code", append: note } } : {}),
        },
        ...(note ? { providerSystem: note } : {}),
      });
    },
    {
      parse: (model) => ctx.models.registry.parse(model),
      // the chat's id rides in beside the vault, for the same reason it
      // does in `tagged` below (server/resources.ts)
      create: (id, workDir, channelId) =>
        ctx.models.registry.createFor(id, workDir, {
          ...ctx.secrets.env(),
          ...(channelId === HOME_ID ? {} : cliEnv(libraryEndpoint(ctx, channelId))),
          RURI_CHANNEL: channelId,
        }),
      canFork: (id) => ctx.models.registry.canForkSession(id),
    },
    (projectId, resumeId) => ctx.archive.resumeAtFor(projectId, resumeId),
  );
  // an unset model is whatever Settings crowned, read live
  manager.useDefaultModel(() => ctx.store.defaultModel());
  // between turns a process stays for the chat open in a window someone is
  // looking at, a prompt queued behind the turn, or a retry about to go —
  // for nothing else. A team member's line waiting on a slot is not about
  // to go, so it holds nothing: the member sleeps until its slot comes
  manager.useKeepWarm(
    (id) =>
      ctx.clients.isOpen(id) ||
      ((ctx.queues.entries.get(id)?.length ?? 0) > 0 && !ctx.governor.waiting.includes(id)) ||
      ctx.retries.has(id),
  );
  // open, but only where nobody is looking: held on the short lease, so a
  // moment in another app costs nothing and an afternoon costs no battery
  manager.useDozing((id) => ctx.clients.isDozing(id));
  return manager;
}
