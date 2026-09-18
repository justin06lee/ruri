import { randomUUID, timingSafeEqual } from "node:crypto";
import { type AskQuestions, briefLine, DEFAULT_PERMISSION_MODE, type SubagentState, HOME_TRANSCRIPT_MAX, TRANSCRIPT_TAIL } from "../shared/protocol.js";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Attachment,
  AttachmentUpload,
  ClientMessage,
  ComponentProposal,
  ContextUsage,
  NamedComponent,
  PermissionRequest,
  ServerMessage,
  TranscriptEvent,
} from "../shared/protocol.js";
import { clientMessageSchema, describeIssue } from "../shared/clientSchema.js";
import { SessionArchive } from "./archive.js";
import { writeTextAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { AgentLogs, Crew } from "./agents.js";
import { BridgeState } from "./bridgeState.js";
import { busy, channelProject, ownerProject, running, terminalCwd } from "./channel.js";
import { catchUp, Clients, pushTranscript, transcriptOf } from "./clients.js";
import { buildCompaction, DigestFolder, refreshArchivedTurnFiles, removeTurnFiles } from "./compaction.js";
import type { PendingComponent, RuriServer, ServerContext, StartServerOptions } from "./context.js";
import { DraftStore } from "./drafts.js";
import { UsageGauges } from "./gauges.js";
import { HomeLog } from "./homelog.js";
import { createCheckpoints } from "./checkpoints.js";
import { HOME_ID, managerExtras, type ManagerHost } from "./manager.js";
import { AUDIO_MIME, IMAGE_MIME, mimeOf, STATIC_MIME } from "./mime.js";
import { Models } from "./models.js";
import { defaultMusicDir, isAllowed, scan as scanMusic } from "./music.js";
import { claimPort, type PortClaim } from "./port.js";
import { PrefStore } from "./prefs.js";
import { ProjectStore } from "./projects.js";
import { mergeEntries, reslot, SendQueues, type QueueEntry } from "./queue.js";
import { ReadableImages } from "./readable.js";
import { Retries, RETRY_NUDGE, RETRY_WAITS_MS } from "./retry.js";
import { promptChain, SessionManager } from "./sessions.js";
import { assembleTurns, digestHistory, extractTrackerItems, sessionRoleTitle, setSmallModel, smallModelEnabled, splitPrompt, summarizePrompt, summarizeReply, TurnTracker, updateBrief, type Turn } from "./smallmodel.js";
import { BriefStore, writeCatchupFile } from "./brief.js";
import { buildCatchup } from "./catchup.js";
import { knownCommands, listCommands, splitCommands } from "./commands.js";
import { findProjects } from "./finder.js";
import { LedgerStore } from "./ledger.js";
import { importRecent, listRecent } from "./recent.js";
import { sessionBriefing } from "./briefing.js";
import {
  BRIDGE_TOOLS,
  bridgeDir,
  bridgeHttpBriefing,
  bridgeToolBriefing,
  bridgeTools,
  runBridge,
} from "./bridge.js";
import {
  COMPONENT_TOOLS,
  ComponentStore,
  componentDropBriefing,
  componentTools,
  drainComponentRequests,
  mentionBlock,
  mentionedIn,
  writeIndexFile,
  type ComponentHost,
} from "./components.js";
import { IdeaStore } from "./ideas.js";
import { ParagraphGate } from "./paragraphs.js";
import { sweepOrphans } from "./orphans.js";
import { sweepProject } from "./sweep.js";
import { withProjectRunning, type ShotTarget } from "./shots.js";
import { SecretStore } from "./secrets.js";
import { installSkill, listSkills, readSkill, removeSkill, scanSkills, toggleSkill, updateSkills } from "./skills.js";
import { Terminals } from "./terminal.js";
import { TrackerStore } from "./tracker.js";
import { contextWindow, pushContexts, republishContext, resetContext, Turns } from "./turns.js";
import { modelPayload, processAttachments, serveUpload, storeAttachments, storedFilePath, storeUpload, sweepUploads } from "./uploads.js";
import { errorMessage, isMissing, warn } from "./log.js";

export type { RuriServer, StartServerOptions } from "./context.js";

/**
 * The desktop app is same-origin, but the vite dev server (:5173) is not —
 * and a cross-origin MediaElementSource without CORS taints the Web Audio
 * graph into silence (crossfading needs gain nodes). Permissive headers on
 * the music routes keep dev mode working.
 */
const MUSIC_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges",
};

/**
 * Streams one audio file, honouring Range requests so seeking in a long track
 * is instant. Only paths inside the music dir are served (see music.ts).
 */
function serveTrack(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const filePath = url.searchParams.get("p") ?? "";
  if (!filePath || !isAllowed(filePath, root)) {
    res.writeHead(403, MUSIC_CORS);
    res.end();
    return;
  }
  let size: number;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch (err) {
    if (!isMissing(err)) warn("server", err, "serveTrack");
    res.writeHead(404, MUSIC_CORS);
    res.end();
    return;
  }

  const type = mimeOf(filePath, AUDIO_MIME);
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range?.trim() ?? "");

  if (match && (match[1] !== "" || match[2] !== "")) {
    let start: number;
    let end: number;
    if (match[1] !== "") {
      start = Number(match[1]);
      end = match[2] !== "" ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(match[2])); // suffix form: bytes=-500
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { ...MUSIC_CORS, "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...MUSIC_CORS,
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...MUSIC_CORS, "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  fs.createReadStream(filePath).pipe(res);
}

/** A request body, whole, or an error past `limit` bytes. */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** The dev page's origins: vite serves the UI on :5173 and talks to the
 *  standalone server across origins. Honoured only when there is no built
 *  UI to serve — the packaged app never hears from them. */
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

/**
 * Whether a request may come from where it says it comes from. No Origin
 * at all is a non-browser client (a script, curl, a harness's bridge call)
 * and passes; a browser's Origin must be this server's own page — or, in
 * dev, vite's. Anything else is some other site's page on the same
 * machine, and gets nothing.
 */
function originAllowed(origin: string | undefined, port: number, dev: boolean): boolean {
  if (origin === undefined) return true;
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  return own.includes(origin) || (dev && DEV_ORIGINS.includes(origin));
}

/** The token a request carries — the header first, the query second. */
function presentedToken(req: http.IncomingMessage): string {
  const header = req.headers["x-ruri-token"];
  if (typeof header === "string") return header;
  return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
}

/** Compared in constant time: a wrong token takes as long as a right one. */
function tokenMatches(presented: string, token: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function serveStatic(staticDir: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.resolve(staticDir, rel);
  if (!file.startsWith(path.resolve(staticDir) + path.sep) && file !== path.resolve(staticDir, "index.html")) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": mimeOf(file, STATIC_MIME) });
    res.end(data);
  });
}

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

  /** GET /bridge/preview/<channelId> — the strip's picture, overwritten in
   *  place as the session works, so never cached. */
  function serveBridgePreview(req: http.IncomingMessage, res: http.ServerResponse): void {
    const id = (req.url ?? "").slice("/bridge/preview/".length).split("?")[0] ?? "";
    const file = path.join(bridgeDir(id), "preview.png");
    try {
      const stat = fs.statSync(file);
      if (!id || !stat.isFile()) throw new Error("not a file");
      res.writeHead(200, { "content-type": "image/png", "content-length": stat.size, "cache-control": "no-cache" });
      fs.createReadStream(file).pipe(res);
    } catch (err) {
      if (!isMissing(err)) warn("server", err, "serveBridgePreview");
      res.writeHead(404);
      res.end();
    }
  }

  /**
   * POST /bridge/<channelId> — the bridge for a harness that cannot hold
   * tools: the same calls as JSON, answered as JSON, with pictures as
   * paths. The channel id is the capability; a session is told only its own.
   */
  async function serveBridgeCall(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: Record<string, unknown>): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const id = (req.url ?? "").slice("/bridge/".length).split("?")[0] ?? "";
    if (!id || (id !== HOME_ID && !store.sessionIds().includes(id))) {
      reply(404, { ok: false, error: "no such session" });
      return;
    }
    let body: { tool?: unknown; args?: unknown };
    try {
      body = JSON.parse(await readBody(req, 1024 * 1024)) as typeof body;
    } catch (err) {
      reply(400, { ok: false, error: `bad request: ${errorMessage(err)}` });
      return;
    }
    if (!body || typeof body.tool !== "string") {
      reply(400, { ok: false, error: 'send {"tool": "<name>", "args": {...}}' });
      return;
    }
    const owner = ownerProject(ctx, id);
    const outcome = await runBridge(options.bridge, { channelId: id, projectId: owner?.id ?? id }, body.tool, body.args);
    if (!outcome.ok) {
      reply(200, { ok: false, error: outcome.error });
      return;
    }
    reply(200, {
      ok: true,
      text: outcome.result.text,
      ...(outcome.result.image ? { image: outcome.result.image.path } : {}),
    });
  }

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
  const allNotes = () => backfillNotes(store.sessionIds());
  const firstNotes = setTimeout(allNotes, 5_000);
  firstNotes.unref();
  const notesTimer = setInterval(allNotes, 60 * 60_000);
  notesTimer.unref();
  /**
   * Write down the project's files before a prompt goes out, so a rewind to
   * it can put them back whatever harness ran the turn.
   *
   * Home is left out on purpose: its "project" is the whole workspace root,
   * and it orchestrates rather than edits. The capture runs alongside the
   * prompt rather than ahead of it — a harness takes seconds to reach its
   * first edit and git takes milliseconds to read a tree it has read
   * before, and a prompt is never held up waiting for one.
   */
  function checkpoint(channelId: string, eventId: string): void {
    if (channelId === HOME_ID) return;
    const project = channelProject(ctx, channelId);
    if (!project?.path) return;
    void ctx.checkpoints.capture(project, channelId, eventId).catch(() => false);
  }

  const componentHost: ComponentHost = {
    list: (channelId) => {
      const owner = ownerProject(ctx, channelId);
      return owner ? components.items(owner.id) : [];
    },
    propose: (channelId, proposal) =>
      new Promise<string | null>((resolve) => {
        const owner = ownerProject(ctx, channelId);
        if (!owner) {
          resolve(null);
          return;
        }
        // The screenshot is copied now, not when the card is answered. The
        // card is the whole point of it — being asked to name something you
        // cannot see is being asked to guess — and the model's own copy is
        // routinely a scratch file that will not survive the wait.
        const shot = proposal.shot ? storeShot(proposal.shot, owner.path) : undefined;
        const shown: ComponentProposal = {
          name: proposal.name,
          files: proposal.files,
          note: proposal.note,
          ...(shot ? { image: shot } : {}),
        };
        // Bypass is the mode where ruri stops asking, and the card is only
        // ever a confirmation: the model has already named the thing and
        // photographed it. So in bypass the entry is written the moment it
        // is proposed, star and screenshot and all, and the name stays
        // yours to change on the components page whenever you look.
        const mode = channelProject(ctx, channelId)?.permissionMode ?? DEFAULT_PERMISSION_MODE;
        const straight = shown.name.trim();
        if (mode === "bypassPermissions" && straight) {
          const item = components.add(owner.id, {
            name: straight,
            files: shown.files,
            note: shown.note,
          });
          if (shown.image) components.addShot(owner.id, item.id, shown.image);
          pushComponents(owner.id, owner.path);
          resolve(straight);
          return;
        }
        const requestId = randomUUID();
        ctx.pendingComponents.set(requestId, { channelId, proposal: shown, resolve });
        const request: PermissionRequest = {
          requestId,
          projectId: channelId,
          toolName: "name_component",
          kind: "component",
          input: shown,
          ts: Date.now(),
        };
        ctx.permissions.set(requestId, request);
        ctx.clients.broadcast({ type: "permission_request", request });
      }),
  };

  /** An image the model pointed at, stored the way every attachment is. A
   *  relative path is read against the project it was named from, since that
   *  is the directory the model was working in. */
  function storeShot(file: string, projectDir?: string): Attachment | undefined {
    try {
      const full = path.isAbsolute(file) ? file : path.resolve(projectDir ?? ".", file);
      const data = fs.readFileSync(full).toString("base64");
      const ext = path.extname(full).slice(1).toLowerCase();
      const upload: AttachmentUpload = {
        id: randomUUID(),
        kind: "image",
        mediaType: IMAGE_MIME[ext] ?? "image/png",
        name: path.basename(full),
        n: 1,
        data,
      };
      const { url } = storeUpload(upload);
      const { data: _data, regions: _regions, ...meta } = upload;
      return { ...meta, url };
    } catch (err) {
      if (!isMissing(err)) warn("server", err, "storeShot");
      return undefined;
    }
  }

  /** Push a project's component index to disk and to every client. */
  function pushComponents(projectId: string, projectDir?: string): void {
    const items = components.items(projectId);
    if (projectDir) writeIndexFile(projectDir, items);
    ctx.clients.broadcast({ type: "components", projectId, items });
  }

  /* ── the repo sweep ───────────────────────────────────────────────── */

  function sweepNote(projectId: string, note: string, busy = true): void {
    ctx.clients.broadcast({ type: "sweep", projectId, busy, ...(note ? { note } : {}) });
  }

  /** A component's screenshot, filed like any other upload. */
  function pinShot(projectId: string, item: NamedComponent, data: string): void {
    const upload: AttachmentUpload = {
      id: randomUUID(),
      kind: "image",
      mediaType: "image/png",
      name: `${item.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "component"}.png`,
      n: 1,
      data,
    };
    const { url } = storeUpload(upload);
    const { data: _data, regions: _regions, ...meta } = upload;
    components.addShot(projectId, item.id, { ...meta, url });
  }

  /**
   * Name everything in a project that isn't named yet, and then go and take
   * its picture.
   *
   * Two passes, and the second one is optional in every sense: the naming
   * pass is a handful of small-model calls over the repo and always runs;
   * the picture pass starts the project's own dev server, opens it in a
   * hidden window, and photographs each component by the selector the first
   * pass wrote down. A project that isn't a page, a headless ruri, or a dev
   * server that never comes up all land in the same place — entries with no
   * screenshot, which the user can drop one onto.
   */
  async function runSweep(projectId: string, wantShots: boolean): Promise<void> {
    const project = store.get(projectId);
    if (!project || ctx.sweeping.has(projectId)) return;
    ctx.sweeping.add(projectId);
    sweepNote(projectId, "reading the repo…");
    try {
      // Taken before the read, so a file edited while the sweep runs is read
      // again next time rather than being skipped as "already seen".
      const startedAt = Date.now();
      const { found } = await sweepProject(
        project,
        components.items(projectId),
        (note) => sweepNote(projectId, note),
        components.sweptAt(projectId),
      );
      for (const part of found) components.add(projectId, { ...part, found: true });
      components.markSwept(projectId, startedAt);
      pushComponents(projectId, project.path);

      // Everything unphotographed gets a look in, not just what this sweep
      // named — the dev server is already starting, and an entry from six
      // months ago is exactly as picture-less as one from a minute ago.
      const targets: ShotTarget[] = components
        .items(projectId)
        .filter((item) => item.selector && item.shots.length === 0)
        .map((item) => ({
          id: item.id,
          selector: item.selector!,
          ...(item.route ? { route: item.route } : {}),
          ...(item.clicks?.length ? { clicks: item.clicks } : {}),
        }));
      const named = found.length === 0 ? "nothing new to name" : `named ${found.length}`;
      if (!wantShots || !options.capture || targets.length === 0) {
        sweepNote(projectId, named, false);
        return;
      }
      const shots = await withProjectRunning(
        project.path,
        (note) => sweepNote(projectId, note),
        (url) => options.capture!(url, targets),
      );
      let pinned = 0;
      for (const [componentId, data] of Object.entries(shots ?? {})) {
        const item = components.items(projectId).find((i) => i.id === componentId);
        if (!item) continue;
        pinShot(projectId, item, data);
        pinned += 1;
      }
      pushComponents(projectId, project.path);
      sweepNote(projectId, `${named}, ${pinned || "no"} picture${pinned === 1 ? "" : "s"}`, false);
    } catch (err) {
      warn("server", err, "runSweep");
      sweepNote(projectId, "the sweep didn't finish — try it again", false);
    } finally {
      ctx.sweeping.delete(projectId);
    }
  }

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

  // Sessions get their role title the moment their first prompt goes out —
  // in parallel with the turn, not after it. (TurnTracker's post-turn call
  // stays as the fallback if this pass fails or returns nothing.)
  function titleSession(channelId: string, text: string): void {
    if (!smallModelEnabled()) return;
    const found = store.findSession(channelId);
    if (!found || found.session.title) return;
    sessionRoleTitle({ turnId: "", user: text, assistant: "", tools: [] })
      .then((title) => {
        if (!title || store.findSession(channelId)?.session.title) return;
        store.setSessionTitle(channelId, title);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
      })
      .catch(() => {});
  }

  function dispatch(channelId: string, text: string, uploads: AttachmentUpload[], silent = false): void {
    // /compact is ruri's own, not the harness's: summaries + full-turn file
    // hooks into a fresh session, with the zigzag mark in the transcript
    if (!silent && text.trim() === "/compact" && uploads.length === 0) {
      compactChannel(channelId);
      return;
    }
    const project = channelProject(ctx, channelId);
    if (!project) throw new Error("unknown session");
    titleSession(channelId, text);
    // a prompt that names something in the component index takes that
    // entry down with it — the model's copy only, never the transcript's
    const owner = ownerProject(ctx, channelId);
    const named = owner ? mentionBlock(mentionedIn(text, components.items(owner.id))) : "";
    // a new prompt is going out, so nothing is "just named" any more: what
    // this turn names wears the star beside it, and what the last one named
    // keeps its star in the corner until the user has looked
    if (owner && components.demote(owner.id)) pushComponents(owner.id, owner.path);
    // the first prompt after a compaction carries the brief, invisibly
    const brief = archive.takePendingBrief(channelId) ?? "";
    if (silent) {
      // a split sub-prompt: files are already stored, no new user event
      const payload = modelPayload(text, uploads);
      manager.send(project, brief + payload.text + named, payload.images, undefined, true,
        archive.events(channelId).findLast((event) => event.kind === "user")?.id);
      return;
    }
    // What the model reads and what the user wrote are two strings: the
    // compaction brief is the model's memory, and a file's marker becomes
    // its path where the model reads it. So the transcript event is written
    // here, from the user's own wording, and the model's copy goes down
    // silently underneath it.
    const processed = processAttachments(text, uploads);
    const userEvent: TranscriptEvent = {
      kind: "user",
      id: randomUUID(),
      text: processed.display,
      ...(processed.attachments.length ? { attachments: processed.attachments } : {}),
      ts: Date.now(),
    };
    recordEvent(channelId, userEvent);
    checkpoint(channelId, userEvent.id);
    manager.send(project, brief + processed.text + named, processed.images, undefined, true, userEvent.id);
  }

  /**
   * The scissors send: one visible prompt, split by the small model into
   * its separate requests and fed to the harness one turn at a time.
   */
  function dispatchSplit(
    channelId: string,
    text: string,
    uploads: AttachmentUpload[],
    /** Ahead of a queue standing by since a stop — see `send`. */
    ahead = false,
  ): void {
    // The user sees exactly one thing: their prompt, sent now. The
    // split and the turn-by-turn feed happen entirely out of sight.
    const attachments = storeAttachments(uploads);
    const userEvent: TranscriptEvent = {
      kind: "user",
      id: randomUUID(),
      text: text,
      ...(attachments.length ? { attachments } : {}),
      ts: Date.now(),
    };
    recordEvent(channelId, userEvent);
    checkpoint(channelId, userEvent.id);
    // the split is thinking before the harness is; the clock starts with
    // the prompt, not with whichever sub-prompt reaches a session first
    ctx.turns.startTurn(channelId);
    ctx.clients.broadcast({ type: "status", projectId: channelId, status: "working" });
    titleSession(channelId, text);
    const epoch = ctx.queues.epochs.get(channelId) ?? 0;
    void (smallModelEnabled() ? splitPrompt(text).catch(() => [text]) : Promise.resolve([text])).then(
      (prompts) => {
        if ((ctx.queues.epochs.get(channelId) ?? 0) !== epoch) return; // stopped meanwhile
        // route each attachment to the sub-prompt carrying its marker
        const parts = prompts.map((text) => ({ text, uploads: [] as AttachmentUpload[] }));
        for (const upload of uploads) {
          const marker = `[${upload.kind} #${upload.n}]`;
          const target = parts.find((p) => p.text.includes(marker)) ?? parts[0]!;
          target.uploads.push(upload);
        }
        const entries: QueueEntry[] = parts.map((part) => ({
          id: randomUUID(),
          text: part.text,
          uploads: part.uploads,
          silent: true,
        }));
        const idle = ahead ? !running(ctx, channelId) : !busy(ctx, channelId);
        const first = idle ? entries.shift() : undefined;
        if (entries.length > 0) {
          const queue = ctx.queues.entries.get(channelId) ?? [];
          if (ahead) queue.unshift(...entries);
          else queue.push(...entries);
          ctx.queues.entries.set(channelId, queue);
        }
        if (first) dispatch(channelId, first.text, first.uploads, true);
      },
    );
  }

  /** Send the next queued prompt, once the channel settles. Answers whether
   *  one went out — a caller deciding what a finished turn means next needs
   *  to know, and the send itself is a microtask away. */
  function drainQueue(channelId: string): boolean {
    if (ctx.queues.held.has(channelId)) return false;
    const queue = ctx.queues.entries.get(channelId);
    // the one being rewritten is not in line — whatever is behind it goes
    const at = queue?.findIndex((entry) => !entry.editing) ?? -1;
    if (!queue || at === -1) return false;
    const next = queue[at]!;
    queue.splice(at, 1);
    if (queue.length === 0) ctx.queues.entries.delete(channelId);
    if (!next.silent) ctx.queues.broadcastQueue(channelId);
    // after the session settles its result (it flips to idle right after
    // emitting it) — so the queued turn's "working" sticks
    queueMicrotask(() => {
      try {
        if (next.split) dispatchSplit(channelId, next.text, next.uploads);
        else dispatch(channelId, next.text, next.uploads, next.silent);
      } catch (err) {
        // the send failed (the channel vanished, the harness would not
        // start): the prompt goes back to the head of the line rather than
        // into the void, and the user hears why
        warn("server", err, `drainQueue ${channelId}`);
        const back = ctx.queues.entries.get(channelId) ?? [];
        back.unshift(next);
        ctx.queues.entries.set(channelId, back);
        ctx.queues.broadcastQueue(channelId);
        ctx.clients.broadcast({ type: "error", message: `queued prompt not sent: ${errorMessage(err)}` });
      }
    });
    return true;
  }

  function maybeRetry(channelId: string, event: TranscriptEvent): void {
    if (event.kind !== "result") return;
    // a turn that landed clears the count: the next blip starts from one
    if (event.ok || event.stopped) {
      ctx.retries.cancelRetry(channelId);
      return;
    }
    // always: an overload is weather, not a decision, and there is no
    // switch for waiting it out — a dropped turn is picked back up
    if (!event.transient) return;
    // Prompts standing by since an earlier stop are the user's, and they go
    // out on the user's word — a nudge would jump that line. (Prompts merely
    // queued are already handled: the caller only asks when the queue had
    // nothing to send. Note that `running` is still true here, since the
    // session flips to idle just after emitting this result — which is why
    // the wait below, not this, is where "is it busy now" is asked.)
    if (ctx.queues.held.has(channelId)) return;
    const attempt = (ctx.retries.get(channelId)?.attempt ?? 0) + 1;
    const wait = RETRY_WAITS_MS[attempt - 1];
    if (wait === undefined) {
      ctx.retries.cancelRetry(channelId);
      recordEvent(channelId, {
        kind: "info",
        id: randomUUID(),
        text: `${RETRY_WAITS_MS.length} goes and the API is still dropping it — leaving this one to you`,
        ts: Date.now(),
      });
      return;
    }
    recordEvent(channelId, {
      kind: "info",
      id: randomUUID(),
      text: `the API dropped that one — going again in ${Math.round(wait / 1000)}s (${attempt} of ${RETRY_WAITS_MS.length})`,
      ts: Date.now(),
    });
    const timer = setTimeout(() => {
      const project = channelProject(ctx, channelId);
      // gone, or busy with something the user sent while we waited
      if (!project || busy(ctx, channelId)) {
        ctx.retries.delete(channelId);
        return;
      }
      try {
        manager.send(project, RETRY_NUDGE, undefined, undefined, true);
      } catch (err) {
        warn("server", err, "retry nudge");
        ctx.retries.delete(channelId);
      }
    }, wait);
    ctx.retries.set(channelId, { attempt, timer });
  }

  /**
   * Commands written inside a prompt run before it. Each becomes its own
   * queue entry, in the order written, and the prompt (with them gone)
   * follows — through the queue too, so it cannot overtake them. Returns
   * false when the prompt held no commands, and the caller sends as usual.
   */
  function queueWithCommands(
    channelId: string,
    text: string,
    uploads: AttachmentUpload[],
    split: boolean,
    /** This prompt goes ahead of what is already queued — a queue that has
     *  been standing by since a stop waited for this one, not the reverse. */
    ahead = false,
  ): boolean {
    const { commands, rest } = splitCommands(text, knownCommands(ownerProject(ctx, channelId)?.path));
    if (commands.length === 0) return false;
    const wasBusy = ahead ? running(ctx, channelId) : busy(ctx, channelId);
    const entries: QueueEntry[] = commands.map((command) => ({
      id: randomUUID(),
      text: command,
      uploads: [],
      silent: false,
    }));
    if (rest || uploads.length > 0) {
      entries.push({
        id: randomUUID(),
        text: rest,
        uploads,
        silent: false,
        ...(split ? { split: true } : {}),
        ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
      });
    }
    const queue = ctx.queues.entries.get(channelId) ?? [];
    if (ahead) queue.unshift(...entries);
    else queue.push(...entries);
    ctx.queues.entries.set(channelId, queue);
    ctx.queues.broadcastQueue(channelId);
    if (!wasBusy) drainQueue(channelId);
    return true;
  }

  /**
   * ruri's custom /compact: retire the live session and its resume id, stash
   * the brief (turn summaries + full-record file paths) for the next prompt,
   * and drop the zigzag compaction mark into the transcript. No model call —
   * the summaries are precomputed, so this is instant.
   */
  function compactChannel(channelId: string): void {
    const built = buildCompaction(
      channelId,
      archive.allEvents(channelId),
      archive.summaries(channelId),
      archive.digest(channelId),
    );
    if (built === null) {
      const event: TranscriptEvent = {
        kind: "info",
        id: randomUUID(),
        text: "nothing to compact yet",
        ts: Date.now(),
      };
      archive.append(channelId, event);
      ctx.clients.pushEvent(channelId, event);
      drainQueue(channelId);
      return;
    }
    manager.dispose(channelId);
    archive.clearLastSessionId(channelId);
    archive.setPendingBrief(channelId, built.brief);
    resetContext(ctx, channelId);
    const event: TranscriptEvent = {
      kind: "compaction",
      id: randomUUID(),
      text: built.brief,
      entries: built.entries,
      ...(built.digest ? { digest: built.digest } : {}),
      ts: Date.now(),
    };
    // the mark folds everything before it into the history (archive.ts);
    // every window gets the live part as it now stands — the mark, alone
    archive.append(channelId, event);
    pushTranscript(ctx, channelId);
    drainQueue(channelId);
    // what just folded away shows as its notes — any it lacks, now
    backfillNotes([channelId], { first: true });
  }

  /**
   * Rewind a session running on a non-Claude harness.
   *
   * Those harnesses cannot fork a conversation at a message, so this rewinds
   * what ruri owns: the transcript truncates, the live session is retired,
   * and the next prompt re-seeds a fresh one with a brief of everything kept
   * — so what the model knows matches what is on screen.
   *
   * The files go back too, from ruri's own checkpoint of the moment before
   * the prompt ran (see checkpoints.ts). That is what makes a rewind here
   * the same move it is on Claude rather than a conversation-only apology.
   * A project that is not a git repository has no checkpoint, and the reply
   * says so instead of implying the files moved.
   */
  async function rewindOnHarness(
    ws: WebSocket,
    channelId: string,
    target: Extract<TranscriptEvent, { kind: "user" }>,
    why?: string,
  ): Promise<void> {
    const eventId = target.id;
    const project = channelProject(ctx, channelId);
    const failed =
      channelId === HOME_ID || !project?.path
        ? "there are no files to put back"
        : await ctx.checkpoints.restore(project, channelId, eventId);
    why ??= failed
      ? `the files were left as they are — ${failed} — and it restarts from a brief of what's kept`
      : "the files went back with it, and the harness restarts from a brief of what's kept";
    manager.dispose(channelId);
    archive.clearLastSessionId(channelId);
    const removed = archive.truncateFrom(channelId, eventId);
    if (removed.length > 0) {
      ctx.clients.broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
      pushTranscript(ctx, channelId);
      if (tracker.removeForTurns(channelId, removed)) {
        ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
      }
      // the prompt itself keeps its checkpoint: it is back in the composer,
      // and sending it again is a new prompt with a new one
      if (project?.path) void ctx.checkpoints.forget(project, channelId, removed.filter((id) => id !== eventId));
    }
    // the brief covers what survived the truncation — the harness comes back
    // knowing that and nothing after it
    const kept = buildCompaction(
      channelId,
      archive.allEvents(channelId),
      archive.summaries(channelId),
      archive.digest(channelId),
    );
    // nothing survived: the next prompt opens a genuinely new session, so
    // any brief left from before must not ride along
    archive.setPendingBrief(channelId, kept?.brief ?? "");
    resetContext(ctx, channelId);
    ctx.clients.broadcast({ type: "status", projectId: channelId, status: "idle" });
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(composeBack(channelId, target)));
    ws.send(
      JSON.stringify({
        type: "error",
        message: `rewound the conversation — ${why}`,
      } satisfies ServerMessage),
    );
  }

  /** Restore ruri's file checkpoint and retain the provider's real context. */
  async function rewindOnNativeProvider(
    ws: WebSocket,
    channelId: string,
    target: Extract<TranscriptEvent, { kind: "user" }>,
    resumeAt?: string,
  ): Promise<void> {
    const project = channelProject(ctx, channelId);
    const failed = project?.path
      ? await ctx.checkpoints.restore(project, channelId, target.id)
      : "there are no files to put back";
    manager.dispose(channelId);
    if (resumeAt) archive.setResumeAt(channelId, resumeAt);
    else archive.clearLastSessionId(channelId);
    const removed = archive.truncateFrom(channelId, target.id);
    if (removed.length > 0) {
      ctx.clients.broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
      pushTranscript(ctx, channelId);
      if (tracker.removeForTurns(channelId, removed)) {
        ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
      }
    }
    if (project?.path) void ctx.checkpoints.forget(project, channelId, removed.filter((id) => id !== target.id));
    archive.setPendingBrief(channelId, "");
    resetContext(ctx, channelId);
    ctx.clients.broadcast({ type: "status", projectId: channelId, status: "idle" });
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(composeBack(channelId, target)));
    ws.send(
      JSON.stringify({
        type: "error",
        message: failed
          ? `rewound the native conversation — the files were left as they are: ${failed}`
          : "rewound the native conversation and restored the project's files",
      } satisfies ServerMessage),
    );
  }

  /**
   * A rewound prompt goes back to the composer whole: the words, and every
   * file that was clipped to them — the archive still holds the bytes, and
   * the boxes drawn on the images ride the attachment record, so the strip
   * comes back exactly as it was sent.
   */
  function composeBack(channelId: string, target: Extract<TranscriptEvent, { kind: "user" }>): ServerMessage {
    return {
      type: "compose",
      projectId: channelId,
      text: target.text,
      ...(target.attachments?.length ? { attachments: target.attachments } : {}),
    };
  }

  /** Store one half of a turn's recall note and push the turn's notes. */
  function noteSummary(projectId: string, turnId: string, part: "user" | "reply", note: string): void {
    archive.setSummary(projectId, turnId, part, note);
    ctx.clients.broadcast({ type: "turn_summary", projectId, turnId, note: archive.note(projectId, turnId) });
    // an exchange just got its last note: the list may be past its cap
    if (part === "reply") void ctx.digests.run(projectId);
  }

  /**
   * Recall notes the small model never wrote, written now, in the
   * background. A note goes missing whenever the small model can't answer
   * (its subscription out of quota, the machine offline, the app quit
   * mid-call), and a missing note used to stay missing: the folded
   * exchanges above a compaction and every later brief fell back to a raw
   * cut of the text — and a chat opened before its notes were written
   * showed that cut, then swapped to the notes a few seconds later. So the
   * whole backlog is worked through right after launch, and again hourly
   * (after the first run there's nothing left, so that costs nothing); a
   * chat that opens or compacts jumps the queue. NOTE_WORKERS calls run at
   * once. A half the model answered with nothing usable is kept as "" and
   * not asked for again; three failures in a row end the run until the
   * next thing starts one.
   */
  interface NoteJob {
    channelId: string;
    turn: Turn;
    part: "user" | "reply";
    key: string;
  }
  const NOTE_WORKERS = 3;
  const noteJobs: NoteJob[] = [];
  /** Jobs queued or in flight, by channel:turn:part — never twice at once. */
  const noteKeys = new Set<string>();
  let noteWorkers = 0;
  let noteMisses = 0;

  function backfillNotes(channelIds: Iterable<string>, options: { first?: boolean } = {}): void {
    if (!smallModelEnabled()) return;
    const fresh: NoteJob[] = [];
    for (const channelId of channelIds) {
      if (channelId === HOME_ID) continue;
      for (const { turn, part } of missingNotes(channelId)) {
        const key = `${channelId}:${turn.turnId}:${part}`;
        if (noteKeys.has(key)) {
          // already waiting: a chat on screen pulls its own to the front
          const at = options.first ? noteJobs.findIndex((job) => job.key === key) : -1;
          if (at !== -1) fresh.push(...noteJobs.splice(at, 1));
          continue;
        }
        noteKeys.add(key);
        fresh.push({ channelId, turn, part, key });
      }
    }
    if (options.first) noteJobs.unshift(...fresh);
    else noteJobs.push(...fresh);
    // something new asked: the models get a fresh chance
    noteMisses = 0;
    while (noteWorkers < NOTE_WORKERS && noteJobs.length > 0) void noteWorker();
  }

  async function noteWorker(): Promise<void> {
    noteWorkers += 1;
    try {
      while (noteJobs.length > 0 && noteMisses < 3) {
        const job = noteJobs.shift()!;
        try {
          // a chat closed meanwhile, or a note the live path wrote first
          if (!store.sessionIds().includes(job.channelId)) continue;
          if (archive.summaries(job.channelId)[job.turn.turnId]?.[job.part] !== undefined) continue;
          const note = job.part === "user" ? await summarizePrompt(job.turn.user) : await summarizeReply(job.turn);
          noteMisses = 0;
          // a rewind may have taken the turn while its note was written
          if (!turnStands(job.channelId, job.turn.turnId)) continue;
          if (note) noteSummary(job.channelId, job.turn.turnId, job.part, note);
          else archive.setSummary(job.channelId, job.turn.turnId, job.part, "");
        } catch (err) {
          warn("server", err, "noteWorker");
          noteMisses += 1;
        } finally {
          noteKeys.delete(job.key);
        }
      }
      if (noteMisses >= 3) {
        for (const job of noteJobs) noteKeys.delete(job.key);
        noteJobs.length = 0;
      }
    } finally {
      noteWorkers -= 1;
    }
  }

  /** A chat's missing note halves, newest first — the ones nearest the
   *  bottom of the chat are the ones looked at. */
  function missingNotes(channelId: string): Array<{ turn: Turn; part: "user" | "reply" }> {
    const notes = archive.summaries(channelId);
    // anything this young is still being noted live
    const settled = Date.now() - 2 * 60_000;
    const jobs: Array<{ turn: Turn; part: "user" | "reply" }> = [];
    for (const { turn, ts, finished } of assembleTurns(archive.allEvents(channelId)).reverse()) {
      if (ts > settled) continue;
      const note = notes[turn.turnId];
      if (note?.user === undefined && turn.user.trim()) jobs.push({ turn, part: "user" });
      if (note?.reply === undefined && finished && turn.assistant.trim()) jobs.push({ turn, part: "reply" });
    }
    return jobs;
  }

  function turnStands(channelId: string, turnId: string): boolean {
    return (
      archive.events(channelId).some((event) => event.id === turnId) ||
      archive.earlier(channelId).some((item) => item.kind === "turn" && item.turnId === turnId)
    );
  }

  // Every finished turn goes to the small model in the background for a
  // reply recall note (instant compaction). Failures are silent — a nicety.
  // The catch-up brief writes itself: each finished turn is folded in, and
  // most turns change nothing — a fix or a polish pass is not a feature.
  function foldBrief(channelId: string, turn: { user: string; assistant: string }): void {
    if (channelId === HOME_ID) return;
    const project = store.findSession(channelId)?.project;
    if (!project) return;
    const current = briefs.get(project.id);
    updateBrief(
      project.name,
      { description: current.description, features: current.features },
      `The user asked:\n${turn.user}\n\nWhat the agent did:\n${turn.assistant}`,
    )
      .then((next) => {
        if (!next) return;
        if (next.description === current.description &&
            next.features.join("\n") === current.features.join("\n")) {
          return;
        }
        writeCatchupFile(project.path, project.name, briefs.write(project.id, next));
      })
      .catch(() => {});
  }

  /* ── the catch-up brief, written whole ───────────────────────────── */

  function catchupNote(projectId: string, busy: boolean, note?: string): void {
    ctx.clients.broadcast({
      type: "catchup",
      projectId,
      busy,
      ...(briefs.get(projectId).built ? { built: briefs.get(projectId).built } : {}),
      ...(note ? { note } : {}),
    });
  }

  /**
   * Read the repo and write the whole brief. Runs by itself when a project
   * arrives without one — a project opened with a year of work in it is
   * exactly the one whose first session most needs to be told what it is —
   * and again whenever the user asks.
   */
  async function rebuildCatchup(projectId: string): Promise<void> {
    const project = store.get(projectId);
    if (!project || ctx.catchingUp.has(projectId) || !smallModelEnabled()) return;
    ctx.catchingUp.add(projectId);
    catchupNote(projectId, true, "reading the repo…");
    try {
      const current = briefs.get(projectId);
      const built = await buildCatchup(project, current);
      if (!built) {
        catchupNote(projectId, false, "the brief could not be written — try again");
        return;
      }
      writeCatchupFile(project.path, project.name, briefs.write(projectId, built, true));
      catchupNote(projectId, false, "brief written");
    } catch (err) {
      warn("server", err, "rebuildCatchup");
      catchupNote(projectId, false, "the brief could not be written — try again");
    } finally {
      ctx.catchingUp.delete(projectId);
    }
  }

  /** Whether a project has a brief worth the name. */
  function briefless(projectId: string): boolean {
    const brief = briefs.get(projectId);
    return !brief.description && brief.features.length === 0;
  }

  // Projects that arrived before this existed: one at a time, in the
  // background, so a launch with ten of them does not fire ten reads of the
  // small model at once.
  void (async () => {
    for (const project of store.list()) {
      if (!briefless(project.id)) continue;
      await rebuildCatchup(project.id);
    }
  })();

  const turnTracker = new TurnTracker((projectId, turn) => {
    if (!smallModelEnabled()) return;
    const found = store.findSession(projectId);
    if (found && !found.session.title) {
      sessionRoleTitle(turn)
        .then((title) => {
          if (!title) return;
          store.setSessionTitle(projectId, title);
          ctx.clients.broadcast({ type: "projects", projects: store.list() });
        })
        .catch(() => {});
    }
    summarizeReply(turn)
      .then((note) => {
        if (note) noteSummary(projectId, turn.turnId, "reply", note);
      })
      .catch(() => {});
    foldBrief(projectId, turn);
  });
  ctx.turnTracker = turnTracker;

  /**
   * Archive, observe, log (Home), and broadcast one transcript event.
   *
   * Anything the model produced is redacted first: a command that echoed a
   * vault value leaves the handle behind rather than the value, on screen
   * and on disk both. The user's own prompts are left exactly as typed —
   * rewinding matches a prompt against what the CLI recorded, and rewriting
   * it here would break that for the sake of a value the user chose to type.
   */
  /** An event with the vault's values taken back out of everything it
   *  shows — a subagent's card included: its brief, its line, its report. */
  function redacted(raw: TranscriptEvent): TranscriptEvent {
    if (raw.kind === "assistant" || raw.kind === "info") return { ...raw, text: secrets.redact(raw.text) };
    if (raw.kind !== "tool") return raw;
    const agent = raw.agent && {
      ...raw.agent,
      description: secrets.redact(raw.agent.description),
      ...(raw.agent.prompt ? { prompt: secrets.redact(raw.agent.prompt) } : {}),
      ...(raw.agent.activity ? { activity: secrets.redact(raw.agent.activity) } : {}),
      ...(raw.agent.result ? { result: secrets.redact(raw.agent.result) } : {}),
    };
    return { ...raw, summary: secrets.redact(raw.summary), ...(agent ? { agent } : {}) };
  }

  function recordEvent(projectId: string, raw: TranscriptEvent): void {
    const event = redacted(raw);
    archive.append(projectId, event);
    ctx.turnTracker.observe(projectId, event);
    if (projectId === HOME_ID) homeLog.observe(event);
    ctx.clients.pushEvent(projectId, event);
    // every prompt gets its recall note AND its tracker split the moment
    // it's sent — neither waits on (or survives only with) a finished turn,
    // so interrupted turns and "continue" follow-ups can't lose requests.
    // The reply's recall half lands separately when the turn finishes.
    if (event.kind === "user" && smallModelEnabled()) {
      summarizePrompt(event.text)
        .then((note) => {
          if (note) noteSummary(projectId, event.id, "user", note);
        })
        .catch(() => {});
      if (projectId !== HOME_ID) {
        extractTrackerItems(event.text, tracker.openTexts(projectId))
          .then((items) => {
            if (items.length === 0) return;
            for (const text of items) tracker.add(projectId, text, "auto", event.id);
            ctx.clients.broadcast({ type: "tracker", projectId, items: tracker.items(projectId) });
          })
          .catch(() => {});
      }
    }
  }

  const manager = new SessionManager(
    {
      onEvent: (projectId, event) => {
        // the finished message carries its whole text — the held tail too
        if (event.kind === "assistant" && ctx.turns.gates.get(projectId)?.messageId === event.id) ctx.turns.gates.delete(projectId);
        ctx.readable.allowReadImages(projectId, [event]);
        recordEvent(projectId, event);
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
          if (!drainQueue(projectId)) maybeRetry(projectId, event);
          else ctx.retries.cancelRetry(projectId);
        }
      },
      onEventUpdate: (projectId, raw) => {
        // a subagent's card moving along: replaced where it stands, and
        // only while it still stands in the live transcript
        const event = redacted(raw);
        if (archive.replace(projectId, event)) ctx.clients.pushEvent(projectId, event);
      },
      onAgentEvent: (projectId, key, raw) => {
        const event = redacted(raw);
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
  function crewProject(chatId: string, key: string, model?: string) {
    const chat = channelProject(ctx, chatId);
    return chat && { ...chat, id: key, ...(model ? { model } : {}) };
  }

  /** Move one of the user's agents' cards along, and show the chat its crew. */
  function crewCard(key: string, patch: Partial<SubagentState>): void {
    const chatId = crew.owner(key);
    if (!chatId || !crew.update(key, patch)) return;
    ctx.clients.toViewers(chatId, { type: "crew", projectId: chatId, agents: crew.list(chatId) });
  }

  /** Something one of the user's agents did, into a log (its own, or an
   *  agent of its own's): true when it is new there. */
  function crewLog(key: string, logKey: string, raw: TranscriptEvent): boolean {
    const chatId = crew.owner(key);
    if (!chatId) return false;
    const event = redacted(raw);
    ctx.readable.allowReadImages(chatId, [event]);
    const added = agentLogs.append(chatId, logKey, event);
    ctx.clients.toViewers(chatId, { type: "agent_event", projectId: chatId, key: logKey, event });
    return added;
  }

  /** Another turn for one of the user's agents, once it is done: more to
   *  do, or the answers to its questions. */
  function followCrew(key: string, text: string): void {
    const chatId = crew.owner(key);
    const member = crew.member(key);
    const project = chatId && member ? crewProject(chatId, key, member.agent.model) : undefined;
    if (!project || member?.agent.status === "running") return;
    ctx.crewSaid.delete(key);
    crewCard(key, { status: "running", startedAt: Date.now(), endedAt: undefined, result: undefined, activity: undefined });
    crewManager.send(project, text);
  }

  /** One of the user's agents finished a turn: its card says how, and
   *  what it came back with; what it spent is its project's. */
  function settleCrew(key: string, event: Extract<TranscriptEvent, { kind: "result" }>): void {
    const chatId = crew.owner(key);
    const card = crew.member(key)?.agent;
    if (!chatId || !card) return;
    const said = ctx.crewSaid.get(key);
    ctx.crewSaid.delete(key);
    crewCard(key, {
      status: event.stopped ? "stopped" : event.ok ? "done" : "failed",
      endedAt: Date.now(),
      activity: undefined,
      ...(event.tokens ? { tokens: (card.tokens ?? 0) + event.tokens } : {}),
      ...(said ? { result: said } : event.error && !event.ok ? { result: secrets.redact(event.error) } : {}),
    });
    const owner = ownerProject(ctx, chatId);
    if (owner && (event.tokens || event.costUsd || event.durationMs)) {
      ledger.record(owner.id, {
        ...(event.tokens ? { tokens: event.tokens } : {}),
        ...(event.costUsd ? { costUsd: event.costUsd } : {}),
        ...(event.durationMs ? { ms: event.durationMs } : {}),
      });
      ctx.clients.broadcast({ type: "stats", projectId: owner.id, stats: ledger.stats(owner.id) });
    }
    ctx.usage.pushUsage();
  }

  const crewManager = new SessionManager(
    {
      onEvent: (key, raw) => {
        if (raw.kind === "result") {
          settleCrew(key, raw);
          return;
        }
        const added = crewLog(key, key, raw);
        if (raw.kind === "assistant") ctx.crewSaid.set(key, secrets.redact(raw.text));
        if (raw.kind === "tool" && added) {
          const card = crew.member(key)?.agent;
          crewCard(key, {
            tools: (card?.tools ?? 0) + 1,
            activity: secrets.redact(`${raw.name} ${raw.summary}`.trim()),
          });
        }
      },
      // its own agents' cards moving along, and what they did: its log
      onEventUpdate: (key, raw) => void crewLog(key, key, raw),
      onAgentEvent: (key, nested, raw) => void crewLog(key, nested, raw),
      // its log takes whole messages, the way a harness's agents' logs do
      onDelta: () => {},
      onStatus: (key, status) => {
        if (crew.member(key)?.agent.status !== "running") return;
        if (status === "permission") crewCard(key, { activity: "waiting on you: allow or deny it" });
        // a process gone without a word about its turn
        else if (status === "error") crewCard(key, { status: "failed", endedAt: Date.now() });
      },
      onPermission: (raw) => {
        // the chat's card — marked as this agent's — so it shows wherever
        // the chat does, and on the agent's own page
        const chatId = crew.owner(raw.projectId);
        if (!chatId) return;
        const request: PermissionRequest = {
          ...raw,
          projectId: chatId,
          agent: raw.projectId,
          input: secrets.redactInput(raw.input),
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
      onSessionId: (key, sessionId) => crew.setSessionId(key, sessionId),
      onContext: () => {},
      onProgress: () => {},
      onChain: () => {},
    },
    (key) => crew.sessionId(key),
    (project) => {
      const claude = !ctx.models.registry.parse(project.model || store.defaultModel()).providerId;
      const note = [
        sessionBriefing({ projectDir: project.path, projectName: project.name, secrets, claude, naming: "" }),
        CREW_BRIEFING,
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        fillSecrets: (input) => (secrets.wanted(JSON.stringify(input)) ? secrets.fillInput(input) : undefined),
        options: { env: secrets.env(), systemPrompt: { type: "preset", preset: "claude_code", append: note } },
        providerSystem: note,
      };
    },
    {
      parse: (model) => ctx.models.registry.parse(model),
      create: (id, workDir) => ctx.models.registry.createFor(id, workDir, secrets.env()),
      canFork: (id) => ctx.models.registry.canForkSession(id),
    },
  );
  ctx.crewManager = crewManager;
  crewManager.useDefaultModel(() => store.defaultModel());

  /** Tear down one project and everything its sessions accumulated. */
  function closeProjectById(projectId: string): void {
    const closing = store.get(projectId);
    for (const sessionId of closing?.sessions.map((s) => s.id) ?? []) {
      if (closing?.path) void ctx.checkpoints.forgetChannel(closing, sessionId).catch(() => undefined);
      manager.dispose(sessionId);
      archive.remove(sessionId);
      removeTurnFiles(sessionId);
      for (const key of crew.remove(sessionId)) crewManager.dispose(key);
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
        if (briefless(project.id)) void rebuildCatchup(project.id);
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
        titleSession(sessionId, kickoffPrompt);
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

  function handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case "add_project": {
        const project = store.add(msg.name, msg.path, msg.folder);
        ctx.clients.broadcast({ type: "projects", projects: store.list() });
        if (briefless(project.id)) void rebuildCatchup(project.id);
        break;
      }
      case "catchup_rebuild": {
        void rebuildCatchup(msg.projectId);
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
        if (queueWithCommands(channelId, msg.text, uploads, false, ahead)) break;
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
        dispatch(channelId, msg.text, uploads);
        break;
      }
      case "send_split": {
        if (msg.text.trim().length === 0) return;
        const channelId = msg.projectId;
        const uploads = msg.attachments ?? [];
        ctx.retries.cancelRetry(channelId);
        if (!channelProject(ctx, channelId)) throw new Error("unknown session");
        const ahead = ctx.queues.releaseQueue(channelId) && !running(ctx, channelId);
        if (queueWithCommands(channelId, msg.text, uploads, true, ahead)) break;
        dispatchSplit(channelId, msg.text, uploads, ahead);
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
        if (!running(ctx, msg.projectId)) drainQueue(msg.projectId);
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
        if (!ctx.queues.held.has(msg.projectId) && !running(ctx, msg.projectId)) drainQueue(msg.projectId);
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
        if (!running(ctx, channelId)) drainQueue(channelId);
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
        if (!ctx.queues.held.has(channelId) && !running(ctx, channelId)) drainQueue(channelId);
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
      case "rewind": {
        // Conversation AND code, back to just before this prompt ran: the
        // CLI restores its file checkpoints, then the session resumes
        // truncated (forked) at the kept turn's last chain entry. The prompt
        // itself lands back in the composer — nothing is sent for you.
        //
        // Other harnesses keep no checkpoints and cannot fork a conversation,
        // so theirs rewinds what ruri owns: the transcript is truncated and
        // the harness is retired, re-seeded on the next prompt with a brief
        // of everything kept (the same brief /compact writes). Their files
        // stay as they are, and the reply says so.
        const channelId = msg.projectId;
        const eventId = msg.eventId;
        void (async () => {
          try {
            if (busy(ctx, channelId)) throw new Error("stop the running turn first");
            const events = archive.allEvents(channelId);
            const idx = events.findIndex((e) => e.id === eventId);
            const target = idx >= 0 ? events[idx] : undefined;
            if (!target || target.kind !== "user") throw new Error("that prompt is gone");
            const project = channelProject(ctx, channelId);
            if (!project) throw new Error("unknown session");
            const chain = archive.chain(channelId);
            // The fork point: the latest checkpointed turn before the target.
            // A compaction started a different session, so the scan stops
            // there rather than failing — it only means the chain has nothing
            // to offer, and the fork point is then read from the session's own
            // transcript below, which is where it comes from nowadays anyway
            // (the SDK stopped echoing prompts, so `chain` is usually empty).
            let resumeAt: string | undefined;
            for (let i = idx - 1; i >= 0; i--) {
              const ev = events[i]!;
              if (ev.kind === "compaction") break;
              if (ev.kind === "user" && chain[ev.id]?.last) {
                resumeAt = chain[ev.id]!.last;
                break;
              }
            }
            // A compaction *after* the prompt is different: the session running
            // now began at that boundary, so it holds neither a uuid to fork at
            // nor a checkpoint to restore. That isn't a reason to refuse — it's
            // the same ground a harness rewind stands on, so it takes that path
            // and says so.
            if (events.some((e, i) => i > idx && e.kind === "compaction")) {
              // The CLI's session began at that boundary, so it has nothing
              // to restore — but ruri's checkpoint was taken by ruri, and a
              // compaction is not a thing that happens to it.
              await rewindOnHarness(ws, channelId, target);
              return;
            }
            const providerId = ctx.models.registry.parse(project.model).providerId;
            if (providerId !== undefined) {
              if (ctx.models.registry.canForkSession(providerId)) {
                // A native provider fork can keep the exact conversation
                // prefix. If this is the first prompt ever, clearing the
                // source id is the exact same empty prefix. A first prompt
                // after a compaction has older briefed context but no prior
                // provider turn to anchor, so it takes the honest fallback.
                const keptHasContext = events
                  .slice(0, idx)
                  .some((event) => event.kind === "user" || event.kind === "compaction");
                if (resumeAt || !keptHasContext) {
                  await rewindOnNativeProvider(ws, channelId, target, resumeAt);
                  return;
                }
              }
              await rewindOnHarness(ws, channelId, target);
              return;
            }
            // The prompt's uuid, which the CLI keys its file checkpoints by,
            // comes from the session's own transcript: the SDK no longer
            // echoes prompts back, so the chain map built from those echoes
            // can be empty — or, worse, have pinned a neighbouring message.
            // `ordinal` picks between prompts sent with identical text.
            const sessionId = archive.lastSessionId(channelId);
            const ordinal = events.filter(
              (e, i) => i < idx && e.kind === "user" && e.text.trim() === target.text.trim(),
            ).length;
            const found = sessionId
              ? await promptChain(project, sessionId, target.text, ordinal)
              : undefined;
            const userUuid = found?.user ?? chain[eventId]?.user;
            if (userUuid) archive.setChain(channelId, eventId, "user", userUuid);
            resumeAt ??= found?.before;
            // A missing file checkpoint is not the end of the rewind: the CLI
            // keeps checkpoints with the process that took them, so a prompt
            // from before a relaunch has none. The conversation still rewinds
            // and the prompt still comes back — the files are simply left as
            // they are, and the user is told so.
            const result = userUuid
              ? await manager.rewindFiles(project, userUuid)
              : { canRewind: false, error: "no checkpoint recorded for that prompt" };
            // The CLI's own checkpoint is the better one when it is there —
            // it knows the session. When it isn't, ruri took its own before
            // the prompt went out, and that is what a relaunch cannot lose.
            const mine = result.canRewind ? undefined : await ctx.checkpoints.restore(project, channelId, eventId);
            const filesKept = result.canRewind || mine === undefined
              ? undefined
              : (result.error ?? "the CLI couldn't restore the files");
            manager.dispose(channelId);
            if (resumeAt) archive.setResumeAt(channelId, resumeAt);
            else archive.clearLastSessionId(channelId);
            const removed = archive.truncateFrom(channelId, eventId);
            if (removed.length > 0) {
              ctx.clients.broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
      pushTranscript(ctx, channelId);
              // items are tied to the prompts they were split from — the
              // rewound prompt's items (and every discarded later prompt's)
              // go too; the edited prompt re-extracts fresh ones on send
              if (tracker.removeForTurns(channelId, removed)) {
                ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
              }
              void ctx.checkpoints.forget(project, channelId, removed.filter((id) => id !== eventId));
            }
            ctx.clients.broadcast({ type: "status", projectId: channelId, status: "idle" });
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(composeBack(channelId, target)));
            if (filesKept && ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: `rewound the conversation, but the files were left as they are — ${filesKept}`,
                } satisfies ServerMessage),
              );
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: `rewind failed: ${errorMessage(err)}`,
                } satisfies ServerMessage),
              );
            }
          }
        })();
        break;
      }
      case "fork": {
        // A new session in the same project, holding everything through
        // this prompt's exchange and carrying on from there; the original
        // is not touched. On Claude the CLI session itself forks at that
        // point (a shared file up to it, then its own); Codex forks its native
        // thread at the provider turn recorded for the exchange. A harness
        // without that primitive — or a retired pre-compaction session —
        // opens on a brief of what the fork holds.
        const channelId = msg.projectId;
        void (async () => {
          try {
            const found = store.findSession(channelId);
            if (!found) throw new Error("only a project's session can be forked");
            const events = archive.allEvents(channelId);
            const idx = events.findIndex((e) => e.id === msg.eventId);
            const target = idx >= 0 ? events[idx] : undefined;
            if (!target || target.kind !== "user") throw new Error("that prompt is gone");
            let end = idx + 1;
            while (end < events.length && events[end]!.kind !== "user" && events[end]!.kind !== "compaction") end++;
            const kept = events.slice(0, end);
            const next = events.slice(end).find((e) => e.kind === "user");
            const compactedSince = events.slice(end).some((e) => e.kind === "compaction");
            const project = channelProject(ctx, channelId) ?? found.project;
            const fresh = store.newSession(found.project.id);
            if (!fresh) throw new Error("unknown project");
            const title = found.session.title ? `${found.session.title} fork` : "fork";
            store.setSessionTitle(fresh.id, title);
            // the fork runs on what it forked from, not on whatever the
            // project's default has become since
            store.copySessionSettings(channelId, fresh.id);
            const source = archive.raw(channelId);
            archive.seed(fresh.id, {
              events: kept,
              summaries: source.summaries,
              chain: source.chain ?? {},
              ...(source.contextTokens !== undefined ? { contextTokens: source.contextTokens } : {}),
              ...(source.contextWindow !== undefined && source.contextWindowModel !== undefined
                ? { contextWindow: source.contextWindow, contextWindowModel: source.contextWindowModel }
                : {}),
            });
            const providerId = ctx.models.registry.parse(project.model).providerId;
            const claude = providerId === undefined;
            const nativeFork = claude || ctx.models.registry.canForkSession(providerId);
            const sessionId = archive.lastSessionId(channelId);
            let forked = false;
            if (nativeFork && sessionId && !compactedSince) {
              // the branch point: the last chain entry of this exchange. From
              // the chain map when a turn recorded it, else from the CLI's
              // own transcript as the entry before the next prompt — and a
              // fork at the latest exchange needs no point at all.
              let at = archive.chain(channelId)[target.id]?.last;
              if (!at && next && claude) {
                const ordinal = events.filter(
                  (e, i) => i < events.indexOf(next) && e.kind === "user" && e.text.trim() === next.text.trim(),
                ).length;
                at = (await promptChain(project, sessionId, next.text, ordinal))?.before;
              }
              if (at || !next) {
                archive.setLastSessionId(fresh.id, sessionId);
                if (at) archive.setResumeAt(fresh.id, at);
                else archive.setForkNext(fresh.id);
                forked = true;
              }
            }
            if (!forked) {
              // the source's digest comes along when the fork keeps all it
              // folded; one that reaches past the fork point would remember
              // exchanges the fork never had
              const source = archive.digest(channelId);
              const digest =
                source && kept.some((e) => e.kind === "user" && e.id === source.through) ? source : undefined;
              if (digest) archive.setDigest(fresh.id, digest);
              const built = buildCompaction(fresh.id, kept, archive.summaries(fresh.id), digest);
              if (built) archive.setPendingBrief(fresh.id, built.brief);
            }
            ctx.clients.broadcast({ type: "projects", projects: store.list() });
            ctx.clients.broadcast({
              type: "transcript",
              projectId: fresh.id,
              events: ctx.readable.allowArchived({ [fresh.id]: archive.events(fresh.id) })[fresh.id] ?? [],
              summaries: archive.allSummaries([fresh.id])[fresh.id] ?? {},
              earlier: archive.earlier(fresh.id),
            });
            const tokens = archive.contextTokens(fresh.id);
            if (tokens !== undefined) {
              ctx.clients.broadcast({ type: "context", projectId: fresh.id, context: { tokens, window: contextWindow(ctx, fresh.id) } });
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "open_session", projectId: fresh.id } satisfies ServerMessage));
              if (!forked && nativeFork) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    message: "forked the conversation — the session that held it is gone, so the fork starts from a brief of what it holds",
                  } satisfies ServerMessage),
                );
              }
            }
          } catch (err) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: `fork failed: ${errorMessage(err)}`,
                } satisfies ServerMessage),
              );
            }
          }
        })();
        break;
      }
      case "transcript_get": {
        // the rest of a chat the snapshot only carried the tail of — to
        // the asker alone, with its pictures made readable on the way
        const id = msg.projectId;
        if (id !== HOME_ID && !store.sessionIds().includes(id)) break;
        ws.send(JSON.stringify(transcriptOf(ctx, id)));
        // the chat on screen gets its missing notes before any other
        backfillNotes([id], { first: true });
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
      case "agent_log": {
        const id = msg.projectId;
        if (id !== HOME_ID && !store.sessionIds().includes(id)) break;
        const events = agentLogs.read(id, msg.key);
        ctx.readable.allowReadImages(id, events);
        ws.send(JSON.stringify({ type: "agent_log", projectId: id, key: msg.key, events } satisfies ServerMessage));
        break;
      }
      case "agent_start": {
        const chatId = msg.projectId;
        const text = msg.text.trim();
        if (chatId === HOME_ID || !text || !/^crew-[a-z0-9]{6,32}$/.test(msg.key) || crew.owner(msg.key)) break;
        const project = crewProject(chatId, msg.key, msg.model);
        if (!project) break;
        crew.add(chatId, {
          key: msg.key,
          description: briefLine(text),
          prompt: text,
          model: project.model || store.defaultModel(),
          status: "running",
          mine: true,
          startedAt: Date.now(),
        });
        ctx.clients.toViewers(chatId, { type: "crew", projectId: chatId, agents: crew.list(chatId) });
        crewManager.send(project, text);
        break;
      }
      case "agent_send": {
        if (crew.owner(msg.key) !== msg.projectId || !msg.text.trim()) break;
        followCrew(msg.key, msg.text.trim());
        break;
      }
      case "agent_stop": {
        if (crew.owner(msg.key) !== msg.projectId) break;
        const status = crewManager.statuses()[msg.key];
        if (status && status !== "idle") crewManager.interrupt(msg.key);
        // nothing running to stop: only the card still thought so
        else crewCard(msg.key, { status: "stopped", endedAt: Date.now(), activity: undefined });
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
        if (firstPrompt && firstPrompt.kind === "user") titleSession(fresh.id, firstPrompt.text);
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
        for (const key of crew.remove(msg.sessionId)) crewManager.dispose(key);
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
        crewManager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
        break;
      }
      case "question_response": {
        // The card is answered. If the tool call behind it is still waiting,
        // the answers go into it; if it has moved on (the turn ended, or the
        // CLI gave up on the hook), they go out as a prompt of their own —
        // never into a hole.
        const request = ctx.permissions.get(msg.requestId);
        let outcome = manager.respondQuestion(msg.requestId, msg.answers);
        if (outcome === "none") outcome = crewManager.respondQuestion(msg.requestId, msg.answers);
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
          followCrew(request.agent, text);
          break;
        }
        const channelId = request.projectId;
        if (busy(ctx, channelId)) {
          const queue = ctx.queues.entries.get(channelId) ?? [];
          queue.push({ id: randomUUID(), text, uploads: [], silent: false });
          ctx.queues.entries.set(channelId, queue);
          ctx.queues.broadcastQueue(channelId);
        } else {
          dispatch(channelId, text, []);
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

      /* ── the component index ──────────────────────────────────── */
      case "component_named": {
        const pending = ctx.pendingComponents.get(msg.requestId);
        if (!pending) break;
        ctx.pendingComponents.delete(msg.requestId);
        ctx.permissions.delete(msg.requestId);
        ctx.clients.broadcast({ type: "permission_resolved", requestId: msg.requestId });
        const owner = ownerProject(ctx, pending.channelId);
        const name = (msg.name ?? pending.proposal.name).trim();
        if (msg.skip || !name || !owner) {
          // nothing is written down, including the copy of the screenshot
          // taken when the card went up
          const orphan = pending.proposal.image?.url;
          if (orphan) fs.rmSync(storedFilePath(orphan), { force: true });
          pending.resolve(null);
          break;
        }
        const item = components.add(owner.id, {
          name,
          files: msg.files ?? pending.proposal.files,
          note: msg.note ?? pending.proposal.note,
        });
        // already copied when the card went up, so it is kept with the
        // entry no matter what has happened to the model's own file
        if (pending.proposal.image) components.addShot(owner.id, item.id, pending.proposal.image);
        pushComponents(owner.id, owner.path);
        pending.resolve(name);
        break;
      }
      case "component_update": {
        components.update(msg.projectId, msg.componentId, {
          ...(msg.name !== undefined ? { name: msg.name } : {}),
          ...(msg.aliases !== undefined ? { aliases: msg.aliases } : {}),
          ...(msg.files !== undefined ? { files: msg.files } : {}),
          ...(msg.note !== undefined ? { note: msg.note } : {}),
          ...(msg.selector !== undefined ? { selector: msg.selector } : {}),
          ...(msg.route !== undefined ? { route: msg.route } : {}),
          ...(msg.clicks !== undefined ? { clicks: msg.clicks } : {}),
        });
        pushComponents(msg.projectId, store.get(msg.projectId)?.path);
        break;
      }
      case "component_remove": {
        components.remove(msg.projectId, msg.componentId);
        pushComponents(msg.projectId, store.get(msg.projectId)?.path);
        break;
      }
      case "component_shot": {
        const { url } = storeUpload(msg.upload);
        const { data: _data, regions: _regions, ...meta } = msg.upload;
        components.addShot(msg.projectId, msg.componentId, { ...meta, url });
        pushComponents(msg.projectId, store.get(msg.projectId)?.path);
        break;
      }
      case "component_unshot": {
        components.removeShot(msg.projectId, msg.componentId, msg.shotId);
        pushComponents(msg.projectId, store.get(msg.projectId)?.path);
        break;
      }

      case "components_sweep": {
        void runSweep(msg.projectId, msg.shots !== false);
        break;
      }

      /** The star comes off what has been looked at — one card, or the page. */
      case "component_seen": {
        if (components.see(msg.projectId, msg.componentId)) {
          pushComponents(msg.projectId, store.get(msg.projectId)?.path);
        }
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
        const unknown: never = msg;
        throw new Error(`unknown message type: ${JSON.stringify(unknown)}`);
      }
    }
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      // Anything that changes something needs the page's own origin (or
      // none) and the token. The one exception is the bridge call, whose
      // session id is its capability — harnesses curl it from shells with
      // no token in hand — but it still refuses a browser's Origin.
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      const bridgeCall = pathname.startsWith("/bridge/") && !pathname.startsWith("/bridge/preview/");
      if (!originAllowed(req.headers.origin, ctx.listeningPort, !options.staticDir)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!bridgeCall && !tokenMatches(presentedToken(req), options.token)) {
        res.writeHead(401);
        res.end();
        return;
      }
    }
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      // the pid is how the next launch tells a ruri that outlived its app
      // from some other program on the port — see server/port.ts
      res.end(JSON.stringify({ ok: true, service: "ruri", pid: process.pid }));
      return;
    }
    if (req.url === "/music/playlists") {
      res.writeHead(200, { ...MUSIC_CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ playlists: scanMusic(ctx.musicRoot()) }));
      return;
    }
    if (req.url?.startsWith("/music/track?")) {
      serveTrack(req, res, ctx.musicRoot());
      return;
    }
    if (req.url?.startsWith("/uploads/")) {
      serveUpload(req, res);
      return;
    }
    if (req.url?.startsWith("/bridge/preview/")) {
      serveBridgePreview(req, res);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/bridge/")) {
      void serveBridgeCall(req, res);
      return;
    }
    if (req.url?.startsWith("/readfile?")) {
      ctx.readable.serveReadFile(req, res);
      return;
    }
    if (options.staticDir && (req.method === "GET" || req.method === "HEAD")) {
      serveStatic(options.staticDir, req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

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
            crewManager.disposeAll();
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
