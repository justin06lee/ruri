/**
 * The HTTP side of the server: health, music, uploads, the bridge's
 * pictures and calls, the files a chat may show, and — when there is a
 * built UI — the UI itself. Anything that changes something is checked for
 * its origin and token first (server/auth.ts).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { originAllowed, presentedToken, tokenMatches } from "./auth.js";
import { bridgeDir, runBridge } from "./bridge.js";
import { ownerProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import { listSeats, sendLetter } from "./handlers/talk.js";
import { errorMessage, isMissing, warn } from "./log.js";
import { HOME_ID } from "./manager.js";
import { mimeOf, STATIC_MIME } from "./mime.js";
import { MUSIC_CORS, scan as scanMusic, serveTrack } from "./music.js";
import { serveUpload } from "./uploads.js";

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

function serveStatic(staticDir: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.resolve(staticDir, rel);
  if (
    !file.startsWith(path.resolve(staticDir) + path.sep) &&
    file !== path.resolve(staticDir, "index.html")
  ) {
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

/** GET /bridge/preview/<channelId> — the strip's picture, overwritten in
 *  place as the session works, so never cached. */
function serveBridgePreview(req: http.IncomingMessage, res: http.ServerResponse): void {
  const id = (req.url ?? "").slice("/bridge/preview/".length).split("?")[0] ?? "";
  const file = path.join(bridgeDir(id), "preview.png");
  try {
    const stat = fs.statSync(file);
    if (!id || !stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": "image/png",
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
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
async function serveBridgeCall(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const id = (req.url ?? "").slice("/bridge/".length).split("?")[0] ?? "";
  if (!id || (id !== HOME_ID && !ctx.store.sessionIds().includes(id))) {
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
  const outcome = await runBridge(
    ctx.options.bridge,
    { channelId: id, projectId: owner?.id ?? id },
    body.tool,
    body.args,
  );
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

/**
 * POST /talk/<channelId> — talking to the other agents, for a harness that
 * cannot hold ruri's tools (server/talk.ts): {"do": "list"}, or
 * {"do": "send", "to", "message", "reply"}, answered {"ok", "text"}. As
 * with the bridge, the chat's id is the right to speak as that chat; the
 * handles list_agents hands out name the others without being theirs.
 */
async function serveTalkCall(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const id = (req.url ?? "").slice("/talk/".length).split("?")[0] ?? "";
  if (!id || !ctx.store.sessionIds().includes(id)) {
    reply(404, { ok: false, error: "no such chat" });
    return;
  }
  let body: { do?: unknown; to?: unknown; message?: unknown; reply?: unknown };
  try {
    body = JSON.parse(await readBody(req, 256 * 1024)) as typeof body;
  } catch (err) {
    reply(400, { ok: false, error: `bad request: ${errorMessage(err)}` });
    return;
  }
  if (body?.do === "list") {
    reply(200, { ok: true, text: listSeats(ctx, id) });
    return;
  }
  if (body?.do !== "send" || typeof body.to !== "string" || typeof body.message !== "string") {
    reply(400, {
      ok: false,
      error: 'send {"do": "list"} or {"do": "send", "to": "<handle>", "message": "..."}',
    });
    return;
  }
  const mode = body.reply === "wait" || body.reply === "none" ? body.reply : "later";
  reply(200, {
    ok: true,
    text: await sendLetter(ctx, id, { to: body.to, message: body.message, reply: mode }),
  });
}

export function createHttpServer(ctx: ServerContext): http.Server {
  const { options } = ctx;
  return http.createServer((req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      // Anything that changes something needs the page's own origin (or
      // none) and the token. The exceptions are the bridge and talk calls,
      // whose session id is their capability — harnesses curl them from
      // shells with no token in hand — but they still refuse a browser's
      // Origin.
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      const bridgeCall =
        (pathname.startsWith("/bridge/") && !pathname.startsWith("/bridge/preview/")) ||
        pathname.startsWith("/talk/");
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
      void serveBridgeCall(ctx, req, res);
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/talk/")) {
      void serveTalkCall(ctx, req, res);
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
}
