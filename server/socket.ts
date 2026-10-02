/**
 * The socket every window talks over: turned away at the upgrade without
 * the page's own origin and the token (server/auth.ts), sent a snapshot of
 * everything the moment it connects, and from then on each message it
 * sends is checked against its schema and handed to its handler
 * (server/handlers).
 */
import type * as http from "node:http";
import type * as https from "node:https";
import * as os from "node:os";
import { WebSocketServer } from "ws";
import { clientMessageSchema, describeIssue } from "../shared/clientSchema.js";
import { TRANSCRIPT_TAIL, type ServerMessage } from "../shared/protocol.js";
import { originAllowed, presentedToken, tokenMatches } from "./auth.js";
import type { ServerContext } from "./context.js";
import { handleMessage } from "./handlers/index.js";
import { errorMessage, warn } from "./log.js";
import { HOME_ID } from "./manager.js";
import type { Seat } from "./sharing.js";
import { contextWindow } from "./turns.js";

/** Who a socket server lets in, and whose window each one is. */
export interface SocketDoor {
  /** 0 lets the upgrade through; anything else is the status it is
   *  refused with. */
  refusal(origin: string | undefined, req: http.IncomingMessage): number;
  /** The device a window that came in here belongs to — none for this
   *  computer's own. */
  seat?(req: http.IncomingMessage): Seat | undefined;
}

/** The local window's door: the page's own origin and the token. */
function localDoor(ctx: ServerContext): SocketDoor {
  return {
    refusal: (origin, req) => {
      if (!originAllowed(origin, ctx.listeningPort, !ctx.options.staticDir)) return 403;
      return tokenMatches(presentedToken(req), ctx.options.token) ? 0 : 401;
    },
  };
}

const REFUSED: Record<number, string> = { 401: "Unauthorized", 403: "Forbidden" };

export function createSocketServer(
  ctx: ServerContext,
  server: http.Server | https.Server,
  door: SocketDoor = localDoor(ctx),
): WebSocketServer {
  const wss = new WebSocketServer({
    server,
    // the socket is the whole app: a page from anywhere else, or one
    // without the key, is turned away at the upgrade
    verifyClient: ({ origin, req }, done) => {
      const status = door.refusal(origin || undefined, req);
      if (status) done(false, status, REFUSED[status] ?? "Refused");
      else done(true);
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

  wss.on("connection", (ws, req) => {
    ctx.clients.sockets.add(ws);
    // a window on another device, come in through sharing (server/sharing.ts)
    const seat = door.seat?.(req);
    if (seat) ctx.clients.seats.set(ws, seat);
    const projectIds = [...ctx.store.sessionIds(), HOME_ID];
    // the boards are the one thing keyed by project rather than by session
    const boardIds = ctx.store.list().map((p) => p.id);
    const snapshot: ServerMessage = {
      type: "snapshot",
      projects: ctx.store.list(),
      transcripts: ctx.readable.allowArchived(ctx.archive.tails(projectIds, TRANSCRIPT_TAIL)),
      statuses: ctx.manager.statuses(),
      work: Object.fromEntries(ctx.turns.work),
      permissions: [...ctx.permissions.values()],
      models: ctx.models.allModels(),
      summaries: ctx.archive.allSummaries(projectIds),
      tracker: ctx.tracker.all(projectIds),
      ideas: ctx.ideas.all(boardIds),
      components: ctx.components.all(boardIds),
      componentDirs: ctx.components.allDirs(boardIds),
      secrets: ctx.secrets.meta(),
      queued: Object.fromEntries(projectIds.map((id) => [id, ctx.queues.visibleQueue(id)])),
      queuesHeld: Object.fromEntries(
        projectIds.flatMap((id) => {
          const hold = ctx.queues.held.get(id);
          return hold ? [[id, hold]] : [];
        }),
      ),
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
      // this computer's folder dialog and macOS's grants are for someone
      // in front of its screen, which a window on another device is not
      canPickFolder: !seat && ctx.options.pickFolder !== undefined,
      canPermissions: !seat && ctx.options.permissions !== undefined,
      platform: process.platform,
      workspaceDir: ctx.store.workspaceDir(),
      musicDir: ctx.musicRoot(),
      home: ctx.store.homeSettings(),
      starredModels: ctx.store.starredModels(),
      smallModel: ctx.store.smallModel() ?? "",
      defaultModel: ctx.store.defaultModel(),
      user: os.userInfo().username,
      harnesses: ctx.updater.list(),
      ...(ctx.updater.checking() ? { harnessesChecking: true } : {}),
      prefs: ctx.prefs.all(),
      composerDrafts: ctx.drafts.all(),
      bridges: ctx.options.bridge?.states() ?? {},
      crew: ctx.crew.all(projectIds),
      sharing: ctx.sharing.info(),
      ...(seat ? { remoteDevice: { id: seat.deviceId, name: seat.name } } : {}),
    };
    ws.send(JSON.stringify(snapshot));
    // after the snapshot: the news that it is online goes to every window,
    // this one too, and a window's first message is its snapshot
    if (seat) ctx.sharing.arrived(seat.deviceId);

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
      if (seat) ctx.sharing.left(seat.deviceId);
      ctx.clients.onGone?.(ws);
      const view = ctx.clients.views.get(ws);
      ctx.clients.views.delete(ws);
      // and the meters go with it, if it was the one watching them
      ctx.meters.watch([...ctx.clients.views.values()].some((v) => v.meters && v.awake));
      // a window gone is every chat it had open, left
      for (const id of view?.channels ?? []) ctx.manager.settle(id);
    });
  });

  return wss;
}
