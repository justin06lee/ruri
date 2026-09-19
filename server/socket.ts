/**
 * The socket every window talks over: turned away at the upgrade without
 * the page's own origin and the token (server/auth.ts), sent a snapshot of
 * everything the moment it connects, and from then on each message it
 * sends is checked against its schema and handed to its handler
 * (server/handlers).
 */
import type * as http from "node:http";
import * as os from "node:os";
import { WebSocketServer } from "ws";
import { clientMessageSchema, describeIssue } from "../shared/clientSchema.js";
import { TRANSCRIPT_TAIL, type ServerMessage } from "../shared/protocol.js";
import { originAllowed, presentedToken, tokenMatches } from "./auth.js";
import type { ServerContext } from "./context.js";
import { handleMessage } from "./handlers/index.js";
import { errorMessage, warn } from "./log.js";
import { HOME_ID } from "./manager.js";
import { contextWindow } from "./turns.js";

export function createSocketServer(ctx: ServerContext, server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    // the socket is the whole app: a page from anywhere else, or one
    // without the token, is turned away at the upgrade
    verifyClient: ({ origin, req }, done) => {
      if (!originAllowed(origin || undefined, ctx.listeningPort, !ctx.options.staticDir)) {
        done(false, 403, "Forbidden");
        return;
      }
      if (!tokenMatches(presentedToken(req), ctx.options.token)) {
        done(false, 401, "Unauthorized");
        return;
      }
      done(true);
    },
  });

  // ws forwards the http server's "error" to the WebSocketServer, and an
  // "error" event with nobody listening is an uncaught exception — which is
  // why a port already in use used to take the whole app down instead of
  // falling back the way the listen handler in server.ts intends. That handler
  // is the one that decides what to do; this is only here so the copy
  // ws re-emits cannot kill the process on its way past.
  wss.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") return;
    console.error("ruri websocket server error:", error);
  });

  wss.on("connection", (ws) => {
    ctx.clients.sockets.add(ws);
    const projectIds = [...ctx.store.sessionIds(), HOME_ID];
    // the boards are the one thing keyed by project rather than by session
    const boardIds = ctx.store.list().map((p) => p.id);
    const snapshot: ServerMessage = {
      type: "snapshot",
      projects: ctx.store.list(),
      transcripts: ctx.readable.allowArchived(ctx.archive.tails(projectIds, TRANSCRIPT_TAIL)),
      statuses: ctx.manager.statuses(),
      permissions: [...ctx.permissions.values()],
      models: ctx.models.allModels(),
      summaries: ctx.archive.allSummaries(projectIds),
      tracker: ctx.tracker.all(projectIds),
      ideas: ctx.ideas.all(boardIds),
      components: ctx.components.all(boardIds),
      secrets: ctx.secrets.meta(),
      queued: Object.fromEntries(projectIds.map((id) => [id, ctx.queues.visibleQueue(id)])),
      queuesHeld: projectIds.filter((id) => ctx.queues.held.has(id)),
      usage: ctx.usage.limits,
      // live figures first; anything not yet seen this run falls back to the
      // last one the archive recorded, so a relaunch shows real occupancy
      contexts: Object.fromEntries(
        projectIds.flatMap((id) => {
          const live = ctx.turns.contexts.get(id);
          if (live) return [[id, live] as const];
          const tokens = ctx.archive.contextTokens(id);
          return tokens === undefined ? [] : [[id, { tokens, window: contextWindow(ctx, id) }] as const];
        }),
      ),
      turns: ctx.turns.snapshot(),
      stats: ctx.ledger.all([...boardIds, HOME_ID]),
      catchups: Object.fromEntries(
        boardIds.map((id) => [id, ctx.briefs.get(id).built ? { built: ctx.briefs.get(id).built } : {}]),
      ),
      canPickFolder: ctx.options.pickFolder !== undefined,
      canPermissions: ctx.options.permissions !== undefined,
      workspaceDir: ctx.store.workspaceDir(),
      musicDir: ctx.musicRoot(),
      home: ctx.store.homeSettings(),
      starredModels: ctx.store.starredModels(),
      smallModel: ctx.store.smallModel() ?? "",
      defaultModel: ctx.store.defaultModel(),
      user: os.userInfo().username,
      prefs: ctx.prefs.all(),
      composerDrafts: ctx.drafts.all(),
      bridges: ctx.options.bridge?.states() ?? {},
      crew: ctx.crew.all(projectIds),
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
          ws.send(
            JSON.stringify({ type: "error", message: `bad message: ${reason}` } satisfies ServerMessage),
          );
          return;
        }
        handleMessage(ctx, ws, parsed.data);
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
      for (const id of view?.channels ?? []) ctx.manager.settle(id);
    });
  });

  return wss;
}
