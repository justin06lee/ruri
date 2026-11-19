/**
 * Settings, as the window changes them: its own preferences, the
 * workspace and music folders, each chat's (or project's, or Home's)
 * model, permission mode and effort, the models' roles, the vault, and
 * the pictures of the peek band.
 */
import { WebSocket } from "ws";
import type { ServerMessage } from "../../shared/protocol.js";
import type { ServerContext } from "../context.js";
import { warn } from "../log.js";
import { HOME_ID } from "../manager.js";
import type { ModelRoles } from "../projects.js";
import { setMemoryModel, setSmallModel } from "../smallmodel.js";
import { republishContext } from "../turns.js";
import { storeUpload } from "../uploads.js";
import type { Handlers } from "./types.js";

/** The roles changed: the small layer and every window hear the new set.
 *  A new default pins nothing live (the store already did), so the
 *  projects list goes out too — the pinned values are now on them. */
export function announceRoles(ctx: ServerContext, roles: ModelRoles): void {
  setSmallModel(roles.small);
  setMemoryModel(roles.memory);
  ctx.clients.broadcast({ type: "starred_models", models: roles.starred });
  ctx.clients.broadcast({ type: "small_model", model: roles.small ?? "" });
  ctx.clients.broadcast({ type: "memory_model", model: roles.memory });
  ctx.clients.broadcast({ type: "default_model", model: ctx.store.defaultModel() });
  ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
}

export const settingHandlers = {
  set_pref: (ctx, _ws, msg) => {
    ctx.prefs.set(msg.key, msg.value);
    ctx.clients.broadcast({ type: "prefs", prefs: ctx.prefs.all() });
  },
  // a picture for the peek band: kept with the uploads,
  // and the sweep leaves it there for as long as a preference names it
  store_picture: (_ctx, ws, msg) => {
    let url: string | null = null;
    if (msg.upload.mediaType.startsWith("image/") && msg.upload.mediaType !== "image/svg+xml") {
      try {
        url = storeUpload(msg.upload).url;
      } catch (err) {
        warn("settings", err, "store_picture");
      }
    }
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "picture_stored", id: msg.upload.id, url } satisfies ServerMessage));
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
    // live session takes it once its turn is over, and no teammate moves.
    if (!ctx.store.findSession(msg.projectId)) return;
    if (ctx.store.effectiveSettings(msg.projectId)?.model === msg.model) return;
    ctx.store.setSessionSettings(msg.projectId, { model: msg.model });
    ctx.models.registry.prepare(msg.model);
    ctx.manager.setModel(msg.projectId, msg.model);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    // the new model may have a different window — remeasure against it
    republishContext(ctx, msg.projectId);
  },
  set_permission_mode: (ctx, _ws, msg) => {
    if (msg.projectId === HOME_ID) {
      ctx.store.setHomeSettings({ permissionMode: msg.mode });
      ctx.manager.setPermissionMode(HOME_ID, msg.mode);
      ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
      return;
    }
    if (!ctx.store.findSession(msg.projectId)) return;
    if (ctx.store.effectiveSettings(msg.projectId)?.permissionMode === msg.mode) return;
    ctx.store.setSessionSettings(msg.projectId, { permissionMode: msg.mode });
    ctx.manager.setPermissionMode(msg.projectId, msg.mode);
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
    if (!ctx.store.findSession(msg.projectId)) return;
    if (ctx.store.effectiveSettings(msg.projectId)?.effort === msg.effort) return;
    ctx.store.setSessionSettings(msg.projectId, { effort: msg.effort });
    ctx.manager.setEffort(msg.projectId, msg.effort);
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
  },
  // The effort a chat runs at when nobody picked one. Every chat riding
  // the default follows it, the ones with a session running told now; a
  // chat that picked its own is left alone.
  set_default_effort: (ctx, _ws, msg) => {
    if (ctx.store.defaultEffort() === msg.effort) return;
    ctx.store.setDefaultEffort(msg.effort);
    for (const id of ctx.store.ridingDefaultEffort()) ctx.manager.setEffort(id, ctx.store.defaultEffort());
    ctx.clients.broadcast({ type: "default_effort", effort: ctx.store.defaultEffort() });
    ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
    ctx.clients.broadcast({ type: "home_settings", home: ctx.store.homeSettings() });
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
  // Each of these goes to wherever the secret lives — the ghostly vault or
  // ruri's own file — and the vault tells every window when it has landed
  // (server/vault.ts): a save into the vault is a second or two away.
  secret_save: (ctx, _ws, msg) => {
    void ctx.vault.save({
      ...(msg.id ? { id: msg.id } : {}),
      name: msg.name,
      ...(msg.username !== undefined ? { username: msg.username } : {}),
      ...(msg.note !== undefined ? { note: msg.note } : {}),
      ...(msg.secret !== undefined ? { secret: msg.secret } : {}),
      ...(msg.generate ? { generate: true } : {}),
      ...(msg.collection ? { collection: msg.collection } : {}),
    });
  },
  secret_remove: (ctx, _ws, msg) => {
    void ctx.vault.remove(msg.id);
  },
  secret_move: (ctx, _ws, msg) => {
    void ctx.vault.move(msg.id);
  },
  vault_refresh: (ctx, _ws, msg) => {
    if (msg.full) void ctx.vault.refresh(true);
    else ctx.vault.opened();
  },
  // Finding a vault on the tailnet and setting one up: one job at a time,
  // its card on every window (server/vault.ts, server/vaultSetup.ts).
  vault_look: (ctx) => {
    void ctx.vault.look();
  },
  vault_enroll: (ctx, _ws, msg) => {
    void ctx.vault.enroll(msg.server, ...(msg.name ? [msg.name] : []));
  },
  vault_setup: (ctx, _ws, msg) => {
    void ctx.vault.setUp(msg.host, msg.user, msg.password);
  },
  vault_signups_off: (ctx, _ws, msg) => {
    void ctx.vault.signupsOff(msg.password);
  },
  vault_install: (ctx) => {
    void ctx.vault.install();
  },
  vault_copy_password: (ctx) => {
    void ctx.vault.copyPassword();
  },
  vault_job_close: (ctx) => {
    ctx.vault.closeJob();
  },
} satisfies Partial<Handlers>;
