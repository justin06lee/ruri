import { randomUUID } from "node:crypto";
import { DEFAULT_MODEL } from "../shared/protocol.js";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Attachment,
  AttachmentUpload,
  ClientMessage,
  ContextUsage,
  ModelChoice,
  PermissionRequest,
  QueuedPrompt,
  ServerMessage,
  TranscriptEvent,
  UsageLimits,
} from "../shared/protocol.js";
import { SessionArchive } from "./archive.js";
import { buildCompaction, removeTurnFiles } from "./compaction.js";
import { HomeLog } from "./homelog.js";
import { HOME_ID, homeProject, managerExtras, type ManagerHost } from "./manager.js";
import { defaultMusicDir, isAllowed, MIME as AUDIO_MIME, scan as scanMusic } from "./music.js";
import { ProjectStore } from "./projects.js";
import { cleanClaudeModels, ProviderRegistry } from "./providers.js";
import { SessionManager } from "./sessions.js";
import { extractTrackerItems, sessionRoleTitle, setSmallModel, smallModelEnabled, splitPrompt, summarizePrompt, summarizeReply, TurnTracker } from "./smallmodel.js";
import { TrackerStore } from "./tracker.js";
import { modelPayload, processAttachments, serveUpload, storeAttachments, storedFilePath, storeUpload } from "./uploads.js";
import { fetchUsageLimits } from "./usage.js";

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
}

export interface RuriServer {
  port: number;
  close(): Promise<void>;
}

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
  const clients = new Set<WebSocket>();
  const permissions = new Map<string, PermissionRequest>();

  const musicRoot = () => store.customMusicDir() ?? defaultMusicDir();

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  // The model picker: Claude models plus every installed non-Claude harness,
  // probed at startup so the list is full before any session has run, and
  // re-probed on demand (opening Settings asks) so it tracks what the
  // harnesses actually serve. A live session's own report replaces the
  // probed Claude list when it lands, so a refresh never clobbers it.
  let registry = new ProviderRegistry();
  let claudeModels: ModelChoice[] = [];
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
        if (claudeModels.length === 0 && claude.length > 0) claudeModels = claude;
        providerModels = harnesses;
        if (allModels().length > 0) broadcast({ type: "models", models: allModels() });
      })
      .finally(() => {
        probing = false;
      });
  }
  probeModels();

  // The usage gauges: account limit windows (5h / weekly), fetched from the
  // Claude usage endpoint on a slow poll and nudged after every turn; and
  // per-channel context occupancy, reported by the live sessions.
  let usageLimits: UsageLimits = {};
  let lastUsageFetch = 0;
  function pushUsage(force = false): void {
    if (!force && Date.now() - lastUsageFetch < 60_000) return;
    lastUsageFetch = Date.now();
    void fetchUsageLimits().then((limits) => {
      if (!limits) return;
      usageLimits = limits;
      broadcast({ type: "usage", limits });
    });
  }
  pushUsage(true);
  const contexts = new Map<string, ContextUsage>();

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
  /** The context window a channel's model gets (1M with the [1m] flag). */
  function contextWindow(channelId: string): number {
    const model = channelProject(channelId)?.model || DEFAULT_MODEL;
    return model.includes("[1m]") ? 1_000_000 : 200_000;
  }

  // A "channel" id is HOME_ID or a session id; sessions run with their
  // parent project's cwd/model/permission mode but keep their own state.
  function channelProject(channelId: string) {
    if (channelId === HOME_ID) return homeProject(store.workspaceDir(), store.homeSettings());
    const found = store.findSession(channelId);
    if (!found) return undefined;
    return { ...found.project, id: channelId };
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
    // the first prompt after a compaction carries the brief, invisibly
    const brief = archive.takePendingBrief(channelId) ?? "";
    if (silent) {
      // a split sub-prompt: files are already stored, no new user event
      const payload = modelPayload(text, uploads);
      manager.send(project, brief + payload.text, payload.images, undefined, true);
    } else if (brief) {
      // the brief is the model's memory, not the user's view: show the
      // plain prompt, send the briefed one silently underneath
      const processed = processAttachments(text, uploads);
      const userEvent: TranscriptEvent = {
        kind: "user",
        id: randomUUID(),
        text: processed.text,
        ...(processed.attachments.length ? { attachments: processed.attachments } : {}),
        ts: Date.now(),
      };
      recordEvent(channelId, userEvent);
      manager.send(project, brief + processed.text, processed.images, undefined, true);
    } else {
      const processed = processAttachments(text, uploads);
      manager.send(project, processed.text, processed.images, processed.attachments);
    }
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
        dispatch(channelId, next.text, next.uploads, next.silent);
      } catch {
        // the channel vanished mid-queue; drop the prompt
      }
    });
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

  /** Store one half of a turn's recall note and push the fold note it makes. */
  function noteSummary(projectId: string, turnId: string, part: "user" | "reply", note: string): void {
    archive.setSummary(projectId, turnId, part, note);
    broadcast({ type: "turn_summary", projectId, turnId, summary: archive.summaryDisplay(projectId, turnId) });
  }

  // Every finished turn goes to the small model in the background for a
  // reply recall note (instant compaction). Failures are silent — a nicety.
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
  });

  /** Archive, observe, log (Home), and broadcast one transcript event. */
  function recordEvent(projectId: string, event: TranscriptEvent): void {
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
          drainQueue(projectId);
        }
      },
      onDelta: (projectId, messageId, delta) => broadcast({ type: "delta", projectId, messageId, delta }),
      onStatus: (projectId, status) => broadcast({ type: "status", projectId, status }),
      onPermission: (request) => {
        permissions.set(request.requestId, request);
        broadcast({ type: "permission_request", request });
      },
      onPermissionResolved: (requestId) => {
        permissions.delete(requestId);
        broadcast({ type: "permission_resolved", requestId });
      },
      onModels: (list) => {
        const cleaned = cleanClaudeModels(list);
        if (cleaned.length === 0 || JSON.stringify(cleaned) === JSON.stringify(claudeModels)) return;
        claudeModels = cleaned;
        broadcast({ type: "models", models: allModels() });
      },
      onSessionId: (projectId, sessionId) => archive.setLastSessionId(projectId, sessionId),
      onContext: (projectId, tokens) => {
        const context: ContextUsage = { tokens, window: contextWindow(projectId) };
        contexts.set(projectId, context);
        archive.setContextTokens(projectId, tokens);
        broadcast({ type: "context", projectId, context });
      },
      onChain: (projectId, eventId, kind, uuid) => archive.setChain(projectId, eventId, kind, uuid),
    },
    (projectId) => archive.lastSessionId(projectId),
    (project) =>
      project.id === HOME_ID
        ? managerExtras(managerHost, store.workspaceDir(), homeLog.path())
        : undefined,
    {
      parse: (model) => registry.parse(model),
      create: (id, workDir) => registry.createFor(id, workDir),
    },
    (projectId) => archive.takeResumeAt(projectId),
  );

  /** Tear down one project and everything its sessions accumulated. */
  function closeProjectById(projectId: string): void {
    for (const sessionId of store.get(projectId)?.sessions.map((s) => s.id) ?? []) {
      manager.dispose(sessionId);
      archive.remove(sessionId);
      removeTurnFiles(sessionId);
      tracker.removeProject(sessionId);
      contexts.delete(sessionId);
      sendQueues.delete(sessionId);
    }
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
      }
      let sessionId = project.sessions[0]?.id;
      // an emptied folder (all sessions closed) gets a fresh session on reopen
      if (!sessionId) {
        sessionId = store.newSession(project.id)?.id;
        broadcast({ type: "projects", projects: store.list() });
      }
      if (kickoffPrompt && sessionId) manager.send({ ...project, id: sessionId }, kickoffPrompt);
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
  };

  function handleMessage(ws: WebSocket, msg: ClientMessage): void {
    switch (msg.type) {
      case "add_project": {
        store.add(msg.name, msg.path, msg.folder);
        broadcast({ type: "projects", projects: store.list() });
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
        // The user sees exactly one thing: their prompt, sent now. The
        // split and the turn-by-turn feed happen entirely out of sight.
        const attachments = storeAttachments(uploads);
        const userEvent: TranscriptEvent = {
          kind: "user",
          id: randomUUID(),
          text: msg.text,
          ...(attachments.length ? { attachments } : {}),
          ts: Date.now(),
        };
        recordEvent(channelId, userEvent);
        broadcast({ type: "status", projectId: channelId, status: "working" });
        titleSession(channelId, msg.text);
        const epoch = interruptEpochs.get(channelId) ?? 0;
        void (smallModelEnabled() ? splitPrompt(msg.text).catch(() => [msg.text]) : Promise.resolve([msg.text])).then(
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
        break;
      }
      case "queue_edit": {
        const entry = sendQueues
          .get(msg.projectId)
          ?.find((e) => e.id === msg.itemId && !e.silent);
        if (entry && msg.text.trim()) {
          entry.text = msg.text;
          broadcastQueue(msg.projectId);
        }
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
        // truncated (forked) at the kept turn's last chain entry. The
        // prompt itself lands back in the composer for editing.
        const channelId = msg.projectId;
        const eventId = msg.eventId;
        void (async () => {
          try {
            if (busy(channelId)) throw new Error("stop the running turn first");
            const events = archive.events(channelId);
            const idx = events.findIndex((e) => e.id === eventId);
            const target = idx >= 0 ? events[idx] : undefined;
            if (!target || target.kind !== "user") throw new Error("that prompt is gone");
            const chain = archive.chain(channelId);
            const userUuid = chain[eventId]?.user;
            if (!userUuid) throw new Error("no checkpoint recorded for that prompt");
            // the fork point: the latest checkpointed turn before the target
            // (a compaction boundary means a different session — no crossing)
            let resumeAt: string | undefined;
            for (let i = idx - 1; i >= 0; i--) {
              const ev = events[i]!;
              if (ev.kind === "compaction") throw new Error("can't rewind across a compaction");
              if (ev.kind === "user" && chain[ev.id]?.last) {
                resumeAt = chain[ev.id]!.last;
                break;
              }
            }
            if (events.some((e, i) => i > idx && e.kind === "compaction")) {
              throw new Error("can't rewind across a compaction");
            }
            const project = channelProject(channelId);
            if (!project) throw new Error("unknown session");
            const result = await manager.rewindFiles(project, userUuid);
            if (!result.canRewind) throw new Error(result.error ?? "the CLI couldn't restore the files");
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
            const edited = msg.text?.trim();
            if (edited) {
              // the edited prompt goes straight out as the next turn
              dispatch(channelId, edited, []);
            } else if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "compose",
                  projectId: channelId,
                  text: target.text,
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
      case "new_session": {
        store.newSession(msg.projectId);
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "remove_session": {
        manager.dispose(msg.sessionId);
        archive.remove(msg.sessionId);
        removeTurnFiles(msg.sessionId);
        tracker.removeProject(msg.sessionId);
        contexts.delete(msg.sessionId);
        store.removeSession(msg.sessionId);
        broadcast({ type: "projects", projects: store.list() });
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
      case "permission_response": {
        manager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
        break;
      }
      case "question_response": {
        manager.respondQuestion(msg.requestId, msg.answers);
        break;
      }
      case "set_model": {
        if (msg.projectId === HOME_ID) {
          store.setHomeSettings({ model: msg.model });
          manager.setModel(HOME_ID, msg.model);
          broadcast({ type: "home_settings", home: store.homeSettings() });
          break;
        }
        store.update(msg.projectId, { model: msg.model });
        // live sessions are keyed by session id, not project id
        for (const s of store.get(msg.projectId)?.sessions ?? []) manager.setModel(s.id, msg.model);
        broadcast({ type: "projects", projects: store.list() });
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
    const snapshot: ServerMessage = {
      type: "snapshot",
      projects: store.list(),
      transcripts: allowArchived(archive.transcripts(projectIds)),
      statuses: manager.statuses(),
      permissions: [...permissions.values()],
      models: allModels(),
      summaries: archive.allSummaries(projectIds),
      tracker: tracker.all(projectIds),
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
      canPickFolder: options.pickFolder !== undefined,
      workspaceDir: store.workspaceDir(),
      musicDir: musicRoot(),
      home: store.homeSettings(),
      starredModels: store.starredModels(),
      smallModel: store.smallModel() ?? "",
      user: os.userInfo().username,
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
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      console.log(`ruri server listening on ws://127.0.0.1:${port}`);
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(usageTimer);
            manager.disposeAll();
            archive.flushAll();
            for (const client of clients) client.close();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
