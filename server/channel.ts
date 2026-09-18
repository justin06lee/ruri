/**
 * A "channel" id is HOME_ID or a session id; sessions run with their
 * parent project's cwd/model/permission mode but keep their own state.
 */
import type { ServerContext } from "./context.js";
import { HOME_ID, homeProject } from "./manager.js";

/**
 * A channel as a Project: the owning project with the channel's own id —
 * and the chat's own model, effort and mode over the project's defaults,
 * so everything downstream (sessions, windows, forks) sees what this
 * chat actually runs on without knowing there are two layers.
 */
export function channelProject(ctx: ServerContext, channelId: string) {
  if (channelId === HOME_ID) return homeProject(ctx.store.workspaceDir(), ctx.store.homeSettings());
  const found = ctx.store.findSession(channelId);
  if (!found) return undefined;
  const { session, project } = found;
  return {
    ...project,
    id: channelId,
    ...(session.model ? { model: session.model } : {}),
    ...(session.permissionMode ? { permissionMode: session.permissionMode } : {}),
    ...(session.effort ? { effort: session.effort } : {}),
  };
}

/** The project a channel belongs to — boards are keyed by that, not by
 *  the session that happened to be open. */
export function ownerProject(ctx: ServerContext, channelId: string) {
  return ctx.store.findSession(channelId)?.project;
}

/** Where a channel's shells start: its project's directory.
 *
 *  A channel is a SESSION id, not a project id — this looked one up in the
 *  project list, matched nothing, and fell back to the workspace root, so
 *  every project's shell opened in the same place. Home is the exception
 *  and genuinely belongs at the root: it manages the workspace itself. */
export function terminalCwd(ctx: ServerContext, channelId: string): string {
  if (channelId === HOME_ID) return ctx.store.workspaceDir();
  return ownerProject(ctx, channelId)?.path ?? ctx.store.workspaceDir();
}
