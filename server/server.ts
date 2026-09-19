import { HOME_TRANSCRIPT_MAX } from "../shared/protocol.js";
import * as fs from "node:fs";
import type {
  ContextUsage,
  PermissionRequest,
} from "../shared/protocol.js";
import { SessionArchive } from "./archive.js";
import { writeTextAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { AgentLogs, Crew } from "./agents.js";
import { BridgeState } from "./bridgeState.js";
import { channelProject, ownerProject, running } from "./channel.js";
import { Clients } from "./clients.js";
import { DigestFolder, refreshArchivedTurnFiles, removeTurnFiles } from "./compaction.js";
import type { PendingComponent, RuriServer, ServerContext, StartServerOptions } from "./context.js";
import { DraftStore } from "./drafts.js";
import { UsageGauges } from "./gauges.js";
import { HomeLog } from "./homelog.js";
import { createCheckpoints } from "./checkpoints.js";
import { HOME_ID, managerExtras } from "./manager.js";
import { Models } from "./models.js";
import { defaultMusicDir } from "./music.js";
import { claimPort, type PortClaim } from "./port.js";
import { PrefStore } from "./prefs.js";
import { ProjectStore } from "./projects.js";
import { SendQueues } from "./queue.js";
import { briefless, rebuildCatchup } from "./catchupBrief.js";
import { createTurnTracker, recordEvent, redacted } from "./events.js";
import { backfillNotes, NoteBackfill } from "./notes.js";
import { ReadableImages } from "./readable.js";
import { Retries } from "./retry.js";
import { SessionManager } from "./sessions.js";
import {
  digestHistory,
  setSmallModel,
} from "./smallmodel.js";
import { BriefStore, writeCatchupFile } from "./brief.js";
import { LedgerStore } from "./ledger.js";
import { sessionBriefing } from "./briefing.js";
import {
  BRIDGE_TOOLS,
  bridgeHttpBriefing,
  bridgeToolBriefing,
  bridgeTools,
} from "./bridge.js";
import {
  COMPONENT_TOOLS,
  ComponentStore,
  componentDropBriefing,
  componentTools,
  drainComponentRequests,
  writeIndexFile,
} from "./components.js";
import { IdeaStore } from "./ideas.js";
import { ParagraphGate } from "./paragraphs.js";
import { sweepOrphans } from "./orphans.js";
import { SecretStore } from "./secrets.js";
import { Terminals } from "./terminal.js";
import { TrackerStore } from "./tracker.js";
import { contextWindow, pushContexts, Turns } from "./turns.js";
import { sweepUploads } from "./uploads.js";
import { warn } from "./log.js";
import { createHttpServer } from "./routes.js";
import { createSocketServer } from "./socket.js";
import { drainQueue, maybeRetry } from "./dispatch.js";
import { createComponentHost } from "./handlers/components.js";
import { createCrewManager } from "./handlers/crew.js";
import { createManagerHost } from "./handlers/projects.js";

export type { RuriServer, StartServerOptions } from "./context.js";

export async function startServer(options: StartServerOptions): Promise<RuriServer> {
  const store = new ProjectStore();
  setSmallModel(store.smallModel());

  const archive = new SessionArchive();
  /** What each subagent did, apart from the chat that started it. */
  const agentLogs = new AgentLogs();
  const crew = new Crew();
  // Home is ephemeral: it keeps its newest events and lets the rest go
  archive.cap(HOME_ID, HOME_TRANSCRIPT_MAX);
  // Home is ephemeral — it exists to open projects, not to accumulate
  // context. Every launch starts it blank (no transcript, no resume).
  archive.remove(HOME_ID);
  removeTurnFiles(HOME_ID);
  agentLogs.remove(HOME_ID);
  // Home's chat is ephemeral, but its activity persists in the write-ahead
  // log — appended programmatically per event, grepped by the model.
  const homeLog = new HomeLog();
  const tracker = new TrackerStore();
  const briefs = new BriefStore();
  // what every project has spent, by the day — the one count that survives
  // rewinds, compactions and Home's nightly amnesia
  const ledger = new LedgerStore();
  // the two per-PROJECT boards (everything else here is per session)
  const ideas = new IdeaStore();
  const components = new ComponentStore();
  // the vault: handed to each harness process as $RURI_SECRET_* when it is
  // built (below), and to nothing else ruri starts
  const secrets = new SecretStore();
  // The window's own preferences, kept on this machine rather than in the
  // window — see server/prefs.ts for why that is not where they belong.
  const prefs = new PrefStore();
  // both project files are written from what's already on disk at startup, so
  // a session opened before anything happens still finds them there
  for (const project of store.list()) {
    writeIndexFile(project.path, components.items(project.id));
    // briefs used to be kept per session; a project's brief is the project's
    for (const session of project.sessions) briefs.move(session.id, project.id);
    writeCatchupFile(project.path, project.name, briefs.get(project.id));
    for (const session of project.sessions) {
      // Older compacted exchanges retained attachment metadata in the
      // transcript but not in their .md record. Rewriting only archives that
      // already exist makes those images available to the model immediately.
      refreshArchivedTurnFiles(session.id, () => archive.allEvents(session.id));
    }
  }
  // half-written prompts, per channel — outliving both the wiped Home
  // archive above and any rewind that truncates a session's
  const drafts = new DraftStore();
  const clients = new Clients();
  const ctx = {
    options,
    listeningPort: options.port,
    store,
    archive,
    agentLogs,
    crew,
    homeLog,
    tracker,
    briefs,
    ledger,
    ideas,
    components,
    secrets,
    prefs,
    drafts,
    checkpoints: createCheckpoints(),
    // The composer's terminal mode: a row of shell tabs per channel, each in
    // that project's directory, alive for as long as the app is — switching
    // away and back attaches to the same shells, scrollback and all.
    terminals: new Terminals({
      onData: (projectId, termId, data) =>
        clients.broadcast({ type: "terminal_data", projectId, termId, data }),
      onExit: (projectId, termId, note) =>
        clients.broadcast({ type: "terminal_exit", projectId, termId, note }),
    }),
    digests: new DigestFolder(archive, digestHistory),
    clients,
    readable: new ReadableImages((channelId) => ownerProject(ctx, channelId)?.path),
    turns: new Turns(clients.toViewers),
    queues: new SendQueues(clients.broadcast),
    notes: new NoteBackfill(),
    retries: new Retries(),
    models: new Models(clients.broadcast),
    usage: new UsageGauges(clients.broadcast),
    bridge: new BridgeState(options.bridge, (channelId) => running(ctx, channelId), clients.broadcast),
    permissions: new Map<string, PermissionRequest>(),
    pendingComponents: new Map<string, PendingComponent>(),
    sweeping: new Set<string>(),
    catchingUp: new Set<string>(),
    crewSaid: new Map<string, string>(),
    musicRoot: () => store.customMusicDir() ?? defaultMusicDir(),
    // the session managers, the turn tracker and the two hosts are wired
    // below, once there is a context for them to see
  } as ServerContext;

  ctx.models.probeModels();

  ctx.usage.pushUsage(true);

  const usageTimer = setInterval(() => {
    ctx.usage.pushUsage(true);
    pushContexts(ctx);
  }, 5 * 60_000);
  // The uploads nothing mentions any more go, once things have settled
  // after launch and then twice a day (server/uploads.ts). Neither timer
  // holds the process open.
  const sweepTimer = setInterval(() => sweepUploads(), 12 * 60 * 60_000);
  sweepTimer.unref();
  const firstSweep = setTimeout(() => {
    const gone = sweepUploads();
    if (gone) console.log(`ruri: removed ${gone} upload${gone === 1 ? "" : "s"} nothing refers to`);
    const orphans = sweepOrphans();
    if (orphans) console.log(`ruri: removed ${orphans} file${orphans === 1 ? "" : "s"} left by closed sessions`);
  }, 30_000);
  firstSweep.unref();
  // every note the small model missed — a spent quota, a quit mid-call —
  // right after launch, so a chat is noted before anyone opens it, then
  // hourly (backfillNotes)
  const allNotes = () => backfillNotes(ctx, store.sessionIds());
  const firstNotes = setTimeout(allNotes, 5_000);
  firstNotes.unref();
  const notesTimer = setInterval(allNotes, 60 * 60_000);
  notesTimer.unref();
  const componentHost = createComponentHost(ctx);
  ctx.componentHost = componentHost;

  // Projects that arrived before this existed: one at a time, in the
  // background, so a launch with ten of them does not fire ten reads of the
  // small model at once.
  void (async () => {
    for (const project of store.list()) {
      if (!briefless(ctx, project.id)) continue;
      await rebuildCatchup(ctx, project.id);
    }
  })();

  ctx.turnTracker = createTurnTracker(ctx);

  const manager = new SessionManager(
    {
      onEvent: (projectId, event) => {
        // the finished message carries its whole text — the held tail too
        if (event.kind === "assistant" && ctx.turns.gates.get(projectId)?.messageId === event.id) ctx.turns.gates.delete(projectId);
        ctx.readable.allowReadImages(projectId, [event]);
        recordEvent(ctx, projectId, event);
        if (event.kind === "result") {
          ctx.usage.pushUsage();
          pushContexts(ctx);
          // the turn's spend lands in its project's ledger (Home in its own)
          const spender = projectId === HOME_ID ? HOME_ID : ownerProject(ctx, projectId)?.id;
          if (spender && (event.tokens || event.costUsd || event.durationMs)) {
            ledger.record(spender, {
              ...(event.tokens ? { tokens: event.tokens } : {}),
              ...(event.costUsd ? { costUsd: event.costUsd } : {}),
              ...(event.durationMs ? { ms: event.durationMs } : {}),
            });
            ctx.clients.broadcast({ type: "stats", projectId: spender, stats: ledger.stats(spender) });
          }
          // a harness without ruri's tools names its components in a file
          const owner = ownerProject(ctx, projectId);
          if (owner) drainComponentRequests(owner.path, projectId, componentHost);
          // a prompt already waiting is a better answer to a dropped turn
          // than a nudge is, and it has just gone out
          if (!drainQueue(ctx, projectId)) maybeRetry(ctx, projectId, event);
          else ctx.retries.cancelRetry(projectId);
        }
      },
      onEventUpdate: (projectId, raw) => {
        // a subagent's card moving along: replaced where it stands, and
        // only while it still stands in the live transcript
        const event = redacted(ctx, raw);
        if (archive.replace(projectId, event)) ctx.clients.pushEvent(projectId, event);
      },
      onAgentEvent: (projectId, key, raw) => {
        const event = redacted(ctx, raw);
        ctx.readable.allowReadImages(projectId, [event]);
        agentLogs.append(projectId, key, event);
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
      onPermission: (raw) => {
        // PreToolUse hooks run before the approval, so the input reaching
        // here may already hold a real vault value — the card shows handles
        const request: PermissionRequest = { ...raw, input: secrets.redactInput(raw.input) };
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
      onSessionId: (projectId, sessionId) => archive.setLastSessionId(projectId, sessionId),
      onContext: (projectId, tokens, window) => {
        // the window is recorded first: contextWindow() reads it back, so a
        // harness that names its own is answered with that same number — and
        // recorded against the model that named it, so it dies with it
        const model = channelProject(ctx, projectId)?.model || store.defaultModel();
        archive.setContextTokens(projectId, tokens, window, model);
        const context: ContextUsage = { tokens, window: contextWindow(ctx, projectId) };
        ctx.turns.contexts.set(projectId, context);
        ctx.clients.broadcast({ type: "context", projectId, context });
      },
      onChain: (projectId, eventId, kind, uuid) => archive.setChain(projectId, eventId, kind, uuid),
    },
    (projectId) => archive.lastSessionId(projectId),
    (project) => {
      if (project.id === HOME_ID) {
        return managerExtras(managerHost, store.workspaceDir(), homeLog.path());
      }
      // the same words wherever the session runs: Claude takes them as an
      // append to its own preset, everything else as its whole system prompt
      const claude = !ctx.models.registry.parse(project.model || store.defaultModel()).providerId;
      // the bridge reaches Claude as tools and everything else as one HTTP
      // endpoint on this server — whose port is only known once it listens,
      // which is long before any session is made
      const owner = ownerProject(ctx, project.id);
      const bridgeCtx = { channelId: project.id, projectId: owner?.id ?? project.id };
      const bridge = !options.bridge
        ? ""
        : claude
          ? bridgeToolBriefing()
          : bridgeHttpBriefing(`http://127.0.0.1:${ctx.listeningPort}/bridge/${project.id}`);
      const note = sessionBriefing({
        projectDir: project.path,
        projectName: project.name,
        secrets,
        claude,
        // Claude gets tools for naming; everything else gets the drop file
        naming: claude ? "tool" : componentDropBriefing(project.path),
        bridge,
      });
      return {
        fillSecrets: (input) =>
          secrets.wanted(JSON.stringify(input)) ? secrets.fillInput(input) : undefined,
        autoAllow: [...COMPONENT_TOOLS, ...BRIDGE_TOOLS],
        options: {
          // the vault rides into the harness process here, and only here
          env: secrets.env(),
          mcpServers: {
            ruri: componentTools(componentHost, project.id),
            bridge: bridgeTools(options.bridge, bridgeCtx),
          },
          ...(note ? { systemPrompt: { type: "preset", preset: "claude_code", append: note } } : {}),
        },
        ...(note ? { providerSystem: note } : {}),
      };
    },
    {
      parse: (model) => ctx.models.registry.parse(model),
      create: (id, workDir) => ctx.models.registry.createFor(id, workDir, secrets.env()),
      canFork: (id) => ctx.models.registry.canForkSession(id),
    },
    (projectId) => archive.takeResumeAt(projectId),
    (projectId) => archive.takeForkNext(projectId),
  );
  ctx.manager = manager;
  // an unset model is whatever Settings crowned, read live
  manager.useDefaultModel(() => store.defaultModel());
  // between turns a process stays for the chat open in a window, a prompt
  // queued behind the turn, or a retry about to go — for nothing else
  manager.useKeepWarm((id) => ctx.clients.isOpen(id) || (ctx.queues.entries.get(id)?.length ?? 0) > 0 || ctx.retries.has(id));

  ctx.crewManager = createCrewManager(ctx);
  ctx.crewManager.useDefaultModel(() => store.defaultModel());

  const managerHost = createManagerHost(ctx);
  ctx.managerHost = managerHost;

  const server = createHttpServer(ctx);
  const wss = createSocketServer(ctx, server);

  const host = options.host ?? "127.0.0.1";

  // The port is part of the app's identity, not an implementation detail: the
  // window is served from it, so a different port every launch means a
  // different origin every launch, and everything the window keeps for itself
  // (localStorage) starts empty. That is worth more than politeness about a
  // port, so a ruri that outlived its app is retired for it before the
  // fallback below is ever reached — see server/port.ts.
  let claim: PortClaim = { outcome: "free" };
  if (options.reclaimPort && options.port !== 0) {
    claim = await claimPort(options.port, host);
    if (claim.outcome === "reclaimed") {
      console.log(
        `ruri took port ${options.port} back from a server that outlived its app (pid ${claim.pid})`,
      );
    }
  }

  return new Promise((resolve, reject) => {
    // Only a port that is still in use after all that falls back to an
    // ephemeral one, and it says so: a window on the wrong origin looks like
    // a ruri that has forgotten its preferences, and silence about why is
    // what makes that a mystery instead of a message.
    let attempt = options.port;
    let fallback: { wanted: number; reason: string } | undefined;
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && attempt !== 0) {
        fallback = {
          wanted: options.port,
          reason: claim.outcome === "held" ? claim.reason : "another program is using it",
        };
        console.warn(
          `ruri could not have port ${options.port}: ${fallback.reason}. ` +
            `Falling back to an ephemeral port — this window starts on a new origin, ` +
            `so anything it keeps for itself will look empty.`,
        );
        attempt = 0;
        server.listen(0, host);
        return;
      }
      reject(error);
    });
    server.listen(attempt, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      ctx.listeningPort = port;
      console.log(`ruri server listening on ws://127.0.0.1:${port}`);
      // for local tooling that wants in: the token, readable by this user only
      const tokenFile = configPath("token");
      try {
        writeTextAtomic(tokenFile, options.token, 0o600);
      } catch (err) {
        warn("server", err, "writing the token file");
      }
      resolve({
        port,
        ...(fallback ? { portFallback: fallback } : {}),
        close: () =>
          new Promise<void>((done) => {
            clearInterval(usageTimer);
            clearInterval(sweepTimer);
            clearTimeout(firstSweep);
            ctx.usage.stop();
            ctx.terminals.closeAll();
            void options.bridge?.closeAll();
            manager.disposeAll();
            ctx.crewManager.disposeAll();
            archive.flushAll();
            agentLogs.flushAll();
            crew.flushAll();
            ledger.flush();
            try {
              fs.rmSync(tokenFile, { force: true });
            } catch (err) {
              warn("server", err, "removing the token file");
            }
            for (const client of ctx.clients.sockets) client.close();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
