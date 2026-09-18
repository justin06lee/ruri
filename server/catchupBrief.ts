/**
 * The catch-up brief, written whole: the small model reads the repo and
 * writes what the project is, for every session to be told on its first
 * prompt (server/brief.ts keeps it, server/catchup.ts reads the repo).
 */
import { writeCatchupFile } from "./brief.js";
import { buildCatchup } from "./catchup.js";
import type { ServerContext } from "./context.js";
import { warn } from "./log.js";
import { smallModelEnabled } from "./smallmodel.js";

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
 * Read the repo and write the whole brief. Runs by itself when a project
 * arrives without one — a project opened with a year of work in it is
 * exactly the one whose first session most needs to be told what it is —
 * and again whenever the user asks.
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
      catchupNote(ctx, projectId, false, "the brief could not be written — try again");
      return;
    }
    writeCatchupFile(project.path, project.name, ctx.briefs.write(projectId, built, true));
    catchupNote(ctx, projectId, false, "brief written");
  } catch (err) {
    warn("server", err, "rebuildCatchup");
    catchupNote(ctx, projectId, false, "the brief could not be written — try again");
  } finally {
    ctx.catchingUp.delete(projectId);
  }
}

/** Whether a project has a brief worth the name. */
export function briefless(ctx: ServerContext, projectId: string): boolean {
  const brief = ctx.briefs.get(projectId);
  return !brief.description && brief.features.length === 0;
}
