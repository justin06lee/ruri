/**
 * The HTTP side of the server: health, music, uploads, the bridge's
 * pictures and calls, talk, the `ruri` command, the files a chat may
 * show, and — when there is a built UI — the UI itself. Anything that
 * changes something is checked for its origin and token first
 * (server/auth.ts).
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { originAllowed, presentedToken, tokenMatches } from "./auth.js";
import { bridgeDir, runBridge } from "./bridge.js";
import { ownerProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import { libraryHost } from "./handlers/components.js";
import { httpWaitFor, listSeats, sendLetter, waitAnswer } from "./handlers/talk.js";
import { runLibrary } from "./library.js";
import { MEMORY_HELP, runMemoryCommand } from "./memoryCli.js";
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
 * cannot hold ruri's tools (server/talk.ts): {"do": "list"},
 * {"do": "send", "to", "message", "reply"} or {"do": "wait", "letter"},
 * answered {"ok", "text"} — and, about a message, its "letter" id and
 * whether "answered". A wait is held no longer than this chat's harness
 * lets a shell command block (httpWaitFor), and one whose curl goes away
 * before it is answered lets go of its answer, which then goes to the
 * chat. As with the bridge, the chat's id is the right to speak as that
 * chat; the handles list_agents hands out name the others without being
 * theirs.
 */
async function serveTalkCall(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const reply = (status: number, body: Record<string, unknown>): void => {
    if (res.destroyed) return;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  // the caller gone before its answer — a harness's command timeout, a
  // stopped turn: the wait lets go, and nothing is written to nobody
  const gone = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) gone.abort();
  });
  const id = (req.url ?? "").slice("/talk/".length).split("?")[0] ?? "";
  if (!id || !ctx.store.sessionIds().includes(id)) {
    reply(404, { ok: false, error: "no such chat" });
    return;
  }
  let body: { do?: unknown; to?: unknown; message?: unknown; reply?: unknown; letter?: unknown };
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
  const waiting = { via: "http" as const, waitMs: httpWaitFor(ctx, id), signal: gone.signal };
  if (body?.do === "wait" && typeof body.letter === "string") {
    reply(200, { ok: true, ...(await waitAnswer(ctx, id, body.letter, waiting)) });
    return;
  }
  if (body?.do !== "send" || typeof body.to !== "string" || typeof body.message !== "string") {
    reply(400, {
      ok: false,
      error:
        'send {"do": "list"}, {"do": "send", "to": "<handle>", "message": "..."} or {"do": "wait", "letter": "<id>"}',
    });
    return;
  }
  // the answer comes back by default, the same as from the tool
  const mode = body.reply === "later" || body.reply === "none" ? body.reply : "wait";
  reply(200, {
    ok: true,
    ...(await sendLetter(ctx, id, { to: body.to, message: body.message, reply: mode }, waiting)),
  });
}

/**
 * POST /library/<channelId> — the `ruri` command a session runs in its
 * shell (server/library.ts): the arguments as repeated `a` fields and the
 * shell's directory as `cwd`, form-encoded, answered as plain text for
 * the command to print — 200 when it did what was asked, 400 when not.
 * The chat's id is the right to change its project's library, as with
 * the bridge and talk.
 */
async function serveLibraryCall(
  ctx: ServerContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const reply = (status: number, text: string): void => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    // the command prints it with a newline of its own
    res.end(text.replace(/\n+$/, ""));
  };
  const id = (req.url ?? "").slice("/library/".length).split("?")[0] ?? "";
  const host = id && ctx.store.sessionIds().includes(id) ? libraryHost(ctx, id) : undefined;
  if (!host) {
    reply(404, "ruri: this session's chat is gone");
    return;
  }
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await readBody(req, 1024 * 1024));
  } catch (err) {
    reply(400, `ruri: bad request: ${errorMessage(err)}`);
    return;
  }
  const argv = form.getAll("a");
  // the memory's commands first (server/memoryCli.ts); the rest are the
  // library's, and help is both
  const memory = await runMemoryCommand(ctx, id, argv).catch((err: unknown) => {
    warn("memory", err, "runMemoryCommand");
    return { ok: false, text: `ruri ${argv[0] ?? ""} failed: ${errorMessage(err)}` };
  });
  if (memory) {
    reply(memory.ok ? 200 : 400, memory.text);
    return;
  }
  const answer = runLibrary(host, argv, form.get("cwd") ?? undefined);
  const help =
    ["help", "-h", undefined].includes(argv[0]?.toLowerCase()) ||
    (!answer.ok && answer.text.startsWith("ruri: no command"));
  reply(answer.ok ? 200 : 400, help ? `${answer.text}\n\n${MEMORY_HELP}` : answer.text);
}

export function createHttpServer(ctx: ServerContext): http.Server {
  const { options } = ctx;
  return http.createServer((req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      // Anything that changes something needs the page's own origin (or
      // none) and the token. The exceptions are the bridge, talk and
      // library calls, whose session id is their capability — harnesses
      // curl them from shells with no token in hand — but they still
      // refuse a browser's Origin.
      const pathname = (req.url ?? "/").split("?")[0] ?? "/";
      const bridgeCall =
        (pathname.startsWith("/bridge/") && !pathname.startsWith("/bridge/preview/")) ||
        pathname.startsWith("/talk/") ||
        pathname.startsWith("/library/");
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
    if (req.method === "POST" && req.url?.startsWith("/library/")) {
      void serveLibraryCall(ctx, req, res);
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
