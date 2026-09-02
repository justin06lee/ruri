import { randomUUID } from "node:crypto";
import { type AskQuestions, DEFAULT_MODEL } from "../shared/protocol.js";
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
  ModelChoice,
  NamedComponent,
  PermissionRequest,
  QueuedPrompt,
  ServerMessage,
  TranscriptEvent,
  UsageLimits,
} from "../shared/protocol.js";
import { SessionArchive } from "./archive.js";
import { buildCompaction, refreshArchivedTurnFiles, removeTurnFiles } from "./compaction.js";
import { DraftStore } from "./drafts.js";
import { HomeLog } from "./homelog.js";
import { HOME_ID, homeProject, managerExtras, type ManagerHost } from "./manager.js";
import { defaultMusicDir, isAllowed, MIME as AUDIO_MIME, scan as scanMusic } from "./music.js";
import { PrefStore } from "./prefs.js";
import { ProjectStore } from "./projects.js";
import { cleanClaudeModels, ProviderRegistry } from "./providers.js";
import { promptChain, SessionManager } from "./sessions.js";
import { extractTrackerItems, sessionRoleTitle, setSmallModel, smallModelEnabled, splitPrompt, summarizePrompt, summarizeReply, TurnTracker, updateBrief } from "./smallmodel.js";
import { BriefStore, writeCatchupFile } from "./brief.js";
import { buildCatchup } from "./catchup.js";
import { knownCommands, splitCommands } from "./commands.js";
import { findProjects, searchRoots } from "./finder.js";
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
  type BridgeHost,
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
import { sweepProject } from "./sweep.js";
import { withProjectRunning, type CaptureHost, type ShotTarget } from "./shots.js";
import { SecretStore } from "./secrets.js";
import { installSkill, readSkill, removeSkill, scanSkills, toggleSkill, updateSkills } from "./skills.js";
import { Terminals } from "./terminal.js";
import { TrackerStore } from "./tracker.js";
import { modelPayload, processAttachments, serveUpload, storeAttachments, storedFilePath, storeUpload } from "./uploads.js";
import { fetchAllUsageLimits, loadCachedLimits, readCodexCounts, saveCachedLimits } from "./usage.js";

export interface StartServerOptions {
  port: number;
  host?: string;
  /** When set, GET requests are served from this directory (the built web UI). */
  staticDir?: string;
  /**
   * Host-provided native folder picker (the Electron shell passes one).
   * Resolves to the chosen directory, or null if the user cancelled.
   */
  pickFolder?: () => Promise<string | null>;
  /**
   * Host-provided element screenshots (the Electron shell passes one): load
   * a URL in a window nobody sees and photograph the elements named by
   * selector. Absent when ruri runs headless, and then the component sweep
   * names without taking pictures. See server/shots.ts.
   */
  capture?: CaptureHost;
  /**
   * Host-provided bridge (the Electron shell passes one): the hidden
   * windows and launched apps a session drives to see what it built.
   * Absent when ruri runs headless, and then the bridge tools say so.
   * See server/bridge.ts.
   */
  bridge?: BridgeHost;
}

export interface RuriServer {
  port: number;
  close(): Promise<void>;
}

/** A usage read that comes back empty is retried on this backoff — quick at
 *  first, since the usual causes clear in seconds, then easing off. */
const USAGE_RETRY_MIN_MS = 5_000;
const USAGE_RETRY_MAX_MS = 120_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

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
  } catch {
    res.writeHead(404, MUSIC_CORS);
    res.end();
    return;
  }

  const type = AUDIO_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
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

/**
 * Images a Read tool event pointed at, and so the only local paths the
 * transcript may ask for. The agent can read anything, but the HTTP server
 * hands back nothing that a recorded tool event did not already name.
 */
const readable = new Set<string>();

/** Register a whole snapshot's worth of transcripts, then hand them back. */
function allowArchived(
  transcripts: Record<string, TranscriptEvent[]>,
): Record<string, TranscriptEvent[]> {
  for (const events of Object.values(transcripts)) allowReadImages(events);
  return transcripts;
}

/** Register any image paths carried by these events (fresh or archived). */
function allowReadImages(events: TranscriptEvent[]): void {
  for (const event of events) {
    if (event.kind !== "tool" || !event.image) continue;
    const p = new URL(event.image.url, "http://localhost").searchParams.get("p");
    if (p) readable.add(p);
  }
}

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

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

/** Serve one image a tool event read. Anything unregistered is a 403. */
function serveReadFile(req: http.IncomingMessage, res: http.ServerResponse): void {
  const filePath = new URL(req.url ?? "/", "http://localhost").searchParams.get("p") ?? "";
  if (!filePath || !readable.has(filePath)) {
    res.writeHead(403);
    res.end();
    return;
  }
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": IMAGE_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "content-length": stat.size,
      // the file can be overwritten in place between reads
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
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
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
}

export function startServer(options: StartServerOptions): Promise<RuriServer> {
  const store = new ProjectStore();
  setSmallModel(store.smallModel());
  const archive = new SessionArchive();
  // Home is ephemeral — it exists to open projects, not to accumulate
  // context. Every launch starts it blank (no transcript, no resume).
  archive.remove(HOME_ID);
  removeTurnFiles(HOME_ID);
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
  // the vault, pushed into ruri's own environment so every harness ruri
  // spawns inherits $RURI_SECRET_* without being told anything
  const secrets = new SecretStore();
  // The window's own preferences, kept on this machine rather than in the
  // window — see server/prefs.ts for why that is not where they belong.
  const prefs = new PrefStore();
  secrets.applyEnv();
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
      refreshArchivedTurnFiles(session.id, archive.events(session.id));
    }
  }
  // half-written prompts, per channel — outliving both the wiped Home
  // archive above and any rewind that truncates a session's
  const drafts = new DraftStore();
  const clients = new Set<WebSocket>();
  const permissions = new Map<string, PermissionRequest>();

  const musicRoot = () => store.customMusicDir() ?? defaultMusicDir();

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  /** The port this server actually listens on, known once it does. A
   *  session's bridge endpoint is written with it, and sessions are made
   *  long after. */
  let listeningPort = options.port;

  // what the bridge is showing for a channel, as it changes — the strip
  // beside that channel's composer follows it
  options.bridge?.onState((channelId, state) => broadcast({ type: "bridge", projectId: channelId, state }));

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
    } catch {
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
      reply(400, { ok: false, error: `bad request: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
    if (!body || typeof body.tool !== "string") {
      reply(400, { ok: false, error: 'send {"tool": "<name>", "args": {...}}' });
      return;
    }
    const owner = ownerProject(id);
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

  // The model picker: Claude models plus every installed non-Claude harness,
  // probed at startup so the list is full before any session has run, and
  // re-probed on demand (opening Settings asks) so it tracks what the
  // harnesses actually serve. A live session's own report replaces the
  // probed Claude list when it lands, so a refresh never clobbers it.
  let registry = new ProviderRegistry();
  let claudeModels: ModelChoice[] = [];
  /** Names worked out from the startup catalog, which is the only source that
   *  says which version a family is on. A live session reports ids and bare
   *  display names, so it borrows from here rather than undoing them. */
  const claudeNames = new Map<string, string>();
  let providerModels: ModelChoice[] = [];
  const allModels = () => [...claudeModels, ...providerModels];
  let probing = false;
  let probedAt = 0;
  function probeModels(redetect = false) {
    if (probing) return;
    probing = true;
    probedAt = Date.now();
    // a fresh registry also picks up harnesses installed since launch
    if (redetect) registry = new ProviderRegistry();
    void registry
      .modelChoices()
      .then(({ claude, harnesses }) => {
        for (const m of claude) claudeNames.set(m.value, m.displayName);
        if (claudeModels.length === 0 && claude.length > 0) claudeModels = claude;
        providerModels = harnesses;
        if (allModels().length > 0) broadcast({ type: "models", models: allModels() });
      })
      .finally(() => {
        probing = false;
      });
  }
  probeModels();

  // The usage gauges: each harness's own limit windows (5h / weekly), read
  // on a slow poll and nudged after every turn, keyed by provider id so the
  // dragons show the account the active session spends from; and per-channel
  // context occupancy, reported by the live sessions.
  // The last run's reading opens the gauges on numbers instead of dashes;
  // the first fetch of this run replaces it moments later.
  let usageLimits: Record<string, UsageLimits> = loadCachedLimits();
  let lastUsageFetch = 0;
  /** How long to wait before trying again after a read comes back empty. */
  let usageRetryIn = USAGE_RETRY_MIN_MS;
  let usageRetry: NodeJS.Timeout | undefined;
  function pushUsage(force = false): void {
    if (!force && Date.now() - lastUsageFetch < 60_000) return;
    lastUsageFetch = Date.now();
    void fetchAllUsageLimits().then((limits) => {
      if (Object.keys(limits).length === 0) {
        // Nothing came back: the sign-in token is mid-refresh, the network
        // isn't up yet, the endpoint is having a moment. Any of those clear
        // in seconds, so try again on a short backoff rather than leaving
        // the gauges blank until the next five-minute tick.
        if (usageRetry) return;
        usageRetry = setTimeout(() => {
          usageRetry = undefined;
          usageRetryIn = Math.min(usageRetryIn * 2, USAGE_RETRY_MAX_MS);
          pushUsage(true);
        }, usageRetryIn);
        return;
      }
      usageRetryIn = USAGE_RETRY_MIN_MS;
      usageLimits = limits;
      saveCachedLimits(limits);
      broadcast({ type: "usage", limits });
    });
  }
  pushUsage(true);
  const contexts = new Map<string, ContextUsage>();

  // The composer's terminal mode: a row of shell tabs per channel, each in
  // that project's directory, alive for as long as the app is — switching
  // away and back attaches to the same shells, scrollback and all.
  const terminals = new Terminals({
    onData: (projectId, termId, data) =>
      broadcast({ type: "terminal_data", projectId, termId, data }),
    onExit: (projectId, termId, note) =>
      broadcast({ type: "terminal_exit", projectId, termId, note }),
  });
  /** Where a channel's shell should start: its project, or the workspace. */
  /** Where a channel's shells start: its project's directory.
   *
   *  A channel is a SESSION id, not a project id — this looked one up in the
   *  project list, matched nothing, and fell back to the workspace root, so
   *  every project's shell opened in the same place. Home is the exception
   *  and genuinely belongs at the root: it manages the workspace itself. */
  function terminalCwd(channelId: string): string {
    if (channelId === HOME_ID) return store.workspaceDir();
    return ownerProject(channelId)?.path ?? store.workspaceDir();
  }

  /**
   * Re-announce every channel's context occupancy.
   *
   * The limit windows already re-push on a timer and after every turn, so a
   * client that missed their snapshot value heals within minutes. Context
   * had no such path — it was only ever announced mid-turn, so a client that
   * missed the snapshot would sit on a stale zero forever while the gauges
   * either side of it stayed correct. Now it heals the same way.
   */
  function pushContexts(): void {
    for (const [channelId, context] of contexts) {
      broadcast({ type: "context", projectId: channelId, context });
    }
  }

  const usageTimer = setInterval(() => {
    pushUsage(true);
    pushContexts();
  }, 5 * 60_000);
  /**
   * The context window a channel's model gets. A harness that names its own
   * (Codex reports the model's real size) wins — but only for the model that
   * named it; otherwise it is Claude's two sizes, 1M with the [1m] flag.
   */
  function contextWindow(channelId: string): number {
    const model = channelProject(channelId)?.model || DEFAULT_MODEL;
    const reported = archive.contextWindowOf(channelId, model);
    if (reported) return reported;
    return model.includes("[1m]") ? 1_000_000 : 200_000;
  }

  /**
   * Re-announce one channel's occupancy against the window it has now.
   *
   * Switching a project's model changes the denominator without spending a
   * token, so nothing would otherwise re-measure until the next turn — the
   * gauge would keep reading a 393k session as full because the model it was
   * measured against is gone.
   */
  function republishContext(channelId: string): void {
    const tokens = contexts.get(channelId)?.tokens ?? archive.contextTokens(channelId);
    if (tokens === undefined) return;
    const context: ContextUsage = { tokens, window: contextWindow(channelId) };
    contexts.set(channelId, context);
    broadcast({ type: "context", projectId: channelId, context });
  }

  // A "channel" id is HOME_ID or a session id; sessions run with their
  // parent project's cwd/model/permission mode but keep their own state.
  function channelProject(channelId: string) {
    if (channelId === HOME_ID) return homeProject(store.workspaceDir(), store.homeSettings());
    const found = store.findSession(channelId);
    if (!found) return undefined;
    return { ...found.project, id: channelId };
  }

  /** The project a channel belongs to — boards are keyed by that, not by
   *  the session that happened to be open. */
  function ownerProject(channelId: string) {
    return store.findSession(channelId)?.project;
  }

  /**
   * Components the model has just built, waiting to be named. The card rides
   * the permission channel (it already survives reconnects) and resolves the
   * tool call that raised it, so the model learns the name the user chose.
   */
  const pendingComponents = new Map<
    string,
    { channelId: string; proposal: ComponentProposal; resolve(name: string | null): void }
  >();

  const componentHost: ComponentHost = {
    list: (channelId) => {
      const owner = ownerProject(channelId);
      return owner ? components.items(owner.id) : [];
    },
    propose: (channelId, proposal) =>
      new Promise<string | null>((resolve) => {
        const owner = ownerProject(channelId);
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
        const requestId = randomUUID();
        pendingComponents.set(requestId, { channelId, proposal: shown, resolve });
        const request: PermissionRequest = {
          requestId,
          projectId: channelId,
          toolName: "name_component",
          kind: "component",
          input: shown,
          ts: Date.now(),
        };
        permissions.set(requestId, request);
        broadcast({ type: "permission_request", request });
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
    } catch {
      return undefined;
    }
  }

  /** Push a project's component index to disk and to every client. */
  function pushComponents(projectId: string, projectDir?: string): void {
    const items = components.items(projectId);
    if (projectDir) writeIndexFile(projectDir, items);
    broadcast({ type: "components", projectId, items });
  }

  /* ── the repo sweep ───────────────────────────────────────────────── */

  /** Projects mid-sweep. One at a time each: the picture pass starts the
   *  project's dev server, and two of those fight over its port. */
  const sweeping = new Set<string>();

  function sweepNote(projectId: string, note: string, busy = true): void {
    broadcast({ type: "sweep", projectId, busy, ...(note ? { note } : {}) });
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
    if (!project || sweeping.has(projectId)) return;
    sweeping.add(projectId);
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
    } catch {
      sweepNote(projectId, "the sweep didn't finish — try it again", false);
    } finally {
      sweeping.delete(projectId);
    }
  }

  /** Re-scan skills for a project (or just the global ones) and push. */
  function pushSkills(projectId?: string, note?: string): void {
    const dir = projectId ? store.get(projectId)?.path : undefined;
    broadcast({
      type: "skills",
      ...(projectId ? { projectId } : {}),
      skills: scanSkills(dir),
      ...(note ? { note } : {}),
    });
  }

  // The app-side prompt queue: everything waiting for the running turn to
  // finish. Visible entries are user prompts sent while busy (shown and
  // editable in the UI); silent entries are split sub-prompts riding under
  // the original prompt the user already sees.
  interface QueueEntry {
    id: string;
    text: string;
    uploads: AttachmentUpload[];
    silent: boolean;
    /** Stored attachment meta, for displaying visible entries. */
    attachments?: Attachment[];
    /** A scissors send waiting its turn: split when it reaches the front,
     *  not before, so the commands queued ahead of it have already run. */
    split?: boolean;
  }
  const sendQueues = new Map<string, QueueEntry[]>();
  // Bumped on interrupt so an in-flight split resolution knows to stand down.
  const interruptEpochs = new Map<string, number>();

  function visibleQueue(channelId: string): QueuedPrompt[] {
    return (sendQueues.get(channelId) ?? [])
      .filter((entry) => !entry.silent)
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
      }));
  }

  function broadcastQueue(channelId: string): void {
    broadcast({ type: "queued", projectId: channelId, items: visibleQueue(channelId) });
  }

  /** A turn is running (or blocked on permission), or prompts are queued. */
  function busy(channelId: string): boolean {
    const status = manager.statuses()[channelId];
    return (
      status === "working" ||
      status === "permission" ||
      (sendQueues.get(channelId)?.length ?? 0) > 0
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
        broadcast({ type: "projects", projects: store.list() });
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
    const project = channelProject(channelId);
    if (!project) throw new Error("unknown session");
    titleSession(channelId, text);
    // a prompt that names something in the component index takes that
    // entry down with it — the model's copy only, never the transcript's
    const owner = ownerProject(channelId);
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
      manager.send(project, brief + payload.text + named, payload.images, undefined, true);
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
    manager.send(project, brief + processed.text + named, processed.images, undefined, true);
  }

  /**
   * The scissors send: one visible prompt, split by the small model into
   * its separate requests and fed to the harness one turn at a time.
   */
  function dispatchSplit(channelId: string, text: string, uploads: AttachmentUpload[]): void {
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
    broadcast({ type: "status", projectId: channelId, status: "working" });
    titleSession(channelId, text);
    const epoch = interruptEpochs.get(channelId) ?? 0;
    void (smallModelEnabled() ? splitPrompt(text).catch(() => [text]) : Promise.resolve([text])).then(
      (prompts) => {
        if ((interruptEpochs.get(channelId) ?? 0) !== epoch) return; // stopped meanwhile
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
        const idle = !busy(channelId);
        const first = idle ? entries.shift() : undefined;
        if (entries.length > 0) {
          const queue = sendQueues.get(channelId) ?? [];
          queue.push(...entries);
          sendQueues.set(channelId, queue);
        }
        if (first) dispatch(channelId, first.text, first.uploads, true);
      },
    );
  }

  /** Send the next queued prompt, once the channel settles. */
  function drainQueue(channelId: string): void {
    const queue = sendQueues.get(channelId);
    const next = queue?.shift();
    if (!next) return;
    if (queue!.length === 0) sendQueues.delete(channelId);
    if (!next.silent) broadcastQueue(channelId);
    // after the session settles its result (it flips to idle right after
    // emitting it) — so the queued turn's "working" sticks
    queueMicrotask(() => {
      try {
        if (next.split) dispatchSplit(channelId, next.text, next.uploads);
        else dispatch(channelId, next.text, next.uploads, next.silent);
      } catch {
        // the channel vanished mid-queue; drop the prompt
      }
    });
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
  ): boolean {
    const { commands, rest } = splitCommands(text, knownCommands(ownerProject(channelId)?.path));
    if (commands.length === 0) return false;
    const wasBusy = busy(channelId);
    const queue = sendQueues.get(channelId) ?? [];
    for (const command of commands) {
      queue.push({ id: randomUUID(), text: command, uploads: [], silent: false });
    }
    if (rest || uploads.length > 0) {
      queue.push({
        id: randomUUID(),
        text: rest,
        uploads,
        silent: false,
        ...(split ? { split: true } : {}),
        ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
      });
    }
    sendQueues.set(channelId, queue);
    broadcastQueue(channelId);
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
    const built = buildCompaction(channelId, archive.events(channelId), archive.summaries(channelId));
    if (built === null) {
      const event: TranscriptEvent = {
        kind: "info",
        id: randomUUID(),
        text: "nothing to compact yet",
        ts: Date.now(),
      };
      archive.append(channelId, event);
      broadcast({ type: "event", projectId: channelId, event });
      drainQueue(channelId);
      return;
    }
    manager.dispose(channelId);
    archive.clearLastSessionId(channelId);
    archive.setPendingBrief(channelId, built.brief);
    contexts.delete(channelId);
    archive.setContextTokens(channelId, 0);
    broadcast({
      type: "context",
      projectId: channelId,
      context: { tokens: 0, window: contextWindow(channelId) },
    });
    const event: TranscriptEvent = {
      kind: "compaction",
      id: randomUUID(),
      text: built.brief,
      entries: built.entries,
      ts: Date.now(),
    };
    archive.append(channelId, event);
    broadcast({ type: "event", projectId: channelId, event });
    drainQueue(channelId);
  }

  /**
   * Rewind a session running on a non-Claude harness.
   *
   * Those harnesses keep no file checkpoints and cannot fork a conversation
   * at a message, so this rewinds what ruri owns and is honest about the
   * rest: the transcript truncates, the live session is retired, and the
   * next prompt re-seeds a fresh one with a brief of everything kept — so
   * what the model knows matches what is on screen. The files are left
   * exactly as the discarded turns left them.
   */
  function rewindOnHarness(
    ws: WebSocket,
    channelId: string,
    target: Extract<TranscriptEvent, { kind: "user" }>,
    why = "this harness keeps no file checkpoints, so the files were left as they are, and it restarts from a brief of what's kept",
  ): void {
    const eventId = target.id;
    manager.dispose(channelId);
    archive.clearLastSessionId(channelId);
    const removed = archive.truncateFrom(channelId, eventId);
    if (removed.length > 0) {
      broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
      if (tracker.removeForTurns(channelId, removed)) {
        broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
      }
    }
    // the brief covers what survived the truncation — the harness comes back
    // knowing that and nothing after it
    const kept = buildCompaction(channelId, archive.events(channelId), archive.summaries(channelId));
    // nothing survived: the next prompt opens a genuinely new session, so
    // any brief left from before must not ride along
    archive.setPendingBrief(channelId, kept?.brief ?? "");
    contexts.delete(channelId);
    archive.setContextTokens(channelId, 0);
    broadcast({
      type: "context",
      projectId: channelId,
      context: { tokens: 0, window: contextWindow(channelId) },
    });
    broadcast({ type: "status", projectId: channelId, status: "idle" });
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(composeBack(channelId, target)));
    ws.send(
      JSON.stringify({
        type: "error",
        message: `rewound the conversation — ${why}`,
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

  /** Store one half of a turn's recall note and push the fold note it makes. */
  function noteSummary(projectId: string, turnId: string, part: "user" | "reply", note: string): void {
    archive.setSummary(projectId, turnId, part, note);
    broadcast({ type: "turn_summary", projectId, turnId, summary: archive.summaryDisplay(projectId, turnId) });
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

  /** Projects whose repo is being read for their brief right now. */
  const catchingUp = new Set<string>();

  function catchupNote(projectId: string, busy: boolean, note?: string): void {
    broadcast({
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
    if (!project || catchingUp.has(projectId) || !smallModelEnabled()) return;
    catchingUp.add(projectId);
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
    } catch {
      catchupNote(projectId, false, "the brief could not be written — try again");
    } finally {
      catchingUp.delete(projectId);
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

  const turns = new TurnTracker((projectId, turn) => {
    if (!smallModelEnabled()) return;
    const found = store.findSession(projectId);
    if (found && !found.session.title) {
      sessionRoleTitle(turn)
        .then((title) => {
          if (!title) return;
          store.setSessionTitle(projectId, title);
          broadcast({ type: "projects", projects: store.list() });
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

  /**
   * Archive, observe, log (Home), and broadcast one transcript event.
   *
   * Anything the model produced is redacted first: a command that echoed a
   * vault value leaves the handle behind rather than the value, on screen
   * and on disk both. The user's own prompts are left exactly as typed —
   * rewinding matches a prompt against what the CLI recorded, and rewriting
   * it here would break that for the sake of a value the user chose to type.
   */
  function recordEvent(projectId: string, raw: TranscriptEvent): void {
    const event =
      raw.kind === "assistant" || raw.kind === "info"
        ? { ...raw, text: secrets.redact(raw.text) }
        : raw.kind === "tool"
          ? { ...raw, summary: secrets.redact(raw.summary) }
          : raw;
    archive.append(projectId, event);
    turns.observe(projectId, event);
    if (projectId === HOME_ID) homeLog.observe(event);
    broadcast({ type: "event", projectId, event });
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
            broadcast({ type: "tracker", projectId, items: tracker.items(projectId) });
          })
          .catch(() => {});
      }
    }
  }

  const manager = new SessionManager(
    {
      onEvent: (projectId, event) => {
        allowReadImages([event]);
        recordEvent(projectId, event);
        if (event.kind === "result") {
          pushUsage();
          pushContexts();
          // the turn's spend lands in its project's ledger (Home in its own)
          const spender = projectId === HOME_ID ? HOME_ID : ownerProject(projectId)?.id;
          if (spender && (event.tokens || event.costUsd || event.durationMs)) {
            ledger.record(spender, {
              ...(event.tokens ? { tokens: event.tokens } : {}),
              ...(event.costUsd ? { costUsd: event.costUsd } : {}),
              ...(event.durationMs ? { ms: event.durationMs } : {}),
            });
            broadcast({ type: "stats", projectId: spender, stats: ledger.stats(spender) });
          }
          // a harness without ruri's tools names its components in a file
          const owner = ownerProject(projectId);
          if (owner) drainComponentRequests(owner.path, projectId, componentHost);
          drainQueue(projectId);
        }
      },
      onDelta: (projectId, messageId, delta) => broadcast({ type: "delta", projectId, messageId, delta }),
      onStatus: (projectId, status) => broadcast({ type: "status", projectId, status }),
      onPermission: (raw) => {
        // PreToolUse hooks run before the approval, so the input reaching
        // here may already hold a real vault value — the card shows handles
        const request: PermissionRequest = { ...raw, input: secrets.redactInput(raw.input) };
        permissions.set(request.requestId, request);
        broadcast({ type: "permission_request", request });
      },
      onPermissionResolved: (requestId) => {
        permissions.delete(requestId);
        broadcast({ type: "permission_resolved", requestId });
      },
      onQuestionLate: (requestId) => {
        const request = permissions.get(requestId);
        if (!request || request.late) return;
        const late = { ...request, late: true };
        permissions.set(requestId, late);
        broadcast({ type: "permission_request", request: late });
      },
      onModels: (list) => {
        const cleaned = cleanClaudeModels(
          list.map((m) => ({ id: m.value, display_name: m.displayName })),
          claudeNames,
        );
        if (cleaned.length === 0 || JSON.stringify(cleaned) === JSON.stringify(claudeModels)) return;
        claudeModels = cleaned;
        broadcast({ type: "models", models: allModels() });
      },
      onSessionId: (projectId, sessionId) => archive.setLastSessionId(projectId, sessionId),
      onContext: (projectId, tokens, window) => {
        // the window is recorded first: contextWindow() reads it back, so a
        // harness that names its own is answered with that same number — and
        // recorded against the model that named it, so it dies with it
        const model = channelProject(projectId)?.model || DEFAULT_MODEL;
        archive.setContextTokens(projectId, tokens, window, model);
        const context: ContextUsage = { tokens, window: contextWindow(projectId) };
        contexts.set(projectId, context);
        broadcast({ type: "context", projectId, context });
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
      const claude = !registry.parse(project.model || DEFAULT_MODEL).providerId;
      // the bridge reaches Claude as tools and everything else as one HTTP
      // endpoint on this server — whose port is only known once it listens,
      // which is long before any session is made
      const owner = ownerProject(project.id);
      const bridgeCtx = { channelId: project.id, projectId: owner?.id ?? project.id };
      const bridge = !options.bridge
        ? ""
        : claude
          ? bridgeToolBriefing()
          : bridgeHttpBriefing(`http://127.0.0.1:${listeningPort}/bridge/${project.id}`);
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
      parse: (model) => registry.parse(model),
      create: (id, workDir) => registry.createFor(id, workDir),
    },
    (projectId) => archive.takeResumeAt(projectId),
    (projectId) => archive.takeForkNext(projectId),
  );

  /** The session's window and apps go with it, and so do its pictures. */
  function closeBridge(sessionId: string): void {
    void options.bridge?.close(sessionId);
    try {
      fs.rmSync(bridgeDir(sessionId), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }

  /** Tear down one project and everything its sessions accumulated. */
  function closeProjectById(projectId: string): void {
    for (const sessionId of store.get(projectId)?.sessions.map((s) => s.id) ?? []) {
      manager.dispose(sessionId);
      archive.remove(sessionId);
      removeTurnFiles(sessionId);
      drafts.remove(sessionId);
      tracker.removeProject(sessionId);
      contexts.delete(sessionId);
      sendQueues.delete(sessionId);
      terminals.closeChannel(sessionId);
      closeBridge(sessionId);
    }
    briefs.remove(projectId);
    ideas.removeProject(projectId);
    components.removeProject(projectId);
    ledger.removeProject(projectId);
    store.remove(projectId);
    broadcast({ type: "projects", projects: store.list() });
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
          return `failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        broadcast({ type: "projects", projects: store.list() });
        // a project new to ruri gets told what it is before anyone asks
        if (briefless(project.id)) void rebuildCatchup(project.id);
      }
      let sessionId = project.sessions[0]?.id;
      // an emptied folder (all sessions closed) gets a fresh session on reopen
      if (!sessionId) {
        sessionId = store.newSession(project.id)?.id;
        broadcast({ type: "projects", projects: store.list() });
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
    closeProject: (query) => {
      const q = query.trim().replace(/\/+$/, "");
      const project = store
        .list()
        .find(
          (p) =>
            p.id === q ||
            p.path.replace(/\/+$/, "") === q ||
            p.name.toLowerCase() === q.toLowerCase(),
        );
      if (!project) return `no open project matches "${query}"`;
      closeProjectById(project.id);
      return `closed: ${project.name} (${project.path}) — files untouched`;
    },
    listProjects: () => store.list(),
    findProjects: (query) => findProjects(searchRoots(store.workspaceDir()), query),
  };

  function handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case "add_project": {
        const project = store.add(msg.name, msg.path, msg.folder);
        broadcast({ type: "projects", projects: store.list() });
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
      case "remove_project": {
        closeProjectById(msg.projectId);
        break;
      }
      case "send": {
        if (msg.text.trim().length === 0 && !msg.attachments?.length) return;
        const channelId = msg.projectId;
        const uploads = msg.attachments ?? [];
        if (queueWithCommands(channelId, msg.text, uploads, false)) break;
        if (busy(channelId)) {
          // hold it app-side — nothing reaches the harness until the
          // running turn (and everything queued before it) finishes
          const queue = sendQueues.get(channelId) ?? [];
          queue.push({
            id: randomUUID(),
            text: msg.text,
            uploads,
            silent: false,
            ...(uploads.length ? { attachments: storeAttachments(uploads) } : {}),
          });
          sendQueues.set(channelId, queue);
          broadcastQueue(channelId);
          return;
        }
        dispatch(channelId, msg.text, uploads);
        break;
      }
      case "send_split": {
        if (msg.text.trim().length === 0) return;
        const channelId = msg.projectId;
        const uploads = msg.attachments ?? [];
        if (!channelProject(channelId)) throw new Error("unknown session");
        if (queueWithCommands(channelId, msg.text, uploads, true)) break;
        dispatchSplit(channelId, msg.text, uploads);
        break;
      }
      case "queue_remove": {
        const queue = sendQueues.get(msg.projectId);
        if (!queue) break;
        const kept = queue.filter((e) => e.id !== msg.itemId || e.silent);
        if (kept.length !== queue.length) {
          if (kept.length === 0) sendQueues.delete(msg.projectId);
          else sendQueues.set(msg.projectId, kept);
          broadcastQueue(msg.projectId);
        }
        break;
      }
      case "remove_event": {
        const removed = archive.removeTurn(msg.projectId, msg.eventId);
        if (removed.length > 0) {
          broadcast({ type: "events_removed", projectId: msg.projectId, eventIds: removed });
          // a removed turn takes its extracted checklist items with it
          if (tracker.removeForTurns(msg.projectId, removed)) {
            broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
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
            if (busy(channelId)) throw new Error("stop the running turn first");
            const events = archive.events(channelId);
            const idx = events.findIndex((e) => e.id === eventId);
            const target = idx >= 0 ? events[idx] : undefined;
            if (!target || target.kind !== "user") throw new Error("that prompt is gone");
            const project = channelProject(channelId);
            if (!project) throw new Error("unknown session");
            // A harness rewind owns none of the CLI's machinery — no
            // checkpoints to restore, no chain to fork at, and a compaction
            // boundary costs it nothing, since it starts fresh either way.
            if (registry.parse(project.model).providerId !== undefined) {
              rewindOnHarness(ws, channelId, target);
              return;
            }
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
              rewindOnHarness(
                ws,
                channelId,
                target,
                "the conversation was compacted after this prompt, so there are no file checkpoints left to restore: the files were left as they are, and the session restarts from a brief of what's kept",
              );
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
            const filesKept = result.canRewind
              ? undefined
              : (result.error ?? "the CLI couldn't restore the files");
            manager.dispose(channelId);
            if (resumeAt) archive.setResumeAt(channelId, resumeAt);
            else archive.clearLastSessionId(channelId);
            const removed = archive.truncateFrom(channelId, eventId);
            if (removed.length > 0) {
              broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
              // items are tied to the prompts they were split from — the
              // rewound prompt's items (and every discarded later prompt's)
              // go too; the edited prompt re-extracts fresh ones on send
              if (tracker.removeForTurns(channelId, removed)) {
                broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
              }
            }
            broadcast({ type: "status", projectId: channelId, status: "idle" });
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
                  message: `rewind failed: ${err instanceof Error ? err.message : String(err)}`,
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
        // point (a shared file up to it, then its own); on every other
        // harness — or when a compaction has since retired the session
        // that held it — the fork opens on a brief of what it holds, the
        // way a rewind does.
        const channelId = msg.projectId;
        void (async () => {
          try {
            const found = store.findSession(channelId);
            if (!found) throw new Error("only a project's session can be forked");
            const events = archive.events(channelId);
            const idx = events.findIndex((e) => e.id === msg.eventId);
            const target = idx >= 0 ? events[idx] : undefined;
            if (!target || target.kind !== "user") throw new Error("that prompt is gone");
            let end = idx + 1;
            while (end < events.length && events[end]!.kind !== "user" && events[end]!.kind !== "compaction") end++;
            const kept = events.slice(0, end);
            const next = events.slice(end).find((e) => e.kind === "user");
            const compactedSince = events.slice(end).some((e) => e.kind === "compaction");
            const project = found.project;
            const fresh = store.newSession(project.id);
            if (!fresh) throw new Error("unknown project");
            const title = found.session.title ? `${found.session.title} fork` : "fork";
            store.setSessionTitle(fresh.id, title);
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
            const claude = registry.parse(project.model).providerId === undefined;
            const sessionId = archive.lastSessionId(channelId);
            let forked = false;
            if (claude && sessionId && !compactedSince) {
              // the branch point: the last chain entry of this exchange. From
              // the chain map when a turn recorded it, else from the CLI's
              // own transcript as the entry before the next prompt — and a
              // fork at the latest exchange needs no point at all.
              let at = archive.chain(channelId)[target.id]?.last;
              if (!at && next) {
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
              const built = buildCompaction(fresh.id, kept, archive.summaries(fresh.id));
              if (built) archive.setPendingBrief(fresh.id, built.brief);
            }
            broadcast({ type: "projects", projects: store.list() });
            broadcast({
              type: "transcript",
              projectId: fresh.id,
              events: allowArchived({ [fresh.id]: archive.events(fresh.id) })[fresh.id] ?? [],
              summaries: archive.allSummaries([fresh.id])[fresh.id] ?? {},
            });
            const tokens = archive.contextTokens(fresh.id);
            if (tokens !== undefined) {
              broadcast({ type: "context", projectId: fresh.id, context: { tokens, window: contextWindow(fresh.id) } });
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "open_session", projectId: fresh.id } satisfies ServerMessage));
              if (!forked && claude) {
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
                  message: `fork failed: ${err instanceof Error ? err.message : String(err)}`,
                } satisfies ServerMessage),
              );
            }
          }
        })();
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
        const providerId = registry.parse(project.model).providerId;
        const sameHarness = imported.provider === "claude" ? providerId === undefined : providerId === imported.provider;
        if (sameHarness) archive.setLastSessionId(fresh.id, imported.resume);
        else {
          const built = buildCompaction(fresh.id, imported.events, {});
          if (built) archive.setPendingBrief(fresh.id, built.brief);
        }
        const firstPrompt = imported.events.find((e) => e.kind === "user");
        if (firstPrompt && firstPrompt.kind === "user") titleSession(fresh.id, firstPrompt.text);
        broadcast({ type: "projects", projects: store.list() });
        broadcast({
          type: "transcript",
          projectId: fresh.id,
          events: allowArchived({ [fresh.id]: archive.events(fresh.id) })[fresh.id] ?? [],
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
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "remove_session": {
        manager.dispose(msg.sessionId);
        archive.remove(msg.sessionId);
        removeTurnFiles(msg.sessionId);
        drafts.remove(msg.sessionId);
        tracker.removeProject(msg.sessionId);
        contexts.delete(msg.sessionId);
        closeBridge(msg.sessionId);
        store.removeSession(msg.sessionId);
        broadcast({ type: "projects", projects: store.list() });
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
        interruptEpochs.set(msg.projectId, (interruptEpochs.get(msg.projectId) ?? 0) + 1);
        if (sendQueues.delete(msg.projectId)) broadcastQueue(msg.projectId);
        manager.interrupt(msg.projectId);
        // settle the optimistic "working" a pending split may have shown
        broadcast({
          type: "status",
          projectId: msg.projectId,
          status: manager.statuses()[msg.projectId] ?? "idle",
        });
        break;
      }
      case "set_pref": {
        prefs.set(msg.key, msg.value);
        broadcast({ type: "prefs", prefs: prefs.all() });
        break;
      }
      case "terminal_list": {
        ws.send(JSON.stringify({
          type: "terminal_tabs",
          projectId: msg.projectId,
          tabs: terminals.list(msg.projectId),
        } satisfies ServerMessage));
        break;
      }
      case "terminal_new": {
        broadcast({
          type: "terminal_tabs",
          projectId: msg.projectId,
          tabs: terminals.add(msg.projectId),
        });
        break;
      }
      case "terminal_open": {
        const attaching = terminals.has(msg.termId);
        if (
          !terminals.open(
            msg.projectId,
            msg.termId,
            terminalCwd(msg.projectId),
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
            data: terminals.scrollback(msg.termId),
            replay: true,
          } satisfies ServerMessage));
        }
        break;
      }
      case "terminal_input": {
        terminals.write(msg.termId, msg.data);
        break;
      }
      case "terminal_resize": {
        terminals.resize(msg.termId, msg.cols, msg.rows);
        break;
      }
      case "terminal_close": {
        broadcast({
          type: "terminal_tabs",
          projectId: msg.projectId,
          tabs: terminals.close(msg.projectId, msg.termId),
        });
        break;
      }
      case "permission_response": {
        manager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
        break;
      }
      case "question_response": {
        // The card is answered. If the tool call behind it is still waiting,
        // the answers go into it; if it has moved on (the turn ended, or the
        // CLI gave up on the hook), they go out as a prompt of their own —
        // never into a hole.
        const request = permissions.get(msg.requestId);
        const outcome = manager.respondQuestion(msg.requestId, msg.answers);
        if (outcome === "answered") break;
        if (outcome === "none") {
          permissions.delete(msg.requestId);
          broadcast({ type: "permission_resolved", requestId: msg.requestId });
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
        const channelId = request.projectId;
        if (busy(channelId)) {
          const queue = sendQueues.get(channelId) ?? [];
          queue.push({ id: randomUUID(), text, uploads: [], silent: false });
          sendQueues.set(channelId, queue);
          broadcastQueue(channelId);
        } else {
          dispatch(channelId, text, []);
        }
        break;
      }
      case "set_model": {
        if (msg.projectId === HOME_ID) {
          store.setHomeSettings({ model: msg.model });
          manager.setModel(HOME_ID, msg.model);
          broadcast({ type: "home_settings", home: store.homeSettings() });
          republishContext(HOME_ID);
          break;
        }
        store.update(msg.projectId, { model: msg.model });
        // live sessions are keyed by session id, not project id
        for (const s of store.get(msg.projectId)?.sessions ?? []) manager.setModel(s.id, msg.model);
        broadcast({ type: "projects", projects: store.list() });
        // the new model may have a different window — remeasure against it
        for (const s of store.get(msg.projectId)?.sessions ?? []) republishContext(s.id);
        break;
      }
      case "set_permission_mode": {
        if (msg.projectId === HOME_ID) {
          store.setHomeSettings({ permissionMode: msg.mode });
          manager.setPermissionMode(HOME_ID, msg.mode);
          broadcast({ type: "home_settings", home: store.homeSettings() });
          break;
        }
        store.update(msg.projectId, { permissionMode: msg.mode });
        for (const s of store.get(msg.projectId)?.sessions ?? []) {
          manager.setPermissionMode(s.id, msg.mode);
        }
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "set_effort": {
        if (msg.projectId === HOME_ID) {
          if ((store.homeSettings().effort ?? "") === msg.effort) break;
          store.setHomeSettings({ effort: msg.effort });
          manager.setEffort(HOME_ID, msg.effort);
          broadcast({ type: "home_settings", home: store.homeSettings() });
          break;
        }
        if ((store.get(msg.projectId)?.effort ?? "") === msg.effort) break;
        store.update(msg.projectId, { effort: msg.effort });
        for (const s of store.get(msg.projectId)?.sessions ?? []) manager.setEffort(s.id, msg.effort);
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "tracker_add": {
        if (!msg.text.trim()) return;
        tracker.add(msg.projectId, msg.text.trim(), "manual", undefined, msg.note ?? "");
        broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        break;
      }
      case "tracker_update": {
        tracker.update(msg.projectId, msg.itemId, {
          ...(msg.status !== undefined ? { status: msg.status } : {}),
          ...(msg.note !== undefined ? { note: msg.note } : {}),
          ...(msg.text !== undefined ? { text: msg.text } : {}),
        });
        broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        break;
      }
      case "tracker_remove": {
        tracker.remove(msg.projectId, msg.itemId);
        broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        break;
      }
      /* ── the ideas board ──────────────────────────────────────── */
      case "idea_add": {
        const text = msg.text.trim();
        if (!text) break;
        ideas.add(msg.projectId, text);
        broadcast({ type: "ideas", projectId: msg.projectId, items: ideas.items(msg.projectId) });
        break;
      }
      case "idea_update": {
        ideas.update(msg.projectId, msg.ideaId, {
          ...(msg.text !== undefined ? { text: msg.text } : {}),
          ...(msg.done !== undefined ? { done: msg.done } : {}),
        });
        broadcast({ type: "ideas", projectId: msg.projectId, items: ideas.items(msg.projectId) });
        break;
      }
      case "idea_remove": {
        ideas.remove(msg.projectId, msg.ideaId);
        broadcast({ type: "ideas", projectId: msg.projectId, items: ideas.items(msg.projectId) });
        break;
      }

      /* ── the component index ──────────────────────────────────── */
      case "component_named": {
        const pending = pendingComponents.get(msg.requestId);
        if (!pending) break;
        pendingComponents.delete(msg.requestId);
        permissions.delete(msg.requestId);
        broadcast({ type: "permission_resolved", requestId: msg.requestId });
        const owner = ownerProject(pending.channelId);
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
        secrets.save1({
          ...(msg.id ? { id: msg.id } : {}),
          name: msg.name,
          ...(msg.username !== undefined ? { username: msg.username } : {}),
          ...(msg.note !== undefined ? { note: msg.note } : {}),
          ...(msg.secret !== undefined ? { secret: msg.secret } : {}),
        });
        secrets.applyEnv();
        broadcast({ type: "secrets", items: secrets.meta() });
        break;
      }
      case "secret_remove": {
        secrets.remove(msg.id);
        secrets.applyEnv();
        broadcast({ type: "secrets", items: secrets.meta() });
        break;
      }

      /* ── skills ───────────────────────────────────────────────── */
      case "skills_refresh": {
        pushSkills(msg.projectId);
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
        // bmo clones and copies — long enough that the page says so
        broadcast({
          type: "skills",
          ...(msg.projectId ? { projectId: msg.projectId } : {}),
          skills: scanSkills(dir),
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
          broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
        }
        break;
      }
      case "tracker_detach": {
        if (tracker.detach(msg.projectId, msg.itemId, msg.attachmentId)) {
          broadcast({ type: "tracker", projectId: msg.projectId, items: tracker.items(msg.projectId) });
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
        broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
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
          broadcast({ type: "projects", projects: store.list() });
        }
        break;
      }
      case "set_workspace": {
        store.setWorkspaceDir(msg.path);
        broadcast({ type: "workspace", path: store.workspaceDir() });
        break;
      }
      case "set_music_dir": {
        store.setMusicDir(msg.path);
        broadcast({ type: "music_dir", path: musicRoot() });
        break;
      }
      case "toggle_model_star": {
        const { starred, small } = store.cycleModelStar(msg.model);
        setSmallModel(small);
        broadcast({ type: "starred_models", models: starred });
        broadcast({ type: "small_model", model: small ?? "" });
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
        homeLog.endSession();
        sendQueues.delete(HOME_ID);
        contexts.delete(HOME_ID);
        broadcast({ type: "home_reset" });
        break;
      }
      case "refresh_models": {
        // Probing spawns a short-lived process per harness, so back-to-back
        // Settings opens within half a minute reuse the last answer.
        if (Date.now() - probedAt > 30_000) probeModels(true);
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
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "ruri" }));
      return;
    }
    if (req.url === "/music/playlists") {
      res.writeHead(200, { ...MUSIC_CORS, "content-type": "application/json" });
      res.end(JSON.stringify({ playlists: scanMusic(musicRoot()) }));
      return;
    }
    if (req.url?.startsWith("/music/track?")) {
      serveTrack(req, res, musicRoot());
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
      serveReadFile(req, res);
      return;
    }
    if (options.staticDir && (req.method === "GET" || req.method === "HEAD")) {
      serveStatic(options.staticDir, req, res);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws) => {
    clients.add(ws);
    const projectIds = [...store.sessionIds(), HOME_ID];
    // the boards are the one thing keyed by project rather than by session
    const boardIds = store.list().map((p) => p.id);
    const snapshot: ServerMessage = {
      type: "snapshot",
      projects: store.list(),
      transcripts: allowArchived(archive.transcripts(projectIds)),
      statuses: manager.statuses(),
      permissions: [...permissions.values()],
      models: allModels(),
      summaries: archive.allSummaries(projectIds),
      tracker: tracker.all(projectIds),
      ideas: ideas.all(boardIds),
      components: components.all(boardIds),
      secrets: secrets.meta(),
      queued: Object.fromEntries(projectIds.map((id) => [id, visibleQueue(id)])),
      usage: usageLimits,
      // live figures first; anything not yet seen this run falls back to the
      // last one the archive recorded, so a relaunch shows real occupancy
      contexts: Object.fromEntries(
        projectIds.flatMap((id) => {
          const live = contexts.get(id);
          if (live) return [[id, live] as const];
          const tokens = archive.contextTokens(id);
          return tokens === undefined ? [] : [[id, { tokens, window: contextWindow(id) }] as const];
        }),
      ),
      stats: ledger.all([...boardIds, HOME_ID]),
      catchups: Object.fromEntries(
        boardIds.map((id) => [id, briefs.get(id).built ? { built: briefs.get(id).built } : {}]),
      ),
      canPickFolder: options.pickFolder !== undefined,
      workspaceDir: store.workspaceDir(),
      musicDir: musicRoot(),
      home: store.homeSettings(),
      starredModels: store.starredModels(),
      smallModel: store.smallModel() ?? "",
      user: os.userInfo().username,
      prefs: prefs.all(),
      composerDrafts: drafts.all(),
      bridges: options.bridge?.states() ?? {},
    };
    ws.send(JSON.stringify(snapshot));

    ws.on("message", (raw) => {
      try {
        handleMessage(ws, JSON.parse(String(raw)) as ClientMessage);
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          } satisfies ServerMessage),
        );
      }
    });
    ws.on("close", () => clients.delete(ws));
  });

  return new Promise((resolve, reject) => {
    // The port is part of the app's identity, not an implementation detail:
    // the window is served from it, so a different port every launch means a
    // different origin every launch, and everything the window keeps for
    // itself (localStorage) starts empty. So the asked-for port is tried
    // first and only a port already in use falls back to an ephemeral one.
    let attempt = options.port;
    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE" && attempt !== 0) {
        attempt = 0;
        server.listen(0, options.host ?? "127.0.0.1");
        return;
      }
      reject(error);
    });
    server.listen(attempt, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      listeningPort = port;
      console.log(`ruri server listening on ws://127.0.0.1:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(usageTimer);
            if (usageRetry) clearTimeout(usageRetry);
            terminals.closeAll();
            void options.bridge?.closeAll();
            manager.disposeAll();
            archive.flushAll();
            ledger.flush();
            for (const client of clients) client.close();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
