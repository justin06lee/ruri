import { randomUUID } from "node:crypto";
import { type AskQuestions, HOME_TRANSCRIPT_MAX, TRANSCRIPT_TAIL } from "../shared/protocol.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type {
  ClientMessage,
  ContextUsage,
  PermissionRequest,
  ServerMessage,
} from "../shared/protocol.js";
import { clientMessageSchema, describeIssue } from "../shared/clientSchema.js";
import { SessionArchive } from "./archive.js";
import { writeTextAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { AgentLogs, Crew } from "./agents.js";
import { BridgeState } from "./bridgeState.js";
import { busy, channelProject, ownerProject, running, terminalCwd } from "./channel.js";
import { catchUp, Clients, transcriptOf } from "./clients.js";
import { buildCompaction, DigestFolder, refreshArchivedTurnFiles, removeTurnFiles } from "./compaction.js";
import type { PendingComponent, RuriServer, ServerContext, StartServerOptions } from "./context.js";
import { DraftStore } from "./drafts.js";
import { UsageGauges } from "./gauges.js";
import { HomeLog } from "./homelog.js";
import { createCheckpoints } from "./checkpoints.js";
import { HOME_ID, managerExtras, type ManagerHost } from "./manager.js";
import { Models } from "./models.js";
import { defaultMusicDir } from "./music.js";
import { claimPort, type PortClaim } from "./port.js";
import { PrefStore } from "./prefs.js";
import { ProjectStore } from "./projects.js";
import { mergeEntries, reslot, SendQueues, type QueueEntry } from "./queue.js";
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
import { knownCommands, listCommands, splitCommands } from "./commands.js";
import { findProjects } from "./finder.js";
import { LedgerStore } from "./ledger.js";
import { importRecent, listRecent } from "./recent.js";
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
import { installSkill, listSkills, readSkill, removeSkill, scanSkills, toggleSkill, updateSkills } from "./skills.js";
import { Terminals } from "./terminal.js";
import { TrackerStore } from "./tracker.js";
import { contextWindow, pushContexts, republishContext, Turns } from "./turns.js";
import { storeAttachments, storedFilePath, storeUpload, sweepUploads } from "./uploads.js";
import { errorMessage, warn } from "./log.js";
import { originAllowed, presentedToken, tokenMatches } from "./auth.js";
import { createHttpServer } from "./routes.js";
import { dispatch, dispatchSplit, drainQueue, maybeRetry, queueWithCommands, titleSession } from "./dispatch.js";
import { componentHandlers, createComponentHost } from "./handlers/components.js";
import { rewindHandlers } from "./handlers/rewind.js";
import { createCrewManager, crewHandlers, followCrew } from "./handlers/crew.js";
import type { Handler, MessageType } from "./handlers/types.js";

export type { RuriServer, StartServerOptions } from "./context.js";

export async function startServer(options: StartServerOptions): Promise<RuriServer> {
  const store = new ProjectStore();
  setSmallModel(store.smallModel());

  /** The roles changed: the small layer and every window hear the new set.
   *  A new default pins nothing live (the store already did), so the
   *  projects list goes out too — the pinned values are now on them. */
  function announceRoles(roles: { starred: string[]; small: string | undefined; default: string | undefined }): void {
    setSmallModel(roles.small);
    ctx.clients.broadcast({ type: "starred_models", models: roles.starred });
    ctx.clients.broadcast({ type: "small_model", model: roles.small ?? "" });
    ctx.clients.broadcast({ type: "default_model", model: store.defaultModel() });
    ctx.clients.broadcast({ type: "projects", projects: store.list() });
    ctx.clients.broadcast({ type: "home_settings", home: store.homeSettings() });
  }
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

  /** Re-scan skills for a project (or just the global ones) and push. */
  function pushSkills(projectId?: string, note?: string): void {
    const dir = projectId ? store.get(projectId)?.path : undefined;
    void scanSkills(dir).then((skills) =>
      ctx.clients.broadcast({
        type: "skills",
        ...(projectId ? { projectId } : {}),
        skills,
        ...(note ? { note } : {}),
      }),
    );
  }

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

  /** Tear down one project and everything its sessions accumulated. */
  function closeProjectById(projectId: string): void {
    const closing = store.get(projectId);
    for (const sessionId of closing?.sessions.map((s) => s.id) ?? []) {
      if (closing?.path) void ctx.checkpoints.forgetChannel(closing, sessionId).catch(() => undefined);
      manager.dispose(sessionId);
      archive.remove(sessionId);
      removeTurnFiles(sessionId);
      for (const key of crew.remove(sessionId)) ctx.crewManager.dispose(key);
      agentLogs.remove(sessionId);
      drafts.remove(sessionId);
      tracker.removeProject(sessionId);
      ctx.turns.contexts.delete(sessionId);
      ctx.turns.progress.delete(sessionId);
      ctx.turns.sent.delete(sessionId);
      ctx.retries.cancelRetry(sessionId);
      ctx.queues.entries.delete(sessionId);
      ctx.queues.held.delete(sessionId);
      ctx.terminals.closeChannel(sessionId);
      ctx.bridge.closeBridge(sessionId);
    }
    briefs.remove(projectId);
    ideas.removeProject(projectId);
    components.removeProject(projectId);
    ledger.removeProject(projectId);
    store.remove(projectId);
    ctx.clients.broadcast({ type: "projects", projects: store.list() });
  }

  // What the Home agent's MCP tools may do to the app: open projects (and
  // optionally kick their sessions off), close them again, and see what's open.
  const managerHost: ManagerHost = {
    openProject: ({ path: projectPath, name, folder, kickoffPrompt }) => {
      let project = store.findByPath(projectPath);
      let opened = false;
      if (!project) {
        try {
          project = store.add(name ?? "", projectPath, folder);
          opened = true;
        } catch (err) {
          return `failed: ${errorMessage(err)}`;
        }
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        // a project new to ruri gets told what it is before anyone asks
        if (briefless(ctx, project.id)) void rebuildCatchup(ctx, project.id);
      }
      let sessionId = project.sessions[0]?.id;
      // an emptied folder (all sessions closed) gets a fresh session on reopen
      if (!sessionId) {
        sessionId = store.newSession(project.id)?.id;
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
      }
      if (kickoffPrompt && sessionId) {
        manager.send({ ...project, id: sessionId }, kickoffPrompt);
        // a session Home starts is named like one the user starts: from its
        // first prompt, now, not once the turn happens to finish
        titleSession(ctx, sessionId, kickoffPrompt);
      }
      return `${opened ? "opened" : "already open"}: ${project.name} (${project.path})${
        kickoffPrompt ? " — session started with the kickoff prompt" : ""
      }`;
    },
    newProject: (name) => {
      const clean = name.trim().replace(/\/+$/, "");
      if (!clean || clean.includes("/") || clean.startsWith(".")) return `not a folder name: "${name}"`;
      const dir = path.join(store.workspaceDir(), clean);
      if (store.findByPath(dir)) return `already open: ${clean} (${dir})`;
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        return `failed: ${errorMessage(err)}`;
      }
      return managerHost.openProject({ path: dir, name: clean }).replace(/^opened/, "created and opened");
    },
    hideProject: (query) => {
      const project = store.findByQuery(query);
      if (!project) return `no open project matches "${query}"`;
      if (project.hidden) return `already hidden: ${project.name}`;
      store.update(project.id, { hidden: true });
      ctx.clients.broadcast({ type: "projects", projects: store.list() });
      return `hidden: ${project.name} (${project.path}) — still open, tucked under "hidden" at the bottom of the sidebar`;
    },
    unhideProject: (query) => {
      const project = store.findByQuery(query);
      if (!project) return `no open project matches "${query}"`;
      if (!project.hidden) return `not hidden: ${project.name}`;
      store.update(project.id, { hidden: undefined });
      ctx.clients.broadcast({ type: "projects", projects: store.list() });
      return `unhidden: ${project.name} (${project.path})`;
    },
    closeProject: (query) => {
      const project = store.findByQuery(query);
      if (!project) return `no open project matches "${query}"`;
      closeProjectById(project.id);
      return `closed: ${project.name} (${project.path}) — files untouched`;
    },
    listProjects: () => store.list(),
    // only the workspace root from Settings — that is where projects live
    findProjects: (query) => findProjects([store.workspaceDir()], query),
  };

  const handlers = { ...componentHandlers, ...rewindHandlers, ...crewHandlers };

  function handleMessage(ws: WebSocket, msg: ClientMessage): void {
    const handler = (handlers as Partial<Record<string, Handler<MessageType>>>)[msg.type];
    if (handler) {
      handler(ctx, ws, msg as never);
      return;
    }
    switch (msg.type) {
      case "add_project": {
        const project = store.add(msg.name, msg.path, msg.folder);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        if (briefless(ctx, project.id)) void rebuildCatchup(ctx, project.id);
        break;
      }
      case "catchup_rebuild": {
        void rebuildCatchup(ctx, msg.projectId);
        break;
      }
      case "pick_folder": {
        const target = msg.target ?? "workspace";
        void (options.pickFolder?.() ?? Promise.resolve(null)).then((path) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "folder_picked", path, target } satisfies ServerMessage));
          }
        });
        break;
      }
      case "permissions_check":
      case "permissions_request": {
        const host = options.permissions;
        if (!host) break;
        const asked = msg.type === "permissions_request" ? host.request(msg.id) : host.check();
        void asked
          .then(async (items) => ({ items, rows: await host.rows() }))
          .then(({ items, rows }) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "permissions", items, rows } satisfies ServerMessage));
            }
          })
          .catch(() => {});
        break;
      }
      case "remove_project": {
        closeProjectById(msg.projectId);
        break;
      }
      case "send": {
        if (msg.text.trim().length === 0 && !msg.attachments?.length) return;
        const channelId = msg.projectId;
        const uploads = msg.attachments ?? [];
        // the user is driving again: whatever ruri was about to try again
        // for them, this prompt says it better
        ctx.retries.cancelRetry(channelId);
        // A queue that has been standing by since a stopped turn: this
        // prompt is the reason it stopped — a clarification, a correction —
        // so it goes out now, ahead of the queue, and the queue falls in
        // behind it and moves again the moment this turn is done.
        const ahead = ctx.queues.releaseQueue(channelId) && !running(ctx, channelId);
        if (queueWithCommands(ctx, channelId, msg.text, uploads, false, ahead)) break;
        if (!ahead && busy(ctx, channelId)) {
          // hold it app-side — nothing reaches the harness until the
          // running turn (and everything queued before it) finishes
          const queue = ctx.queues.entries.get(channelId) ?? [];
          queue.push({
            id: randomUUID(),
            text: msg.text,
            uploads,
            silent: false,
            ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
          });
          ctx.queues.entries.set(channelId, queue);
          ctx.queues.broadcastQueue(channelId);
          return;
        }
        dispatch(ctx, channelId, msg.text, uploads);
        break;
      }
      case "send_split": {
        if (msg.text.trim().length === 0) return;
        const channelId = msg.projectId;
        const uploads = msg.attachments ?? [];
        ctx.retries.cancelRetry(channelId);
        if (!channelProject(ctx, channelId)) throw new Error("unknown session");
        const ahead = ctx.queues.releaseQueue(channelId) && !running(ctx, channelId);
        if (queueWithCommands(ctx, channelId, msg.text, uploads, true, ahead)) break;
        dispatchSplit(ctx, channelId, msg.text, uploads, ahead);
        break;
      }
      case "queue_remove": {
        const queue = ctx.queues.entries.get(msg.projectId);
        if (!queue) break;
        const kept = queue.filter((e) => e.id !== msg.itemId || e.silent);
        if (kept.length !== queue.length) {
          if (kept.length === 0) {
            ctx.queues.entries.delete(msg.projectId);
            ctx.queues.held.delete(msg.projectId);
          } else ctx.queues.entries.set(msg.projectId, kept);
          ctx.queues.broadcastQueue(msg.projectId);
        }
        break;
      }
      case "queue_send": {
        // Sent on by hand from the queue's own card: what was standing by
        // since the stop goes out now, in the order it was written.
        if (!ctx.queues.releaseQueue(msg.projectId)) break;
        if (!running(ctx, msg.projectId)) drainQueue(ctx, msg.projectId);
        break;
      }
      case "queue_move": {
        const queue = ctx.queues.entries.get(msg.projectId);
        const moving = queue?.find((e) => e.id === msg.itemId && !e.silent && !e.editing);
        if (!queue || !moving || moving.id === msg.beforeId) break;
        const visible = queue.filter((e) => !e.silent && e !== moving);
        // the one being rewritten stays at the end, out of the line
        const line = visible.filter((e) => !e.editing);
        const at = msg.beforeId ? line.findIndex((e) => e.id === msg.beforeId) : -1;
        if (at === -1) line.push(moving);
        else line.splice(at, 0, moving);
        ctx.queues.entries.set(msg.projectId, reslot(queue, [...line, ...visible.filter((e) => e.editing)]));
        ctx.queues.broadcastQueue(msg.projectId);
        break;
      }
      case "queue_merge": {
        const queue = ctx.queues.entries.get(msg.projectId);
        if (!queue || msg.itemId === msg.intoId) break;
        const from = queue.find((e) => e.id === msg.itemId && !e.silent && !e.editing);
        const into = queue.find((e) => e.id === msg.intoId && !e.silent && !e.editing);
        if (!from || !into) break;
        const merged = mergeEntries(from, into);
        ctx.queues.entries.set(
          msg.projectId,
          queue.filter((e) => e !== from).map((e) => (e === into ? merged : e)),
        );
        ctx.queues.broadcastQueue(msg.projectId);
        break;
      }
      case "queue_edit": {
        const queue = ctx.queues.entries.get(msg.projectId);
        const entry = queue?.find((e) => e.id === msg.itemId && !e.silent);
        if (!queue || !entry || entry.editing) break;
        entry.editing = true;
        entry.editAfter = queue
          .slice(0, queue.indexOf(entry))
          .filter((e) => !e.silent && !e.editing)
          .map((e) => e.id);
        // out of the line: the rest move up, and it shows under them
        ctx.queues.entries.set(msg.projectId, [...queue.filter((e) => e !== entry), entry]);
        ctx.queues.broadcastQueue(msg.projectId);
        // a turn was waiting on it and nothing else — nothing is now
        if (!ctx.queues.held.has(msg.projectId) && !running(ctx, msg.projectId)) drainQueue(ctx, msg.projectId);
        break;
      }
      case "queue_update": {
        const channelId = msg.projectId;
        const entry = ctx.queues.entries.get(channelId)?.find((e) => e.id === msg.itemId && e.editing);
        if (!entry) {
          // the queue lost it meanwhile (a restart, a stop that cleared it):
          // then this is simply a prompt, sent the ordinary way
          handleMessage(ws, {
            type: "send",
            projectId: channelId,
            text: msg.text,
            ...(msg.attachments?.length ? { attachments: msg.attachments } : {}),
          });
          break;
        }
        const uploads = msg.attachments ?? [];
        ctx.retries.cancelRetry(channelId);
        if (msg.text.trim().length === 0 && uploads.length === 0) {
          ctx.queues.placeBack(channelId, entry, []);
          ctx.queues.broadcastQueue(channelId);
          break;
        }
        // commands written into the rewrite run ahead of it, as always
        const { commands, rest } = splitCommands(msg.text, knownCommands(ownerProject(ctx, channelId)?.path));
        const entries: QueueEntry[] = commands.map((command) => ({
          id: randomUUID(),
          text: command,
          uploads: [],
          silent: false,
        }));
        if (rest || uploads.length > 0) {
          entries.push({
            id: entry.id,
            text: rest,
            uploads,
            silent: false,
            ...(msg.split ? { split: true } : {}),
            ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
          });
        }
        ctx.queues.placeBack(channelId, entry, entries);
        // sending the rewrite is a "go": a queue standing by since a stop
        // moves again, the way it does for any prompt sent
        ctx.queues.releaseQueue(channelId);
        ctx.queues.broadcastQueue(channelId);
        if (!running(ctx, channelId)) drainQueue(ctx, channelId);
        break;
      }
      case "queue_edit_cancel": {
        const channelId = msg.projectId;
        const entry = ctx.queues.entries.get(channelId)?.find((e) => e.id === msg.itemId && e.editing);
        if (!entry) break;
        delete entry.editing;
        ctx.queues.placeBack(channelId, entry, [entry]);
        delete entry.editAfter;
        ctx.queues.broadcastQueue(channelId);
        if (!ctx.queues.held.has(channelId) && !running(ctx, channelId)) drainQueue(ctx, channelId);
        break;
      }
      case "remove_event": {
        const removed = archive.removeTurn(msg.projectId, msg.eventId);
        if (removed.length > 0) {
          ctx.clients.broadcast({ type: "events_removed", projectId: msg.projectId, eventIds: removed });
          // a removed turn takes its extracted checklist items with it
          if (tracker.removeForTurns(msg.projectId, removed)) {
            ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
          }
        }
        break;
      }
      case "transcript_get": {
        // the rest of a chat the snapshot only carried the tail of — to
        // the asker alone, with its pictures made readable on the way
        const id = msg.projectId;
        if (id !== HOME_ID && !store.sessionIds().includes(id)) break;
        ws.send(JSON.stringify(transcriptOf(ctx, id)));
        // the chat on screen gets its missing notes before any other
        backfillNotes(ctx, [id], { first: true });
        // and its digest caught up, ahead of the compaction it may be near
        void ctx.digests.run(id);
        break;
      }
      case "view": {
        const known = new Set([...store.sessionIds(), HOME_ID]);
        const view = ctx.clients.views.get(ws) ?? { channels: new Set<string>(), board: false, seen: new Map() };
        const before = view.channels;
        const hadBoard = view.board;
        view.channels = new Set(msg.channels.filter((id) => known.has(id)));
        view.board = msg.board === true;
        ctx.clients.views.set(ws, view);
        const now = view.channels;
        for (const id of before) if (!now.has(id)) view.seen.set(id, ctx.clients.revisions.get(id) ?? 0);
        for (const id of now) if (!before.has(id)) catchUp(ctx, ws, view, id);
        // the projects page coming up: every chat's tail as it now stands,
        // since the ones not on screen stopped hearing about their work
        if (view.board && !hadBoard) {
          const others = [...known].filter((id) => !now.has(id));
          ws.send(
            JSON.stringify({
              type: "tails",
              transcripts: ctx.readable.allowArchived(archive.tails(others, TRANSCRIPT_TAIL)),
            } satisfies ServerMessage),
          );
        }
        // a chat opened or left: its process looks again at whether it stays
        for (const id of new Set([...before, ...now])) {
          if (before.has(id) !== now.has(id)) manager.settle(id);
        }
        break;
      }
      case "history_get": {
        const id = msg.projectId;
        if (id !== HOME_ID && !store.sessionIds().includes(id)) break;
        const events = archive.history(id);
        ctx.readable.allowReadImages(id, events);
        ws.send(JSON.stringify({ type: "history", projectId: id, events } satisfies ServerMessage));
        break;
      }
      case "recent_list": {
        // what the harnesses hold for this project that ruri did not make:
        // every id ruri's own chats have ever run on is left out
        const project = store.get(msg.projectId);
        if (!project) break;
        const taken = archive.ownedSessionIds([...store.sessionIds(), HOME_ID]);
        void listRecent(project, taken)
          .then((items) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "recent", projectId: project.id, items } satisfies ServerMessage));
            }
          })
          .catch(() => {});
        break;
      }
      case "recent_import": {
        // A chat that happened in a terminal becomes a chat here: a new
        // session holding its conversation. The next prompt resumes the
        // real thing when the project runs on the harness it ran on;
        // otherwise it continues from a brief of it, the way a rewind
        // across harnesses does.
        const project = store.get(msg.projectId);
        if (!project) throw new Error("unknown project");
        const imported = importRecent(project, msg.id);
        if (!imported) throw new Error("that session's file is gone");
        const fresh = store.newSession(project.id);
        if (!fresh) throw new Error("unknown project");
        archive.seed(fresh.id, { events: imported.events, summaries: {}, chain: {} });
        const providerId = ctx.models.registry.parse(project.model).providerId;
        const sameHarness = imported.provider === "claude" ? providerId === undefined : providerId === imported.provider;
        if (sameHarness) archive.setLastSessionId(fresh.id, imported.resume);
        else {
          const built = buildCompaction(fresh.id, imported.events, {});
          if (built) archive.setPendingBrief(fresh.id, built.brief);
        }
        const firstPrompt = imported.events.find((e) => e.kind === "user");
        if (firstPrompt && firstPrompt.kind === "user") titleSession(ctx, fresh.id, firstPrompt.text);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        ctx.clients.broadcast({
          type: "transcript",
          projectId: fresh.id,
          events: ctx.readable.allowArchived({ [fresh.id]: archive.events(fresh.id) })[fresh.id] ?? [],
          summaries: {},
        });
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "open_session", projectId: fresh.id } satisfies ServerMessage));
          if (!sameHarness) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: `brought the ${imported.provider === "claude" ? "Claude" : "Codex"} chat in — this project runs on a different harness, so the next prompt continues from a brief of it rather than resuming it`,
              } satisfies ServerMessage),
            );
          }
        }
        break;
      }
      case "new_session": {
        store.newSession(msg.projectId);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "remove_session": {
        const owner = store.findSession(msg.sessionId)?.project;
        if (owner?.path) void ctx.checkpoints.forgetChannel(owner, msg.sessionId).catch(() => undefined);
        manager.dispose(msg.sessionId);
        archive.remove(msg.sessionId);
        removeTurnFiles(msg.sessionId);
        for (const key of crew.remove(msg.sessionId)) ctx.crewManager.dispose(key);
        agentLogs.remove(msg.sessionId);
        drafts.remove(msg.sessionId);
        tracker.removeProject(msg.sessionId);
        ctx.turns.contexts.delete(msg.sessionId);
        ctx.turns.progress.delete(msg.sessionId);
        ctx.turns.sent.delete(msg.sessionId);
        ctx.retries.cancelRetry(msg.sessionId);
        ctx.bridge.closeBridge(msg.sessionId);
        store.removeSession(msg.sessionId);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "draft": {
        // Every keystroke's worth of unsent prompt, held for the next
        // launch. Bytes arrive once, the first time an attachment is seen;
        // after that the client sends metadata alone and the file it already
        // stored stands. Nothing is deleted here — the ids are the ones the
        // prompt will send under, so a cleared draft must not take the file
        // a just-sent transcript event points at.
        const held = drafts.get(msg.projectId)?.attachments ?? [];
        const attachments = msg.attachments?.flatMap((att) => {
          const { data, regions, ...meta } = att;
          const drawn = regions?.length ? { regions } : {};
          if (data) return [{ ...meta, ...drawn, url: storeUpload({ ...meta, data }).url }];
          const stored = held.find((h) => h.id === att.id);
          return stored ? [{ ...meta, ...drawn, url: stored.url }] : [];
        });
        drafts.set(msg.projectId, msg.text, attachments);
        break;
      }
      case "interrupt": {
        ctx.queues.epochs.set(msg.projectId, (ctx.queues.epochs.get(msg.projectId) ?? 0) + 1);
        ctx.retries.cancelRetry(msg.projectId);
        // The queue is not thrown away with the answer — it stands by. It
        // moves again on the next prompt (which goes ahead of it) or when
        // it is sent on from its own card.
        ctx.queues.holdQueue(msg.projectId);
        manager.interrupt(msg.projectId);
        // settle the optimistic "working" a pending split may have shown
        ctx.clients.broadcast({
          type: "status",
          projectId: msg.projectId,
          status: manager.statuses()[msg.projectId] ?? "idle",
        });
        break;
      }
      case "set_pref": {
        prefs.set(msg.key, msg.value);
        ctx.clients.broadcast({ type: "prefs", prefs: prefs.all() });
        break;
      }
      case "terminal_list": {
        ws.send(JSON.stringify({
          type: "terminal_tabs",
          projectId: msg.projectId,
          tabs: ctx.terminals.list(msg.projectId),
        } satisfies ServerMessage));
        break;
      }
      case "terminal_new": {
        ctx.clients.broadcast({
          type: "terminal_tabs",
          projectId: msg.projectId,
          tabs: ctx.terminals.add(msg.projectId),
        });
        break;
      }
      case "terminal_open": {
        const attaching = ctx.terminals.has(msg.termId);
        if (
          !ctx.terminals.open(
            msg.projectId,
            msg.termId,
            terminalCwd(ctx, msg.projectId),
            msg.cols,
            msg.rows,
          )
        ) {
          ws.send(JSON.stringify({
            type: "terminal_exit",
            projectId: msg.projectId,
            termId: msg.termId,
            note: "no shell could be started here",
          } satisfies ServerMessage));
          break;
        }
        // a shell that was already running answers with what it has printed,
        // so the panel opens where you left it
        if (attaching) {
          ws.send(JSON.stringify({
            type: "terminal_data",
            projectId: msg.projectId,
            termId: msg.termId,
            data: ctx.terminals.scrollback(msg.termId),
            replay: true,
          } satisfies ServerMessage));
        }
        break;
      }
      case "terminal_input": {
        ctx.terminals.write(msg.termId, msg.data);
        break;
      }
      case "terminal_resize": {
        ctx.terminals.resize(msg.termId, msg.cols, msg.rows);
        break;
      }
      case "terminal_close": {
        ctx.clients.broadcast({
          type: "terminal_tabs",
          projectId: msg.projectId,
          tabs: ctx.terminals.close(msg.projectId, msg.termId),
        });
        break;
      }
      case "permission_response": {
        manager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
        ctx.crewManager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
        break;
      }
      case "question_response": {
        // The card is answered. If the tool call behind it is still waiting,
        // the answers go into it; if it has moved on (the turn ended, or the
        // CLI gave up on the hook), they go out as a prompt of their own —
        // never into a hole.
        const request = ctx.permissions.get(msg.requestId);
        let outcome = manager.respondQuestion(msg.requestId, msg.answers);
        if (outcome === "none") outcome = ctx.crewManager.respondQuestion(msg.requestId, msg.answers);
        if (outcome === "answered") break;
        if (outcome === "none") {
          ctx.permissions.delete(msg.requestId);
          ctx.clients.broadcast({ type: "permission_resolved", requestId: msg.requestId });
        }
        if (!msg.answers || !request || request.kind !== "question") break;
        const asked = (request.input as AskQuestions).questions;
        const lines = asked.flatMap((q) => {
          const answer = msg.answers?.answers[q.question]?.trim();
          if (!answer) return [];
          return [`- ${q.header ? `${q.header}: ` : ""}${q.question}\n  ${answer}`];
        });
        if (lines.length === 0) break;
        const text = `My answers to your questions:\n${lines.join("\n")}`;
        // an agent of the user's own asked: the answers are its, not the chat's
        if (request.agent) {
          followCrew(ctx, request.agent, text);
          break;
        }
        const channelId = request.projectId;
        if (busy(ctx, channelId)) {
          const queue = ctx.queues.entries.get(channelId) ?? [];
          queue.push({ id: randomUUID(), text, uploads: [], silent: false });
          ctx.queues.entries.set(channelId, queue);
          ctx.queues.broadcastQueue(channelId);
        } else {
          dispatch(ctx, channelId, text, []);
        }
        break;
      }
      case "set_model": {
        if (msg.projectId === HOME_ID) {
          store.setHomeSettings({ model: msg.model });
          manager.setModel(HOME_ID, msg.model);
          ctx.clients.broadcast({ type: "home_settings", home: store.homeSettings() });
          republishContext(ctx, HOME_ID);
          break;
        }
        // A chat's pick is that chat's alone: it lands on the session, the
        // live session takes it once its turn is over, and no other chat
        // in the project moves. The project id form is wholesale.
        if (store.findSession(msg.projectId)) {
          if (store.effectiveSettings(msg.projectId)?.model === msg.model) break;
          store.setSessionSettings(msg.projectId, { model: msg.model });
          manager.setModel(msg.projectId, msg.model);
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
          // the new model may have a different window — remeasure against it
          republishContext(ctx, msg.projectId);
          break;
        }
        const project = store.get(msg.projectId);
        if (!project) break;
        for (const s of project.sessions) delete s.model;
        store.update(msg.projectId, { model: msg.model });
        // live sessions are keyed by session id, not project id
        for (const s of project.sessions) manager.setModel(s.id, msg.model);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        for (const s of project.sessions) republishContext(ctx, s.id);
        break;
      }
      case "set_permission_mode": {
        if (msg.projectId === HOME_ID) {
          store.setHomeSettings({ permissionMode: msg.mode });
          manager.setPermissionMode(HOME_ID, msg.mode);
          ctx.clients.broadcast({ type: "home_settings", home: store.homeSettings() });
          break;
        }
        if (store.findSession(msg.projectId)) {
          if (store.effectiveSettings(msg.projectId)?.permissionMode === msg.mode) break;
          store.setSessionSettings(msg.projectId, { permissionMode: msg.mode });
          manager.setPermissionMode(msg.projectId, msg.mode);
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
          break;
        }
        const project = store.get(msg.projectId);
        if (!project) break;
        for (const s of project.sessions) delete s.permissionMode;
        store.update(msg.projectId, { permissionMode: msg.mode });
        for (const s of project.sessions) manager.setPermissionMode(s.id, msg.mode);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "set_effort": {
        if (msg.projectId === HOME_ID) {
          if ((store.homeSettings().effort ?? "") === msg.effort) break;
          store.setHomeSettings({ effort: msg.effort });
          manager.setEffort(HOME_ID, msg.effort);
          ctx.clients.broadcast({ type: "home_settings", home: store.homeSettings() });
          break;
        }
        if (store.findSession(msg.projectId)) {
          if (store.effectiveSettings(msg.projectId)?.effort === msg.effort) break;
          store.setSessionSettings(msg.projectId, { effort: msg.effort });
          manager.setEffort(msg.projectId, msg.effort);
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
          break;
        }
        const project = store.get(msg.projectId);
        if (!project) break;
        if ((project.effort ?? "") === msg.effort && project.sessions.every((s) => !s.effort)) break;
        for (const s of project.sessions) delete s.effort;
        store.update(msg.projectId, { effort: msg.effort });
        for (const s of project.sessions) manager.setEffort(s.id, msg.effort);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "tracker_add": {
        if (!msg.text.trim()) return;
        tracker.add(msg.projectId, msg.text.trim(), "manual", undefined, msg.note ?? "");
        ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        break;
      }
      case "tracker_update": {
        tracker.update(msg.projectId, msg.itemId, {
          ...(msg.status !== undefined ? { status: msg.status } : {}),
          ...(msg.note !== undefined ? { note: msg.note } : {}),
          ...(msg.text !== undefined ? { text: msg.text } : {}),
        });
        ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        break;
      }
      case "tracker_remove": {
        tracker.remove(msg.projectId, msg.itemId);
        ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        break;
      }
      /* ── the ideas board ──────────────────────────────────────── */
      case "idea_add": {
        const text = msg.text.trim();
        if (!text) break;
        ideas.add(msg.projectId, text);
        ctx.clients.broadcast({ type: "ideas", projectId: msg.projectId, items: ideas.items(msg.projectId) });
        break;
      }
      case "idea_update": {
        ideas.update(msg.projectId, msg.ideaId, {
          ...(msg.text !== undefined ? { text: msg.text } : {}),
          ...(msg.done !== undefined ? { done: msg.done } : {}),
        });
        ctx.clients.broadcast({ type: "ideas", projectId: msg.projectId, items: ideas.items(msg.projectId) });
        break;
      }
      case "idea_remove": {
        ideas.remove(msg.projectId, msg.ideaId);
        ctx.clients.broadcast({ type: "ideas", projectId: msg.projectId, items: ideas.items(msg.projectId) });
        break;
      }

      /* ── the vault ────────────────────────────────────────────── */
      case "secret_save": {
        secrets.upsert({
          ...(msg.id ? { id: msg.id } : {}),
          name: msg.name,
          ...(msg.username !== undefined ? { username: msg.username } : {}),
          ...(msg.note !== undefined ? { note: msg.note } : {}),
          ...(msg.secret !== undefined ? { secret: msg.secret } : {}),
        });
        ctx.clients.broadcast({ type: "secrets", items: secrets.meta() });
        break;
      }
      case "secret_remove": {
        secrets.remove(msg.id);
        ctx.clients.broadcast({ type: "secrets", items: secrets.meta() });
        break;
      }

      /* ── skills ───────────────────────────────────────────────── */
      case "skills_refresh": {
        pushSkills(msg.projectId);
        break;
      }
      case "commands_refresh": {
        const dir = msg.projectId ? store.get(msg.projectId)?.path : undefined;
        // the asking socket only: this is a menu being opened, not news
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "commands",
              ...(msg.projectId ? { projectId: msg.projectId } : {}),
              commands: listCommands(dir),
            } satisfies ServerMessage),
          );
        }
        break;
      }
      case "skill_toggle": {
        try {
          const note = toggleSkill(
            msg.scope,
            msg.projectId ? store.get(msg.projectId)?.path : undefined,
            msg.name,
            msg.on,
          );
          pushSkills(msg.projectId, note);
        } catch (err) {
          pushSkills(msg.projectId, String(err instanceof Error ? err.message : err));
        }
        break;
      }
      case "skill_read": {
        try {
          const body = readSkill(
            msg.scope,
            msg.projectId ? store.get(msg.projectId)?.path : undefined,
            msg.name,
          );
          ws.send(JSON.stringify({ type: "skill_body", name: msg.name, scope: msg.scope, body } satisfies ServerMessage));
        } catch (err) {
          ws.send(JSON.stringify({
            type: "skill_body",
            name: msg.name,
            scope: msg.scope,
            body: `_${String(err instanceof Error ? err.message : err)}_`,
          } satisfies ServerMessage));
        }
        break;
      }
      case "skill_install":
      case "skill_remove":
      case "skill_update": {
        const dir = msg.projectId ? store.get(msg.projectId)?.path : undefined;
        // bmo clones and copies — long enough that the page says so (the
        // list as the filesystem has it; bmo's own notes come with the push
        // when the work is done)
        ctx.clients.broadcast({
          type: "skills",
          ...(msg.projectId ? { projectId: msg.projectId } : {}),
          skills: listSkills(dir),
          busy: true,
        });
        const work =
          msg.type === "skill_install"
            ? installSkill(msg.scope, dir, msg.source)
            : msg.type === "skill_remove"
              ? removeSkill(msg.scope, dir, msg.name)
              : updateSkills(dir);
        work
          .then((note) => pushSkills(msg.projectId, note.split("\n").slice(-3).join(" · ") || "done"))
          .catch((err: unknown) =>
            pushSkills(msg.projectId, String(err instanceof Error ? err.message : err).split("\n")[0]),
          );
        break;
      }

      case "tracker_attach": {
        const { url } = storeUpload(msg.upload);
        const { data: _d, regions: _r, ...meta } = msg.upload;
        if (tracker.attach(msg.projectId, msg.itemId, { ...meta, url })) {
          ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        }
        break;
      }
      case "tracker_detach": {
        if (tracker.detach(msg.projectId, msg.itemId, msg.attachmentId)) {
          ctx.clients.broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        }
        break;
      }
      case "tracker_review": {
        const channelId = msg.projectId;
        const items = tracker.items(channelId);
        if (!items.some((i) => i.status !== "open")) return;
        const rejectedItems = items.filter((i) => i.status === "rejected");
        // note attachments ride the prompt as stored paths
        const attachLines = rejectedItems
          .filter((i) => i.attachments?.length)
          .map(
            (i) =>
              `[attached for "${i.text}" — view with tools: ${i
                .attachments!.map((a) => storedFilePath(a.url ?? ""))
                .join(", ")}]`,
          )
          .join("\n");
        // outcomes apply immediately: liked verified → gone, rejected → repeats
        tracker.finishReview(channelId);
        ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
        if (rejectedItems.length === 0) break;
        // the fix-it prompt is assembled mechanically — each crossed item's
        // title with the user's note verbatim under it. No model call:
        // instant, and exactly what the user wrote.
        const lines = rejectedItems.map((i) => {
          const note = i.note.trim();
          return `- ${i.text}${note ? `\n${note.split("\n").map((l) => `  ${l}`).join("\n")}` : ""}`;
        });
        const text = `Fix these issues found while reviewing:\n${lines.join("\n")}`;
        if (ws.readyState === WebSocket.OPEN) {
          const full = attachLines ? `${text}\n\n${attachLines}` : text;
          ws.send(
            JSON.stringify({ type: "review_prompt", projectId: channelId, text: full } satisfies ServerMessage),
          );
        }
        break;
      }
      case "toggle_star": {
        const project = store.get(msg.projectId);
        if (project) {
          store.update(msg.projectId, { starred: project.starred ? undefined : true });
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
        }
        break;
      }
      case "toggle_hidden": {
        const project = store.get(msg.projectId);
        if (project) {
          store.update(msg.projectId, { hidden: project.hidden ? undefined : true });
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
        }
        break;
      }
      case "rename_project": {
        const name = msg.name.trim();
        if (name && store.update(msg.projectId, { name })) {
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
        }
        break;
      }
      case "rename_session": {
        const title = msg.title.trim();
        if (title && store.findSession(msg.sessionId)) {
          store.setSessionTitle(msg.sessionId, title);
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
        }
        break;
      }
      case "set_workspace": {
        store.setWorkspaceDir(msg.path);
        ctx.clients.broadcast({ type: "workspace", path: store.workspaceDir() });
        break;
      }
      case "set_music_dir": {
        store.setMusicDir(msg.path);
        ctx.clients.broadcast({ type: "music_dir", path: ctx.musicRoot() });
        break;
      }
      case "toggle_model_star": {
        announceRoles(store.cycleModelStar(msg.model));
        break;
      }
      case "set_model_role": {
        announceRoles(store.assignModelRole(msg.model, msg.role));
        break;
      }
      case "reset_home": {
        // Skipped while a turn is in flight — it may still be opening
        // projects; the next navigation resets it once it's quiet.
        const status = manager.statuses()[HOME_ID];
        if (status === "working" || status === "permission") break;
        manager.dispose(HOME_ID);
        archive.remove(HOME_ID);
        removeTurnFiles(HOME_ID);
        agentLogs.remove(HOME_ID);
        homeLog.endSession();
        ctx.queues.entries.delete(HOME_ID);
        ctx.queues.held.delete(HOME_ID);
        ctx.turns.contexts.delete(HOME_ID);
        ctx.retries.cancelRetry(HOME_ID);
        ctx.clients.broadcast({ type: "home_reset" });
        break;
      }
      case "refresh_models": {
        // Probing spawns a short-lived process per harness, so back-to-back
        // Settings opens within half a minute reuse the last answer.
        if (Date.now() - ctx.models.probedAt > 30_000) ctx.models.probeModels(true);
        break;
      }
      case "bridge_takeover": {
        void options.bridge?.takeover(msg.projectId);
        break;
      }
      case "bridge_release": {
        void options.bridge?.release(msg.projectId);
        break;
      }
      case "bridge_close": {
        void options.bridge?.close(msg.projectId);
        break;
      }
      default: {
        const unknown: { type: string } = msg;
        throw new Error(`unknown message type: ${JSON.stringify(unknown)}`);
      }
    }
  }

  const server = createHttpServer(ctx);

  const wss = new WebSocketServer({
    server,
    // the socket is the whole app: a page from anywhere else, or one
    // without the token, is turned away at the upgrade
    verifyClient: ({ origin, req }, done) => {
      if (!originAllowed(origin || undefined, ctx.listeningPort, !options.staticDir)) {
        done(false, 403, "Forbidden");
        return;
      }
      if (!tokenMatches(presentedToken(req), options.token)) {
        done(false, 401, "Unauthorized");
        return;
      }
      done(true);
    },
  });

  // ws forwards the http server's "error" to the WebSocketServer, and an
  // "error" event with nobody listening is an uncaught exception — which is
  // why a port already in use used to take the whole app down instead of
  // falling back the way the listen handler below intends. The handler down
  // there is the one that decides what to do; this is only here so the copy
  // ws re-emits cannot kill the process on its way past.
  wss.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") return;
    console.error("ruri websocket server error:", error);
  });

  wss.on("connection", (ws) => {
    ctx.clients.sockets.add(ws);
    const projectIds = [...store.sessionIds(), HOME_ID];
    // the boards are the one thing keyed by project rather than by session
    const boardIds = store.list().map((p) => p.id);
    const snapshot: ServerMessage = {
      type: "snapshot",
      projects: store.list(),
      transcripts: ctx.readable.allowArchived(archive.tails(projectIds, TRANSCRIPT_TAIL)),
      statuses: manager.statuses(),
      permissions: [...ctx.permissions.values()],
      models: ctx.models.allModels(),
      summaries: archive.allSummaries(projectIds),
      tracker: tracker.all(projectIds),
      ideas: ideas.all(boardIds),
      components: components.all(boardIds),
      secrets: secrets.meta(),
      queued: Object.fromEntries(projectIds.map((id) => [id, ctx.queues.visibleQueue(id)])),
      queuesHeld: projectIds.filter((id) => ctx.queues.held.has(id)),
      usage: ctx.usage.limits,
      // live figures first; anything not yet seen this run falls back to the
      // last one the archive recorded, so a relaunch shows real occupancy
      contexts: Object.fromEntries(
        projectIds.flatMap((id) => {
          const live = ctx.turns.contexts.get(id);
          if (live) return [[id, live] as const];
          const tokens = archive.contextTokens(id);
          return tokens === undefined ? [] : [[id, { tokens, window: contextWindow(ctx, id) }] as const];
        }),
      ),
      turns: ctx.turns.snapshot(),
      stats: ledger.all([...boardIds, HOME_ID]),
      catchups: Object.fromEntries(
        boardIds.map((id) => [id, briefs.get(id).built ? { built: briefs.get(id).built } : {}]),
      ),
      canPickFolder: options.pickFolder !== undefined,
      canPermissions: options.permissions !== undefined,
      workspaceDir: store.workspaceDir(),
      musicDir: ctx.musicRoot(),
      home: store.homeSettings(),
      starredModels: store.starredModels(),
      smallModel: store.smallModel() ?? "",
      defaultModel: store.defaultModel(),
      user: os.userInfo().username,
      prefs: prefs.all(),
      composerDrafts: drafts.all(),
      bridges: options.bridge?.states() ?? {},
      crew: crew.all(projectIds),
    };
    ws.send(JSON.stringify(snapshot));

    ws.on("message", (raw) => {
      try {
        // checked before anything trusts its shape (shared/clientSchema.ts);
        // a message that does not fit is answered and dropped
        const parsed = clientMessageSchema.safeParse(JSON.parse(String(raw)));
        if (!parsed.success) {
          const reason = describeIssue(parsed.error);
          warn("server", reason, "bad client message");
          ws.send(JSON.stringify({ type: "error", message: `bad message: ${reason}` } satisfies ServerMessage));
          return;
        }
        handleMessage(ws, parsed.data);
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: errorMessage(err),
          } satisfies ServerMessage),
        );
      }
    });
    ws.on("close", () => {
      ctx.clients.sockets.delete(ws);
      const view = ctx.clients.views.get(ws);
      ctx.clients.views.delete(ws);
      // a window gone is every chat it had open, left
      for (const id of view?.channels ?? []) manager.settle(id);
    });
  });

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
