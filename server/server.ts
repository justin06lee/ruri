import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type {
  Attachment,
  AttachmentUpload,
  ClientMessage,
  ModelChoice,
  PermissionRequest,
  QueuedPrompt,
  ServerMessage,
  TranscriptEvent,
} from "../shared/protocol.js";
import { SessionArchive } from "./archive.js";
import { HOME_ID, homeProject, managerExtras, type ManagerHost } from "./manager.js";
import { defaultMusicDir, isAllowed, MIME as AUDIO_MIME, scan as scanMusic } from "./music.js";
import { ProjectStore } from "./projects.js";
import { cleanClaudeModels, ProviderRegistry } from "./providers.js";
import { SessionManager } from "./sessions.js";
import { extractTrackerItems, reviewPrompt, sessionRoleTitle, setSmallModel, smallModelEnabled, splitPrompt, summarizeTurn, TurnTracker } from "./smallmodel.js";
import { TrackerStore } from "./tracker.js";
import { modelPayload, processAttachments, serveUpload, storeAttachments } from "./uploads.js";

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
    const project = channelProject(channelId);
    if (!project) throw new Error("unknown session");
    titleSession(channelId, text);
    if (silent) {
      // a split sub-prompt: files are already stored, no new user event
      const payload = modelPayload(text, uploads);
      manager.send(project, payload.text, payload.images, undefined, true);
    } else {
      const processed = processAttachments(text, uploads);
      manager.send(project, processed.text, processed.images, processed.attachments);
    }
  }

  // Every finished turn goes to the small model in the background, twice:
  // a recall note (instant compaction) and a tracker extraction (new features
  // the user should test by hand). Failures are silent — both are niceties.
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
    summarizeTurn(turn)
      .then((summary) => {
        if (!summary) return;
        archive.setSummary(projectId, turn.turnId, summary);
        broadcast({ type: "turn_summary", projectId, turnId: turn.turnId, summary });
      })
      .catch(() => {});
    extractTrackerItems(turn, tracker.openTexts(projectId))
      .then((items) => {
        if (items.length === 0) return;
        for (const text of items) tracker.add(projectId, text, "auto", turn.turnId);
        broadcast({ type: "tracker", projectId, items: tracker.items(projectId) });
      })
      .catch(() => {});
  });

  const manager = new SessionManager(
    {
      onEvent: (projectId, event) => {
        archive.append(projectId, event);
        turns.observe(projectId, event);
        broadcast({ type: "event", projectId, event });
        if (event.kind === "result") {
          const queue = sendQueues.get(projectId);
          const next = queue?.shift();
          if (next) {
            if (queue!.length === 0) sendQueues.delete(projectId);
            if (!next.silent) broadcastQueue(projectId);
            // after the session settles this result (it flips to idle right
            // after emitting it) — so the queued turn's "working" sticks
            queueMicrotask(() => {
              try {
                dispatch(projectId, next.text, next.uploads, next.silent);
              } catch {
                // the channel vanished mid-queue; drop the prompt
              }
            });
          }
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
    },
    (projectId) => archive.lastSessionId(projectId),
    (project) =>
      project.id === HOME_ID ? managerExtras(managerHost, store.workspaceDir()) : undefined,
    {
      parse: (model) => registry.parse(model),
      create: (id, workDir) => registry.createFor(id, workDir),
    },
  );

  // What the Home agent's MCP tools may do to the app: open projects (and
  // optionally kick their sessions off), and see what's already open.
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
      const sessionId = project.sessions[0]?.id;
      if (kickoffPrompt && sessionId) manager.send({ ...project, id: sessionId }, kickoffPrompt);
      return `${opened ? "opened" : "already open"}: ${project.name} (${project.path})${
        kickoffPrompt ? " — session started with the kickoff prompt" : ""
      }`;
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
        for (const sessionId of store.get(msg.projectId)?.sessions.map((s) => s.id) ?? []) {
          manager.dispose(sessionId);
          archive.remove(sessionId);
          tracker.removeProject(sessionId);
        }
        store.remove(msg.projectId);
        broadcast({ type: "projects", projects: store.list() });
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
        archive.append(channelId, userEvent);
        turns.observe(channelId, userEvent);
        broadcast({ type: "event", projectId: channelId, event: userEvent });
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
      case "new_session": {
        store.newSession(msg.projectId);
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "remove_session": {
        manager.dispose(msg.sessionId);
        archive.remove(msg.sessionId);
        tracker.removeProject(msg.sessionId);
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
      case "set_model": {
        if (msg.projectId === HOME_ID) {
          store.setHomeSettings({ model: msg.model });
          manager.setModel(HOME_ID, msg.model);
          broadcast({ type: "home_settings", home: store.homeSettings() });
          break;
        }
        store.update(msg.projectId, { model: msg.model });
        manager.setModel(msg.projectId, msg.model);
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
        manager.setPermissionMode(msg.projectId, msg.mode);
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
      case "tracker_review": {
        const channelId = msg.projectId;
        const items = tracker.items(channelId);
        if (!items.some((i) => i.status !== "open")) return;
        const rejected = items
          .filter((i) => i.status === "rejected")
          .map((i) => ({ text: i.text, note: i.note }));
        // outcomes apply immediately: liked verified → gone, rejected → repeats
        tracker.finishReview(channelId);
        broadcast({ type: "tracker", projectId: channelId, items: tracker.items(channelId) });
        if (rejected.length === 0) break;
        // the composer gets a prompt either way — mechanical if the small
        // model is unavailable or fails
        const fallback = `Fix these issues found while reviewing:\n${rejected
          .map((r) => `- ${r.text}${r.note.trim() ? ` — ${r.note.trim()}` : ""}`)
          .join("\n")}`;
        void (smallModelEnabled() ? reviewPrompt(rejected).catch(() => fallback) : Promise.resolve(fallback)).then(
          (text) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({ type: "review_prompt", projectId: channelId, text } satisfies ServerMessage),
              );
            }
          },
        );
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
        sendQueues.delete(HOME_ID);
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
      transcripts: archive.transcripts(projectIds),
      statuses: manager.statuses(),
      permissions: [...permissions.values()],
      models: allModels(),
      summaries: archive.allSummaries(projectIds),
      tracker: tracker.all(projectIds),
      queued: Object.fromEntries(projectIds.map((id) => [id, visibleQueue(id)])),
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
            manager.disposeAll();
            archive.flushAll();
            for (const client of clients) client.close();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
