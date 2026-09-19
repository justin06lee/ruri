/**
 * The server, put together: the stores and the live state on one context
 * (server/context.ts), the two session managers and the hosts the models
 * reach the app through, the timers, and the HTTP routes (server/routes.ts)
 * and socket (server/socket.ts) on one port. What each message does lives
 * in server/handlers, one file per domain.
 */
import * as fs from "node:fs";
import { HOME_TRANSCRIPT_MAX, type PermissionRequest } from "../shared/protocol.js";
import { AgentLogs, Crew } from "./agents.js";
import { SessionArchive } from "./archive.js";
import { writeTextAtomic } from "./atomic.js";
import { BridgeState } from "./bridgeState.js";
import { BriefStore, writeCatchupFile } from "./brief.js";
import { briefless, rebuildCatchup } from "./catchupBrief.js";
import { ownerProject, running } from "./channel.js";
import { createChatManager } from "./chats.js";
import { createCheckpoints } from "./checkpoints.js";
import { Clients } from "./clients.js";
import { DigestFolder, refreshArchivedTurnFiles, removeTurnFiles } from "./compaction.js";
import { ComponentStore, writeIndexFile } from "./components.js";
import { configPath } from "./configDir.js";
import type { PendingComponent, RuriServer, ServerContext, StartServerOptions } from "./context.js";
import { DraftStore } from "./drafts.js";
import { createTurnTracker } from "./events.js";
import { UsageGauges } from "./gauges.js";
import { createComponentHost } from "./handlers/components.js";
import { createCrewManager } from "./handlers/crew.js";
import { createManagerHost } from "./handlers/projects.js";
import { HomeLog } from "./homelog.js";
import { IdeaStore } from "./ideas.js";
import { LedgerStore } from "./ledger.js";
import { warn } from "./log.js";
import { HOME_ID } from "./manager.js";
import { Models } from "./models.js";
import { defaultMusicDir } from "./music.js";
import { backfillNotes, NoteBackfill } from "./notes.js";
import { sweepOrphans } from "./orphans.js";
import { claimPort, type PortClaim } from "./port.js";
import { PrefStore } from "./prefs.js";
import { ProjectStore } from "./projects.js";
import { SendQueues } from "./queue.js";
import { ReadableImages } from "./readable.js";
import { TerminalRelay } from "./relay.js";
import { Retries } from "./retry.js";
import { createHttpServer } from "./routes.js";
import { SecretStore } from "./secrets.js";
import { digestHistory, setSmallModel } from "./smallmodel.js";
import { createSocketServer } from "./socket.js";
import { Terminals } from "./terminal.js";
import { TrackerStore } from "./tracker.js";
import { pushContexts, Turns } from "./turns.js";
import { sweepUploads } from "./uploads.js";

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
  // built (server/chats.ts), and to nothing else ruri starts
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
  // A shell's output, paced by what each window can take — and the shell
  // itself paused when none of them can (server/relay.ts).
  const relay = new TerminalRelay(clients.sockets, (termId, held) => ctx.terminals.hold(termId, held));
  clients.onGone = (ws) => relay.forget(ws);
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
      onData: (projectId, termId, data) => relay.data(projectId, termId, data),
      onExit: (projectId, termId, note) => {
        // what the shell said last is the part worth having, so it goes
        // out before the news that there is no more of it
        relay.flush(termId);
        clients.broadcast({ type: "terminal_exit", projectId, termId, note });
      },
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
    if (orphans)
      console.log(`ruri: removed ${orphans} file${orphans === 1 ? "" : "s"} left by closed sessions`);
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
  ctx.componentHost = createComponentHost(ctx);

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

  ctx.manager = createChatManager(ctx);
  ctx.crewManager = createCrewManager(ctx);
  ctx.managerHost = createManagerHost(ctx);

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
            ctx.manager.disposeAll();
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
            relay.stop();
            for (const client of ctx.clients.sockets) client.close();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
