/**
 * The chats' session manager: Home and every project session, wired to
 * the rest of the server — each event recorded and pushed, a finished
 * turn's spend, queue and retry, the cards a turn raises, and what each
 * session is told and given (its briefing, the vault, ruri's tools).
 */
import type { ContextUsage, PermissionRequest } from "../shared/protocol.js";
import { BRIDGE_TOOLS, bridgeHttpBriefing, bridgeTools, bridgeToolBriefing } from "./bridge.js";
import { sessionBriefing } from "./briefing.js";
import { channelProject, ownerProject } from "./channel.js";
import { COMPONENT_TOOLS, componentTools } from "./components.js";
import type { ServerContext } from "./context.js";
import { drainQueue, holdForTheWorld, maybeRetry } from "./dispatch.js";
import { recordEvent, redacted } from "./events.js";
import { recoverLostStart } from "./handoff.js";
import { ensureLibrarySkill, libraryEndpoint } from "./handlers/components.js";
import { cliEnv, skillDir } from "./library.js";
import { HOME_ID, managerExtras } from "./manager.js";
import { talkHost, talkTurnEnded } from "./handlers/talk.js";
import { ParagraphGate } from "./paragraphs.js";
import { SessionManager, type SessionExtras } from "./sessions.js";
import { TALK_TOOLS, talkHttpBriefing, talkToolBriefing, talkTools } from "./talk.js";
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
            // a prompt already waiting is a better answer to a dropped turn
            // than a nudge is, and it has just gone out
            if (!drainQueue(ctx, projectId)) maybeRetry(ctx, projectId, event);
            else ctx.retries.cancelRetry(projectId);
          }
          // a message from another agent that started this turn is answered
          // by it — read before the next prompt (a microtask away) lands
          talkTurnEnded(ctx, projectId, event);
        }
      },
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
      onLostStart: (projectId, sessionId, lost, prompts) =>
        recoverLostStart(ctx, projectId, sessionId, lost, prompts),
      onContext: (projectId, tokens, window) => {
        // the window is recorded first: contextWindow() reads it back, so a
        // harness that names its own is answered with that same number — and
        // recorded against the model that named it, so it dies with it
        const model = channelProject(ctx, projectId)?.model || ctx.store.defaultModel();
        ctx.archive.setContextTokens(projectId, tokens, window, model);
        // and against the turn in flight, for a rewind or a fork to go back to
        ctx.archive.noteTurnContext(projectId, tokens);
        const context: ContextUsage = { tokens, window: contextWindow(ctx, projectId) };
        ctx.turns.contexts.set(projectId, context);
        ctx.clients.broadcast({ type: "context", projectId, context });
      },
      onChain: (projectId, eventId, kind, uuid) => ctx.archive.setChain(projectId, eventId, kind, uuid),
    },
    (projectId) => ctx.archive.lastSessionId(projectId),
    (project) => {
      if (project.id === HOME_ID) {
        return tagged(
          project.id,
          managerExtras(ctx.managerHost, ctx.store.workspaceDir(), ctx.homeLog.path()),
        );
      }
      // the same words wherever the session runs: Claude takes them as an
      // append to its own preset, everything else as its whole system prompt
      const claude = !ctx.models.registry.parse(project.model || ctx.store.defaultModel()).providerId;
      // the bridge reaches Claude as tools and everything else as one HTTP
      // endpoint on this server — whose port is only known once it listens,
      // which is long before any session is made
      const owner = ownerProject(ctx, project.id);
      const bridgeCtx = { channelId: project.id, projectId: owner?.id ?? project.id };
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
        // the other agents open in ruri: tools, or the same over HTTP
        talk: claude
          ? talkToolBriefing()
          : talkHttpBriefing(`http://127.0.0.1:${ctx.listeningPort}/talk/${project.id}`),
      });
      return tagged(project.id, {
        transcript: () => ctx.archive.events(project.id),
        fillSecrets: (input) =>
          ctx.secrets.wanted(JSON.stringify(input)) ? ctx.secrets.fillInput(input) : undefined,
        beforeTools: () => ctx.checkpoints.idle(project.id),
        // ruri asks the user about these itself, message by message
        autoAllow: [...COMPONENT_TOOLS, ...BRIDGE_TOOLS, ...TALK_TOOLS],
        options: {
          // the vault rides into the harness process here, and only here —
          // beside the `ruri` command and where it posts
          env: { ...ctx.secrets.env(), ...cliEnv(libraryEndpoint(ctx, project.id)) },
          mcpServers: {
            ruri: componentTools(ctx.componentHost, project.id, talkTools(talkHost(ctx), project.id)),
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
    (projectId, resumeId) => ctx.archive.takeResumeAt(projectId, resumeId),
    (projectId, resumeId) => ctx.archive.takeForkNext(projectId, resumeId),
  );
  // an unset model is whatever Settings crowned, read live
  manager.useDefaultModel(() => ctx.store.defaultModel());
  // between turns a process stays for the chat open in a window someone is
  // looking at, a prompt queued behind the turn, or a retry about to go —
  // for nothing else
  manager.useKeepWarm(
    (id) => ctx.clients.isOpen(id) || (ctx.queues.entries.get(id)?.length ?? 0) > 0 || ctx.retries.has(id),
  );
  // open, but only where nobody is looking: held on the short lease, so a
  // moment in another app costs nothing and an afternoon costs no battery
  manager.useDozing((id) => ctx.clients.isDozing(id));
  return manager;
}
