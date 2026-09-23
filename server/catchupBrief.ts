/**
 * A project's sheet, from the app's side: written into the project and
 * shown to every window whenever it changes, and its shape written whole
 * from a read of the repo (server/brief.ts keeps it, server/catchup.ts
 * reads the repo, server/memory.ts reads the chats).
 */
import { writeBriefFiles } from "./brief.js";
import { buildCatchup } from "./catchup.js";
import type { ServerContext } from "./context.js";
import { warn } from "./log.js";
import { smallModelEnabled } from "./smallmodel.js";

/** The sheet as it now stands, into the project's two files and onto
 *  every window's architecture page. */
export function pushSheet(ctx: ServerContext, projectId: string): void {
  const project = ctx.store.get(projectId);
  if (!project) return;
  const sheet = ctx.briefs.get(projectId);
  writeBriefFiles(project.path, project.name, sheet);
  ctx.clients.broadcast({ type: "sheet", projectId, sheet });
}

export function catchupNote(ctx: ServerContext, projectId: string, busy: boolean, note?: string): void {
  ctx.clients.broadcast({
    type: "catchup",
    projectId,
    busy,
    ...(ctx.briefs.get(projectId).built ? { built: ctx.briefs.get(projectId).built } : {}),
    ...(note ? { note } : {}),
  });
}

/**
 * Read the repo and write the project's whole shape. Runs by itself when a
 * project arrives without one — a project opened with a year of work in it
 * is exactly the one whose first session most needs to be told what it is
 * — when one from before layers and flows first folds a turn, and again
 * whenever the user asks.
 */
export async function rebuildCatchup(ctx: ServerContext, projectId: string): Promise<void> {
  const project = ctx.store.get(projectId);
  if (!project || ctx.catchingUp.has(projectId) || !smallModelEnabled()) return;
  ctx.catchingUp.add(projectId);
  catchupNote(ctx, projectId, true, "reading the repo…");
  try {
    const current = ctx.briefs.get(projectId);
    const built = await buildCatchup(project, current);
    if (!built) {
      catchupNote(ctx, projectId, false, "the sheet could not be written — try again");
      return;
    }
    ctx.briefs.write(projectId, built, true);
    pushSheet(ctx, projectId);
    catchupNote(ctx, projectId, false, "written from the repo");
  } catch (err) {
    warn("server", err, "rebuildCatchup");
    catchupNote(ctx, projectId, false, "the sheet could not be written — try again");
  } finally {
    ctx.catchingUp.delete(projectId);
  }
}

/** Whether a project's shape predates layers and flows — one from an
 *  older ruri, due a read of the repo to draw them. */
export function shapeless(ctx: ServerContext, projectId: string): boolean {
  return !ctx.briefs.get(projectId).layers?.length;
}

/** Whether a project has a brief worth the name. */
export function briefless(ctx: ServerContext, projectId: string): boolean {
  const brief = ctx.briefs.get(projectId);
  return !brief.description && brief.features.length === 0;
}
