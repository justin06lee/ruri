import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, ModelChoice, PermissionRequest, ServerMessage } from "../shared/protocol.js";
import { ProjectStore } from "./projects.js";
import { SessionManager } from "./sessions.js";

export interface StartServerOptions {
  port: number;
  host?: string;
  /** When set, GET requests are served from this directory (the built web UI). */
  staticDir?: string;
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
  const clients = new Set<WebSocket>();
  const permissions = new Map<string, PermissionRequest>();
  let models: ModelChoice[] = [];

  function broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  const manager = new SessionManager({
    onEvent: (projectId, event) => broadcast({ type: "event", projectId, event }),
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
  });

  function handleMessage(msg: ClientMessage): void {
    switch (msg.type) {
      case "add_project": {
        store.add(msg.name, msg.path, msg.folder);
        broadcast({ type: "projects", projects: store.list() });
        break;
      }
      case "remove_project": {
        manager.dispose(msg.projectId);
        store.remove(msg.projectId);
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
    const snapshot: ServerMessage = {
      type: "snapshot",
      projects: store.list(),
      transcripts: manager.transcripts(),
      statuses: manager.statuses(),
      permissions: [...permissions.values()],
      models,
    };
    ws.send(JSON.stringify(snapshot));

    ws.on("message", (raw) => {
      try {
        handleMessage(JSON.parse(String(raw)) as ClientMessage);
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
            for (const client of clients) client.close();
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
