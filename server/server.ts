import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ModelChoice, PermissionRequest, ServerMessage } from "../shared/protocol.js";
import { SessionArchive } from "./archive.js";
import { isAllowed, MIME as AUDIO_MIME, scan as scanMusic } from "./music.js";
import { ProjectStore } from "./projects.js";
import { SessionManager } from "./sessions.js";
import { smallModelEnabled, summarizeTurn, TurnTracker } from "./smallmodel.js";

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
  const clients = new Set<WebSocket>();
  const permissions = new Map<string, PermissionRequest>();
  let models: ModelChoice[] = [];

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  // Every finished turn is summarized in the background by the small model,
  // so the transcript can compact instantly — the full events stay archived.
  const turns = new TurnTracker((projectId, turn) => {
    if (!smallModelEnabled()) return;
    summarizeTurn(turn)
      .then((summary) => {
        if (!summary) return;
        archive.setSummary(projectId, turn.turnId, summary);
        broadcast({ type: "turn_summary", projectId, turnId: turn.turnId, summary });
      })
      .catch(() => {});
  });

  const manager = new SessionManager(
    {
      onEvent: (projectId, event) => {
        archive.append(projectId, event);
        turns.observe(projectId, event);
        broadcast({ type: "event", projectId, event });
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
  );

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
        manager.dispose(msg.projectId);
        store.remove(msg.projectId);
        archive.remove(msg.projectId);
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "send": {
        const project = store.get(msg.projectId);
        if (!project) throw new Error("unknown project");
        if (msg.text.trim().length === 0) return;
        manager.send(project, msg.text);
        break;
      }
      case "interrupt": {
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
    const projectIds = store.list().map((p) => p.id);
    const snapshot: ServerMessage = {
      type: "snapshot",
      projects: store.list(),
      transcripts: archive.transcripts(projectIds),
      statuses: manager.statuses(),
      permissions: [...permissions.values()],
      models,
      summaries: archive.allSummaries(projectIds),
      canPickFolder: options.pickFolder !== undefined,
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
