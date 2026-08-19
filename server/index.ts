import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMessage, PermissionRequest, ServerMessage } from "../shared/protocol.js";
import { ProjectStore } from "./projects.js";
import { SessionManager } from "./sessions.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7777);

const store = new ProjectStore();
const clients = new Set<WebSocket>();
const permissions = new Map<string, PermissionRequest>();

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
});

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
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
      manager.respondPermission(msg.requestId, msg.allow);
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

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ruri server listening on ws://127.0.0.1:${PORT}`);
});

process.on("SIGINT", () => {
  manager.disposeAll();
  process.exit(0);
});
