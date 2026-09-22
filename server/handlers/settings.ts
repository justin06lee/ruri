/**
 * Settings, as the window changes them: its own preferences, the
 * workspace and music folders, each chat's (or project's, or Home's)
 * model, permission mode and effort, the models' roles, the vault, and
 * the peek band's pictures.
 */
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.js";
import type { ServerContext } from "../context.js";
import { warn } from "../log.js";
import { HOME_ID } from "../manager.js";
import { setSmallModel } from "../smallmodel.js";
import { republishContext } from "../turns.js";
import { storeUpload } from "../uploads.js";
import type { Handlers } from "./types.js";

/** The roles changed: the small layer and every window hear the new set.
 *  A new default pins nothing live (the store already did), so the
 *  projects list goes out too — the pinned values are now on them. */
function announceRoles(
  ctx: ServerContext,
  roles: { starred: string[]; small: string | undefined; default: string | undefined },
): void {
  setSmallModel(roles.small);
  ctx.clients.broadcast({ type: "starred_models", models: roles.starred });
  ctx.clients.broadcast({ type: "small_model", model: roles.small ?? "" });
  ctx.clients.broadcast({ type: "default_model", model: ctx.store.defaultModel() });
  ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
}

export const settingHandlers = {
  set_pref: (ctx, _ws, msg) => {
    ctx.prefs.set(msg.key, msg.value);
    ctx.clients.broadcast({ type: "prefs", prefs: ctx.prefs.all() });
  },
  // a picture for the peek band: kept with the uploads, and the sweep
  // leaves it there for as long as the band's preference names it
  band_picture: (_ctx, ws, msg) => {
    let url: string | null = null;
    if (msg.upload.mediaType.startsWith("image/") && msg.upload.mediaType !== "image/svg+xml") {
      try {
        url = storeUpload(msg.upload).url;
      } catch (err) {
        warn("settings", err, "band_picture");
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({ type: "band_picture_stored", id: msg.upload.id, url } satisfies ServerMessage),
      );
    }
  },
  set_workspace: (ctx, _ws, msg) => {
    ctx.store.setWorkspaceDir(msg.path);
    ctx.clients.broadcast({ type: "workspace", path: ctx.store.workspaceDir() });
  },
  set_music_dir: (ctx, _ws, msg) => {
    ctx.store.setMusicDir(msg.path);
    ctx.clients.broadcast({ type: "music_dir", path: ctx.musicRoot() });
  },
  set_model: (ctx, _ws, msg) => {
    if (msg.projectId === HOME_ID) {
      ctx.store.setHomeSettings({ model: msg.model });
      ctx.manager.setModel(HOME_ID, msg.model);
      ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
      republishContext(ctx, HOME_ID);
      return;
    }
    // A chat's pick is that chat's alone: it lands on the session, the
    // live session takes it once its turn is over, and no other chat
    // in the project moves. The project id form is wholesale.
    if (ctx.store.findSession(msg.projectId)) {
      if (ctx.store.effectiveSettings(msg.projectId)?.model === msg.model) return;
      ctx.store.setSessionSettings(msg.projectId, { model: msg.model });
      ctx.manager.setModel(msg.projectId, msg.model);
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      // the new model may have a different window — remeasure against it
      republishContext(ctx, msg.projectId);
      return;
    }
    const project = ctx.store.get(msg.projectId);
    if (!project) return;
    for (const s of project.sessions) delete s.model;
    ctx.store.update(msg.projectId, { model: msg.model });
    // live sessions are keyed by session id, not project id
    for (const s of project.sessions) ctx.manager.setModel(s.id, msg.model);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    for (const s of project.sessions) republishContext(ctx, s.id);
  },
  set_permission_mode: (ctx, _ws, msg) => {
    if (msg.projectId === HOME_ID) {
      ctx.store.setHomeSettings({ permissionMode: msg.mode });
      ctx.manager.setPermissionMode(HOME_ID, msg.mode);
      ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
      return;
    }
    if (ctx.store.findSession(msg.projectId)) {
      if (ctx.store.effectiveSettings(msg.projectId)?.permissionMode === msg.mode) return;
      ctx.store.setSessionSettings(msg.projectId, { permissionMode: msg.mode });
      ctx.manager.setPermissionMode(msg.projectId, msg.mode);
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      return;
    }
    const project = ctx.store.get(msg.projectId);
    if (!project) return;
    for (const s of project.sessions) delete s.permissionMode;
    ctx.store.update(msg.projectId, { permissionMode: msg.mode });
    for (const s of project.sessions) ctx.manager.setPermissionMode(s.id, msg.mode);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  },
  set_effort: (ctx, _ws, msg) => {
    if (msg.projectId === HOME_ID) {
      if ((ctx.store.homeSettings().effort ?? "") === msg.effort) return;
      ctx.store.setHomeSettings({ effort: msg.effort });
      ctx.manager.setEffort(HOME_ID, msg.effort);
      ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
      return;
    }
    if (ctx.store.findSession(msg.projectId)) {
      if (ctx.store.effectiveSettings(msg.projectId)?.effort === msg.effort) return;
      ctx.store.setSessionSettings(msg.projectId, { effort: msg.effort });
      ctx.manager.setEffort(msg.projectId, msg.effort);
      ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
      return;
    }
    const project = ctx.store.get(msg.projectId);
    if (!project) return;
    if ((project.effort ?? "") === msg.effort && project.sessions.every((s) => !s.effort)) return;
    for (const s of project.sessions) delete s.effort;
    ctx.store.update(msg.projectId, { effort: msg.effort });
    for (const s of project.sessions) ctx.manager.setEffort(s.id, msg.effort);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  },
  toggle_model_star: (ctx, _ws, msg) => {
    announceRoles(ctx, ctx.store.cycleModelStar(msg.model));
  },
  set_model_role: (ctx, _ws, msg) => {
    announceRoles(ctx, ctx.store.assignModelRole(msg.model, msg.role));
  },
  check_harnesses: (ctx, _ws, msg) => {
    void ctx.updater.check(msg.id);
  },
  set_harness_auto: (ctx, _ws, msg) => {
    ctx.updater.setAuto(msg.id, msg.auto);
  },
  refresh_models: (ctx) => {
    // Probing spawns a short-lived process per harness, so back-to-back
    // Settings opens within half a minute reuse the last answer.
    if (Date.now() - ctx.models.probedAt > 30_000) ctx.models.probeModels(true);
  },
  secret_save: (ctx, _ws, msg) => {
    ctx.secrets.upsert({
      ...(msg.id ? { id: msg.id } : {}),
      name: msg.name,
      ...(msg.username !== undefined ? { username: msg.username } : {}),
      ...(msg.note !== undefined ? { note: msg.note } : {}),
      ...(msg.secret !== undefined ? { secret: msg.secret } : {}),
    });
    ctx.clients.broadcast({ type: "secrets", items: ctx.secrets.meta() });
  },
  secret_remove: (ctx, _ws, msg) => {
    ctx.secrets.remove(msg.id);
    ctx.clients.broadcast({ type: "secrets", items: ctx.secrets.meta() });
  },
} satisfies Partial<Handlers>;
