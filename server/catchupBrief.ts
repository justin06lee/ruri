/**
 * A project's sheet, from the app's side: written into the project and
 * shown to every window whenever it changes, and its shape written whole
 * from a read of the repo (server/brief.ts keeps it, server/catchup.ts
 * reads the repo, server/memory.ts reads the chats).
 */
import type { MemorySource, ServerMessage, SheetGit, SourceLabel } from "../shared/protocol.js";
import { layered, slugLayers, writeBriefFiles, type SheetExtras } from "./brief.js";
import { buildCatchup, buildLayerSheets, placeUnowned, splitBigLayers } from "./catchup.js";
import type { ServerContext } from "./context.js";
import { branchFacts, commitsSince, gitLines, gitState, headSync, sheetGit } from "./gitState.js";
import { warn } from "./log.js";
import { allLines } from "./memoryLines.js";
import { smallModelEnabled } from "./smallmodel.js";

/* ── where a line came from ────────────────────────────────────────── */

/** An exchange as a ref: the chat's first eight characters and the
 *  exchange's number in it — `7a3637b4#16`. */
export function exchangeRef(chatId: string, n: number): string {
  return `${chatId.slice(0, 8)}#${n}`;
}

/** A line's exchange, as the page and the files name it — undefined once
 *  the chat is gone, or a rewind took the exchange. */
export function sourceLabel(ctx: ServerContext, source: MemorySource): SourceLabel | undefined {
  const found = ctx.store.findSession(source.chat);
  if (!found) return undefined;
  const n = ctx.archive.turnIds(source.chat).indexOf(source.turn) + 1;
  if (n === 0) return undefined;
  return { ref: exchangeRef(source.chat, n), chat: found.session.title || "untitled", n };
}

/** A chat of the project, by the start of its id. */
export function chatByPrefix(ctx: ServerContext, projectId: string, prefix: string): string | undefined {
  const wanted = prefix.toLowerCase();
  const hits = (ctx.store.get(projectId)?.sessions ?? []).filter((s) =>
    s.id.toLowerCase().startsWith(wanted),
  );
  return hits.length === 1 ? hits[0]!.id : undefined;
}

/** `7a3637b4#16` back to its chat and the exchange's prompt. */
export function resolveRef(ctx: ServerContext, projectId: string, ref: string): MemorySource | undefined {
  const match = /^([0-9a-z-]{4,})#(\d+)$/i.exec(ref.trim());
  if (!match) return undefined;
  const chat = chatByPrefix(ctx, projectId, match[1]!);
  if (!chat) return undefined;
  const turn = ctx.archive.turnIds(chat)[Number(match[2]) - 1];
  return turn ? { chat, turn } : undefined;
}

/* ── the sheet, written and shown ──────────────────────────────────── */

const clock = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** Everything the files and the page carry beyond the sheet itself: where
 *  each line came from, git's word on the branches lines name, and the
 *  repo as git has it now. */
async function sheetExtras(
  ctx: ServerContext,
  projectId: string,
): Promise<{ extra: SheetExtras; sources: Record<string, SourceLabel>; git?: SheetGit }> {
  const project = ctx.store.get(projectId);
  if (!project) return { extra: {}, sources: {} };
  const [state, sinceRead] = await Promise.all([
    gitState(project.path),
    (async () => {
      const at = ctx.briefs.get(projectId).builtAt;
      return at ? commitsSince(project.path, at) : undefined;
    })(),
  ]);
  const memory = ctx.briefs.get(projectId).memory;
  const sources: Record<string, SourceLabel> = {};
  const refs: Record<string, string> = {};
  const facts: Record<string, string> = {};
  for (const { part, line } of memory ? allLines(memory) : []) {
    const label = line.source ? sourceLabel(ctx, line.source) : undefined;
    if (label) {
      sources[line.id] = label;
      refs[line.id] = label.ref;
    }
    if (part === "open" || part === "now") {
      const fact = branchFacts(line.text, state);
      if (fact) facts[line.id] = fact;
    }
  }
  return {
    extra: {
      refs,
      facts,
      ...(state ? { git: gitLines(state), asOf: clock(Date.now()) } : {}),
      ...(sinceRead !== undefined ? { sinceRead } : {}),
    },
    sources,
    ...(state ? { git: sheetGit(state, sinceRead) } : {}),
  };
}

/** The sheet as the page gets it. */
export async function sheetMessage(ctx: ServerContext, projectId: string): Promise<ServerMessage> {
  const { sources, git } = await sheetExtras(ctx, projectId);
  return { type: "sheet", projectId, sheet: ctx.briefs.get(projectId), sources, ...(git ? { git } : {}) };
}

/** The sheet as it now stands, into the project's two files and onto
 *  every window's architecture page. Git is asked first, so the sheet
 *  written is the one standing when the answer came — never an older one
 *  overtaking a newer. */
export function pushSheet(ctx: ServerContext, projectId: string): void {
  void (async () => {
    const { extra, sources, git } = await sheetExtras(ctx, projectId);
    const project = ctx.store.get(projectId);
    if (!project) return;
    const sheet = ctx.briefs.get(projectId);
    writeBriefFiles(project.path, project.name, sheet, extra);
    ctx.clients.broadcast({ type: "sheet", projectId, sheet, sources, ...(git ? { git } : {}) });
  })().catch((err: unknown) => warn("brief", err, "pushSheet"));
}

const refreshing = new Map<string, NodeJS.Timeout>();

/** The sheet written again shortly — a turn just ended, so git's part of
 *  it (the branch, what's uncommitted, the last commits) has likely moved.
 *  A burst of turns ending is one refresh. */
export function refreshSheet(ctx: ServerContext, projectId: string): void {
  if (refreshing.has(projectId)) return;
  const timer = setTimeout(() => {
    refreshing.delete(projectId);
    pushSheet(ctx, projectId);
  }, 1500);
  timer.unref?.();
  refreshing.set(projectId, timer);
}

/** The commit a read of the repo happened at. */
export function headOf(ctx: ServerContext, projectId: string): string | undefined {
  const project = ctx.store.get(projectId);
  return project ? headSync(project.path) : undefined;
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
 * Read the repo and write the project's whole shape: the index first (what
 * it is, the stack, the paths across it, how to run it), then each layer's
 * own sheet, one layer at a time. Runs by itself when a project arrives
 * without one — a project opened with a year of work in it is exactly the
 * one whose first session most needs to be told what it is — when one from
 * before layer sheets first folds a turn, and again whenever the user asks.
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
    const at = headOf(ctx, projectId);
    // where to change what, as the sheet knew it before it had layers: each
    // entry goes on to the layer that owns it rather than being lost
    const known = current.map ?? [];
    // a layer that owns too much for one sheet is cut into its parts, and
    // every file ends up owned by some layer
    const say = (note: string) => catchupNote(ctx, projectId, true, note);
    const cut = slugLayers(await splitBigLayers(project, built.layers, say), current.layers);
    const layers = await placeUnowned(project, cut, say);
    const index = ctx.briefs.write(projectId, { ...built, layers, ...(at ? { builtAt: at } : {}) }, true);
    pushSheet(ctx, projectId);
    const written = await buildLayerSheets(
      project,
      index.layers ?? [],
      index.layerSheets ?? {},
      known,
      (slug, sheet) => {
        ctx.briefs.writeLayer(projectId, slug, sheet);
        pushSheet(ctx, projectId);
      },
      (note) => catchupNote(ctx, projectId, true, note),
    );
    catchupNote(
      ctx,
      projectId,
      false,
      written
        ? `written from the repo, ${written} layer${written === 1 ? "" : "s"}`
        : "written from the repo",
    );
  } catch (err) {
    warn("server", err, "rebuildCatchup");
    catchupNote(ctx, projectId, false, "the sheet could not be written — try again");
  } finally {
    ctx.catchingUp.delete(projectId);
  }
}

/** Whether a project's shape predates layer sheets — one from an older
 *  ruri, due a read of the repo to cut its stack finer and write a sheet
 *  for each layer. */
export function shapeless(ctx: ServerContext, projectId: string): boolean {
  const brief = ctx.briefs.get(projectId);
  if (!brief.layers?.length) return true;
  // read since layers had sheets and still without one (nothing the stack
  // owns, or a model that wouldn't answer): that read counts — asking again
  // on every fold would be a whole read of the repo every ten minutes
  return !layered(brief) && (brief.built ?? 0) < LAYER_SHEETS_SINCE;
}

/** When layers started having sheets of their own. */
const LAYER_SHEETS_SINCE = Date.UTC(2026, 8, 24);

/** Whether a project has a brief worth the name. */
export function briefless(ctx: ServerContext, projectId: string): boolean {
  const brief = ctx.briefs.get(projectId);
  return !brief.description && brief.features.length === 0;
}
