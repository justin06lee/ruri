/**
 * A project's sheet, from the app's side: written into the project and
 * shown to every window whenever it changes, and its shape written whole
 * from a read of the repo (server/brief.ts keeps it, server/catchup.ts
 * reads the repo, server/memory.ts reads the chats).
 */
import type { MemorySource, ServerMessage, SheetGit, SourceLabel, StackLayer } from "../shared/protocol.js";
import { excerpt } from "../shared/protocol.js";
import {
  layered,
  layerOfFile,
  sharedSheet,
  slugLayers,
  stacked,
  writeBriefFiles,
  type SheetExtras,
} from "./brief.js";
import { buildCatchup, buildLayerSheets, placeUnowned, splitBigLayers } from "./catchup.js";
import type { ServerContext } from "./context.js";
import { branchFacts, commitsSince, gitLines, gitState, head, sheetGit } from "./gitState.js";
import { warn } from "./log.js";
import { allLines } from "./memoryLines.js";
import { blankProject } from "./ruriDir.js";
import { smallModelEnabled, type MemoryStack } from "./smallmodel.js";
import { layerCandidates } from "./sweep.js";

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

/* ── the chats at work ──────────────────────────────────────────────── */

/** How far back a chat still counts as at work, and how many are named. */
const AT_WORK_MS = 24 * 60 * 60_000;
const AT_WORK_MAX = 8;
/** How many of a chat's last exchanges say which layers it is in. */
const AT_WORK_TURNS = 5;

/** A time as "3h ago". */
function ago(ts: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - ts) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

/** Whether a chat has a turn in flight — asked of the manager, which a
 *  test's stand-in context may not have. */
function workingNow(ctx: ServerContext, channelId: string): boolean {
  try {
    const status = ctx.manager.statuses()[channelId];
    return status === "working" || status === "permission";
  } catch {
    return false;
  }
}

/** The layer most of a set of files is in — most meaning three in five of
 *  those any layer owns — or none, when they are spread across several. */
export function dominantLayer(layers: StackLayer[], files: string[]): string | undefined {
  const counts = new Map<string, number>();
  let owned = 0;
  for (const file of files) {
    const slug = layerOfFile(layers, file)?.slug;
    if (!slug) continue;
    owned += 1;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= owned * 0.6 ? best[0] : undefined;
}

/** The stack as the memory's fold is told it, and the layer an exchange
 *  worked in — so what the model learns from one lands with its layer.
 *  Undefined for a project without layer sheets. */
export function memoryStack(ctx: ServerContext, projectId: string): MemoryStack | undefined {
  const brief = ctx.briefs.get(projectId);
  if (!layered(brief)) return undefined;
  const layers = (brief.layers ?? []).filter((l) => l.slug && brief.layerSheets?.[l.slug]);
  return {
    text: layers.map((l) => `${l.slug} — ${l.name}: ${l.what}`).join("\n"),
    fold: {
      slugs: new Set(layers.map((l) => l.slug!)),
      of: (source) => dominantLayer(layers, ctx.archive.summaries(source.chat)[source.turn]?.files ?? []),
    },
  };
}

/** The layers a chat's last exchanges changed files in, the busiest first. */
export function chatLayers(
  ctx: ServerContext,
  projectId: string,
  channelId: string,
  turns = AT_WORK_TURNS,
): string[] {
  const layers = ctx.briefs.get(projectId).layers ?? [];
  if (!layers.length) return [];
  const summaries = ctx.archive.summaries(channelId);
  const counts = new Map<string, number>();
  for (const turn of ctx.archive.turnIds(channelId).slice(-turns)) {
    for (const file of summaries[turn]?.files ?? []) {
      const slug = layerOfFile(layers, file)?.slug;
      if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([slug]) => slug);
}

/**
 * The project's chats at work in the last day, a line each, the latest
 * first: its name and ref, whether a turn is running now, what it was last
 * asked (the prompt's recall note), and the layers its last turns changed —
 * so a session starting beside them knows what else is moving.
 */
export function chatLines(ctx: ServerContext, projectId: string, now = Date.now()): string[] {
  const project = ctx.store.get(projectId);
  if (!project) return [];
  const chats = project.sessions.flatMap((session) => {
    const events = ctx.archive.events(session.id);
    const last = events.at(-1)?.ts;
    if (!last || now - last > AT_WORK_MS) return [];
    const asked = events.findLast((event) => event.kind === "user");
    const note = asked ? ctx.archive.summaries(session.id)[asked.id]?.user?.trim() : undefined;
    const on = asked ? note || excerpt(asked.kind === "user" ? asked.text : "", 140) : "";
    const layers = chatLayers(ctx, projectId, session.id).slice(0, 3);
    const state = workingNow(ctx, session.id) ? "working now" : `last at work ${ago(last, now)}`;
    const line = [
      `"${session.title || "untitled"}" (${session.id.slice(0, 8)}) — ${state}`,
      ...(on ? [`on: ${on}`] : []),
      ...(layers.length ? [`in: ${layers.join(", ")}`] : []),
    ].join(" · ");
    return [{ last, line }];
  });
  return chats
    .sort((a, b) => b.last - a.last)
    .slice(0, AT_WORK_MAX)
    .map((chat) => chat.line);
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
  const chats = chatLines(ctx, projectId);
  return {
    extra: {
      refs,
      facts,
      ...(state ? { git: gitLines(state), asOf: clock(Date.now()) } : {}),
      ...(sinceRead !== undefined ? { sinceRead } : {}),
      ...(chats.length ? { chats } : {}),
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

/** Projects whose sheet is being pushed, and whether it changed again
 *  meanwhile. */
const pushing = new Map<string, boolean>();

/** The sheet as it now stands, into the project's files and onto every
 *  window's architecture page. Git is asked first, so the sheet written is
 *  the one standing when the answer came — never an older one overtaking a
 *  newer. One push at a time a project: each asks git six things and
 *  rewrites the files, and a read of the repo changes the sheet a dozen
 *  times in a row, so whatever changes while one is out is pushed once,
 *  after it, as it then stands. */
export function pushSheet(ctx: ServerContext, projectId: string): void {
  if (pushing.has(projectId)) {
    pushing.set(projectId, true);
    return;
  }
  pushing.set(projectId, false);
  void (async () => {
    const { extra, sources, git } = await sheetExtras(ctx, projectId);
    const project = ctx.store.get(projectId);
    if (!project) return;
    const sheet = ctx.briefs.get(projectId);
    writeBriefFiles(project.path, project.name, sheet, extra);
    ctx.clients.broadcast({ type: "sheet", projectId, sheet, sources, ...(git ? { git } : {}) });
  })()
    .catch((err: unknown) => warn("brief", err, "pushSheet"))
    .finally(() => {
      const again = pushing.get(projectId);
      pushing.delete(projectId);
      if (again) pushSheet(ctx, projectId);
    });
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

export function catchupNote(ctx: ServerContext, projectId: string, busy: boolean, note?: string): void {
  ctx.clients.broadcast({
    type: "catchup",
    projectId,
    busy,
    ...(ctx.briefs.get(projectId).built ? { built: ctx.briefs.get(projectId).built } : {}),
    ...(note ? { note } : {}),
  });
}

/* ── when the repo is read ─────────────────────────────────────────── */

/**
 * Nothing is read for a project nobody is working in. Every read is a run
 * of the small model — a CLI process of a couple of hundred megabytes for
 * up to a minute, on somebody's subscription — and a project opened is not
 * a project worked in: Home opening a whole workspace of them used to set
 * off a read of each, then a sheet for every layer of each, a couple of
 * hundred runs back to back for projects nobody had asked anything of.
 *
 * So a project is read when someone works in it — a prompt goes into one
 * of its chats, or its architecture page opens (touchProject) — and only
 * its index then: what it is, the stack, how to run it. Each layer's sheet
 * is written when work reaches that layer (server/events.ts foldLayers) or
 * the user opens it on the page (writeLayerSheets). A young project, too
 * small to read, is drawn by its folds as the work fills it in, and read
 * once it has grown enough to cut a stack from (dueRead).
 */

/** The fewest files a layer could own that are worth reading a stack
 *  from — below it, the folds draw the sheet from what the turns did. */
const READ_AT_FILES = 12;
/** A read that came back with nothing is not tried again for this long. */
const READ_RETRY_MS = 30 * 60_000;
const readFailed = new Map<string, number>();

function readRestingSince(projectId: string): boolean {
  const failed = readFailed.get(projectId);
  return failed !== undefined && Date.now() - failed < READ_RETRY_MS;
}

/**
 * Read the repo and write the project's index: what it is, the stack and
 * what each layer owns, the paths across it, how to run it. The index is
 * kept the moment the model answers, before the stack is cut finer, so a
 * quit halfway leaves a sheet rather than a project that reads its whole
 * repo again at the next launch. `sheets: "all"` goes on to write every
 * layer's sheet too — for the user asking for the whole thing afresh;
 * otherwise each is written when work reaches its layer.
 */
export async function rebuildCatchup(
  ctx: ServerContext,
  projectId: string,
  { sheets = "all" }: { sheets?: "all" | "none" } = {},
): Promise<void> {
  const project = ctx.store.get(projectId);
  if (!project || ctx.catchingUp.has(projectId) || !smallModelEnabled()) return;
  ctx.catchingUp.add(projectId);
  catchupNote(ctx, projectId, true, "reading the repo…");
  try {
    const current = ctx.briefs.get(projectId);
    const [built, at, files] = await Promise.all([
      buildCatchup(project, current),
      head(project.path),
      layerCandidates(project.path),
    ]);
    if (!built) {
      readFailed.set(projectId, Date.now());
      catchupNote(ctx, projectId, false, "the sheet could not be written — try again");
      return;
    }
    readFailed.delete(projectId);
    const read = { ...(at ? { builtAt: at } : {}), readFiles: files.length };
    ctx.briefs.write(projectId, { ...built, ...read }, true);
    pushSheet(ctx, projectId);
    // where to change what, as the sheet knew it before it had layers: each
    // entry goes on to the layer that owns it rather than being lost
    const known = current.map ?? [];
    // a layer that owns too much for one sheet is cut into its parts, and
    // every file ends up owned by some layer
    const say = (note: string) => catchupNote(ctx, projectId, true, note);
    const cut = slugLayers(await splitBigLayers(project, built.layers, say), current.layers);
    const layers = await placeUnowned(project, cut, say);
    const index = ctx.briefs.write(projectId, { ...built, layers, ...read }, true);
    pushSheet(ctx, projectId);
    if (sheets === "none") {
      catchupNote(ctx, projectId, false, "written from the repo — each layer's sheet as work reaches it");
      return;
    }
    const written = await buildLayerSheets(
      project,
      index.layers ?? [],
      index.layerSheets ?? {},
      known,
      (slug, sheet) => {
        ctx.briefs.writeLayer(projectId, slug, sheet, { by: "repo" });
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
    readFailed.set(projectId, Date.now());
    warn("server", err, "rebuildCatchup");
    catchupNote(ctx, projectId, false, "the sheet could not be written — try again");
  } finally {
    ctx.catchingUp.delete(projectId);
  }
}

/** Layers whose sheets are being written right now, as "project/slug". */
const writingLayers = new Set<string>();

/**
 * Write the sheets of the given layers that don't have one yet — read
 * from the files each owns as they stand now, so a layer the work just
 * reached gets a sheet that already holds what the work did. One run of
 * the small model a layer.
 */
export async function writeLayerSheets(
  ctx: ServerContext,
  projectId: string,
  slugs: string[],
): Promise<void> {
  const project = ctx.store.get(projectId);
  if (!project || !smallModelEnabled() || ctx.catchingUp.has(projectId)) return;
  const brief = ctx.briefs.get(projectId);
  const layers = brief.layers ?? [];
  const wanted = slugs.filter(
    (slug) =>
      layers.some((l) => l.slug === slug) &&
      !brief.layerSheets?.[slug] &&
      !writingLayers.has(`${projectId}/${slug}`),
  );
  if (wanted.length === 0) return;
  for (const slug of wanted) writingLayers.add(`${projectId}/${slug}`);
  try {
    const written = await buildLayerSheets(
      project,
      layers,
      brief.layerSheets ?? {},
      brief.map ?? [],
      (slug, sheet) => {
        ctx.briefs.writeLayer(projectId, slug, sheet, { by: "repo" });
        pushSheet(ctx, projectId);
      },
      (note) => catchupNote(ctx, projectId, true, note),
      new Set(wanted),
    );
    catchupNote(
      ctx,
      projectId,
      false,
      written
        ? `wrote ${written} layer sheet${written === 1 ? "" : "s"}`
        : "the layer's sheet could not be written",
    );
  } catch (err) {
    warn("server", err, "writeLayerSheets");
    catchupNote(ctx, projectId, false, "the layer's sheet could not be written — try again");
  } finally {
    for (const slug of wanted) writingLayers.delete(`${projectId}/${slug}`);
  }
}

/**
 * The shape a clone of the project brought with it in `.ruri/`, taken in
 * as this project's own — the stack, the layers' sheets and how to run it,
 * as whoever committed it had them — rather than a read of the repo
 * writing it over in other words. False when there was none, or the
 * project already has a sheet of its own.
 */
export function adoptShared(ctx: ServerContext, projectId: string): boolean {
  const project = ctx.store.get(projectId);
  if (!project || !briefless(ctx, projectId)) return false;
  const shared = sharedSheet(project.path);
  if (!shared || (!shared.description && shared.features.length === 0)) return false;
  ctx.briefs.write(projectId, shared, true, { by: "repo" });
  pushSheet(ctx, projectId);
  return true;
}

/**
 * Someone is working in the project: a prompt went into one of its chats,
 * or its architecture page opened. A project with no sheet yet takes the
 * one its clone brought, or has its repo read for one — its index only.
 * A blank project has nothing to read; its folds draw it as work fills it.
 */
export function touchProject(ctx: ServerContext, projectId: string): void {
  const project = ctx.store.get(projectId);
  if (!project || !briefless(ctx, projectId)) return;
  if (adoptShared(ctx, projectId)) return;
  if (!smallModelEnabled() || ctx.catchingUp.has(projectId) || readRestingSince(projectId)) return;
  if (blankProject(project.path)) return;
  void rebuildCatchup(ctx, projectId, { sheets: "none" });
}

/**
 * Whether a young project — its sheet drawn by folds, its stack owning no
 * files — has grown enough to have its repo read for a stack to cut its
 * layers' sheets from: a dozen files a layer could own, and twice what the
 * last read saw, so a read that found too little is not repeated on every
 * fold until the project has really grown.
 */
export async function dueRead(ctx: ServerContext, projectId: string): Promise<boolean> {
  const project = ctx.store.get(projectId);
  const brief = ctx.briefs.get(projectId);
  if (!project || !smallModelEnabled() || stacked(brief) || !brief.description) return false;
  if (ctx.catchingUp.has(projectId) || readRestingSince(projectId) || blankProject(project.path))
    return false;
  const files = (await layerCandidates(project.path)).length;
  return files >= Math.max(READ_AT_FILES, 2 * (brief.readFiles ?? 0));
}

/** Whether a project has a brief worth the name. */
export function briefless(ctx: ServerContext, projectId: string): boolean {
  const brief = ctx.briefs.get(projectId);
  return !brief.description && brief.features.length === 0;
}
