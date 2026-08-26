import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type {
  AttachmentUpload,
  ClientMessage,
  ModelChoice,
  PermissionRequest,
  ServerMessage,
} from "../shared/protocol.js";
import { SessionArchive } from "./archive.js";
import { HOME_ID, homeProject, managerExtras, type ManagerHost } from "./manager.js";
import { isAllowed, MIME as AUDIO_MIME, scan as scanMusic } from "./music.js";
import { ProjectStore } from "./projects.js";
import { SessionManager } from "./sessions.js";
import { extractTrackerItems, sessionRoleTitle, smallModelEnabled, splitPrompt, summarizeTurn, TurnTracker } from "./smallmodel.js";
import { TrackerStore } from "./tracker.js";
import { processAttachments, serveUpload } from "./uploads.js";

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
function serveTrack(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const filePath = url.searchParams.get("p") ?? "";
  if (!filePath || !isAllowed(filePath)) {
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
  const archive = new SessionArchive();
  const tracker = new TrackerStore();
  const clients = new Set<WebSocket>();
  const permissions = new Map<string, PermissionRequest>();
  let models: ModelChoice[] = [];

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  // A "channel" id is HOME_ID or a session id; sessions run with their
  // parent project's cwd/model/permission mode but keep their own state.
  function channelProject(channelId: string) {
    if (channelId === HOME_ID) return homeProject(store.workspaceDir());
    const found = store.findSession(channelId);
    if (!found) return undefined;
    return { ...found.project, id: channelId };
  }

  // Split-send queues: sub-prompts waiting for the previous turn to finish.
  const sendQueues = new Map<string, Array<{ text: string; attachments: AttachmentUpload[] }>>();

  function dispatch(channelId: string, text: string, attachments: AttachmentUpload[]): void {
    const project = channelProject(channelId);
    if (!project) throw new Error("unknown session");
    const processed = processAttachments(text, attachments);
    manager.send(project, processed.text, processed.images, processed.attachments);
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
            broadcast({ type: "queue", projectId, remaining: queue!.length });
            dispatch(projectId, next.text, next.attachments);
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
        if (list.length === 0 || JSON.stringify(list) === JSON.stringify(models)) return;
        models = list;
        broadcast({ type: "models", models });
      },
      onSessionId: (projectId, sessionId) => archive.setLastSessionId(projectId, sessionId),
    },
    (projectId) => archive.lastSessionId(projectId),
    (project) =>
      project.id === HOME_ID ? managerExtras(managerHost, store.workspaceDir()) : undefined,
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
        void (options.pickFolder?.() ?? Promise.resolve(null)).then((path) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "folder_picked", path } satisfies ServerMessage));
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
        dispatch(msg.projectId, msg.text, msg.attachments ?? []);
        break;
      }
      case "send_split": {
        if (msg.text.trim().length === 0) return;
        const channelId = msg.projectId;
        const uploads = msg.attachments ?? [];
        void splitPrompt(msg.text)
          .then((prompts) => {
            // route each attachment to the sub-prompt carrying its marker
            const parts = prompts.map((text) => ({ text, attachments: [] as AttachmentUpload[] }));
            for (const upload of uploads) {
              const marker = `[${upload.kind} #${upload.n}]`;
              const target = parts.find((p) => p.text.includes(marker)) ?? parts[0]!;
              target.attachments.push(upload);
            }
            const [first, ...rest] = parts;
            if (rest.length > 0) {
              sendQueues.set(channelId, rest);
              broadcast({ type: "queue", projectId: channelId, remaining: rest.length });
            }
            dispatch(channelId, first!.text, first!.attachments);
          })
          .catch((err) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: `split failed: ${err instanceof Error ? err.message : String(err)}`,
                } satisfies ServerMessage),
              );
            }
          });
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
        if (sendQueues.delete(msg.projectId)) {
          broadcast({ type: "queue", projectId: msg.projectId, remaining: 0 });
        }
        manager.interrupt(msg.projectId);
        break;
      }
      case "permission_response": {
        manager.respondPermission(msg.requestId, msg.allow, msg.always ?? false);
        break;
      }
      case "set_model": {
        store.update(msg.projectId, { model: msg.model });
        manager.setModel(msg.projectId, msg.model);
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "set_permission_mode": {
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
      res.end(JSON.stringify({ playlists: scanMusic() }));
      return;
    }
    if (req.url?.startsWith("/music/track?")) {
      serveTrack(req, res);
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
      models,
      summaries: archive.allSummaries(projectIds),
      tracker: tracker.all(projectIds),
      canPickFolder: options.pickFolder !== undefined,
      workspaceDir: store.workspaceDir(),
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
