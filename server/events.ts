/**
 * One transcript event's way in: redacted, archived, observed, pushed to the
 * windows — and the small-model work every prompt and finished turn sets
 * off (recall notes, tracker items, the project's sheet, the role title).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { StackLayer, TranscriptEvent } from "../shared/protocol.js";
import {
  exchangeRef,
  memoryStack,
  pushSheet,
  rebuildCatchup,
  refreshSheet,
  resolveRef,
  shapeless,
} from "./catchupBrief.js";
import { layered, layerOfFile } from "./brief.js";
import { editedSince, noteToolRead } from "./sheetEdits.js";
import { writeIndexFile } from "./components.js";
import { pushComponents } from "./handlers/components.js";
import type { ServerContext } from "./context.js";
import { HOME_ID } from "./manager.js";
import { warn } from "./log.js";
import { rebuildMemory } from "./memory.js";
import { dayOf, rebase } from "./memoryLines.js";
import { projectRelative } from "./recall.js";
import { layerCandidate } from "./sweep.js";
import { noteSummary } from "./notes.js";
import { blankProject, clearRuriDir } from "./ruriDir.js";
import {
  endsIntact,
  extractTrackerItems,
  foldLayerSheet,
  foldMemory,
  sessionRoleTitle,
  smallModelEnabled,
  summarizePrompt,
  summarizeReply,
  TurnTracker,
  updateShape,
} from "./smallmodel.js";

// Every finished turn goes to the small model in the background for a
// reply recall note (instant compaction). Failures are silent — a nicety.

/**
 * How often a project's sheet takes in what its turns did: its shape (what
 * it can do, how it is built) and its working memory (what was decided and
 * why, what worked and what didn't, the traps, what's open). Most turns
 * change little in either, yet each fold is a small-model call: a whole
 * CLI process for several seconds. Ten agents working in one project used
 * to mean ten of those a round. So a project's first finished turn folds at
 * once, and the turns after it gather and fold together, at most once a
 * window.
 */
const BRIEF_EVERY_MS = Number(process.env["RURI_BRIEF_EVERY_MS"]) || 10 * 60_000;
/** The turns a fold takes, newest kept — and how much of each. The reply
 *  is kept long, ends intact: an agent says what it tried and why it
 *  didn't work in the middle of a turn, and what it concluded at the end. */
const BRIEF_TURNS = 5;
const BRIEF_USER_CHARS = 1500;
const BRIEF_REPLY_CHARS = 4000;

/** A finished turn as a fold reads it, and the files it changed
 *  (project-relative) — which decide the layers it folds into — with its
 *  chat and when it started, which say what the session kept itself. */
export interface Gathered {
  text: string;
  files: string[];
  chat?: string;
  started?: number;
}

const gathering = new Map<string, { turns: Gathered[]; timer?: NodeJS.Timeout; last: number }>();

/** The most layer sheets one fold rewrites — the layers most worked on. */
const LAYER_FOLDS = 3;

/** One finished turn, for the sheet to take in with the others — opening
 *  with its ref, so a line the model learns from it can say where.
 *  `files` are project-relative. */
export function foldBrief(
  ctx: ServerContext,
  channelId: string,
  turn: { turnId?: string; user: string; assistant: string; files?: string[]; started?: number },
): void {
  if (channelId === HOME_ID) return;
  const found = ctx.store.findSession(channelId);
  const project = found?.project;
  if (!project) return;
  const held = gathering.get(project.id) ?? { turns: [], last: 0 };
  gathering.set(project.id, held);
  const chat = found.session.title ? ` (in the "${found.session.title}" chat)` : "";
  const n = turn.turnId ? ctx.archive.turnIds(channelId).indexOf(turn.turnId) + 1 : 0;
  const tag = [n ? exchangeRef(channelId, n) : "", dayOf()].filter(Boolean).join(" · ");
  const changed = turn.files ?? [];
  const files = changed.length ? `\n\nFiles it changed: ${changed.slice(0, 30).join(", ")}` : "";
  held.turns.push({
    text:
      `[${tag}]${chat} The user asked:\n${turn.user.slice(0, BRIEF_USER_CHARS)}\n\n` +
      `What the agent did and said:\n${endsIntact(turn.assistant, BRIEF_REPLY_CHARS)}${files}`,
    files: changed,
    chat: channelId,
    ...(turn.started ? { started: turn.started } : {}),
  });
  if (held.turns.length > BRIEF_TURNS) held.turns.splice(0, held.turns.length - BRIEF_TURNS);
  if (held.timer) return;
  held.timer = setTimeout(
    () => foldGathered(ctx, project.id),
    Math.max(0, held.last + BRIEF_EVERY_MS - Date.now()),
  );
  held.timer.unref?.();
}

/** What a project's turns did since the last fold, into its sheet. */
function foldGathered(ctx: ServerContext, projectId: string): void {
  const held = gathering.get(projectId);
  const project = ctx.store.get(projectId);
  if (!held || !project) {
    gathering.delete(projectId);
    return;
  }
  const turns = held.turns.splice(0);
  delete held.timer;
  held.last = Date.now();
  if (turns.length === 0) return;
  const happened = turns.map((turn) => turn.text).join("\n\n---\n\n");
  const current = ctx.briefs.get(project.id);
  // the index is left to a session that kept it itself this turn
  const unkept = turns.filter((turn) => !keptItself(turn).index);
  const shapeHappened = unkept.map((turn) => turn.text).join("\n\n---\n\n");

  // A sheet from before layer sheets is drawn whole from the repo once,
  // rather than folded forward from a shape that has none.
  if (shapeless(ctx, project.id) && current.description) void rebuildCatchup(ctx, project.id);
  else {
    foldLayers(ctx, project.id, turns);
    if (shapeHappened)
      updateShape(project.name, pickShape(current), shapeHappened, project.path, layered(current))
        .then((next) => {
          if (!next || JSON.stringify(next) === JSON.stringify(pickShape(current))) return;
          // the user corrected the shape while the model wrote: theirs stands,
          // and the next fold starts from it
          if (JSON.stringify(pickShape(ctx.briefs.get(project.id))) !== JSON.stringify(pickShape(current)))
            return;
          ctx.briefs.write(project.id, next);
          pushSheet(ctx, project.id);
        })
        .catch(() => {});
  }

  // A project with no memory yet reads its chats whole — what they hold
  // includes these turns — rather than starting from this batch alone.
  if (!current.memory) {
    void rebuildMemory(ctx, project.id);
    return;
  }
  const before = current.memory;
  foldMemory(
    project.name,
    before,
    happened,
    dayOf(),
    (ref) => resolveRef(ctx, project.id, ref),
    memoryStack(ctx, project.id),
  )
    .then((folded) => {
      if (!folded) return;
      const live = ctx.briefs.get(project.id).memory;
      const memory = rebase(folded, before, live);
      if (JSON.stringify(memory) === JSON.stringify(live)) return;
      ctx.briefs.remember(project.id, memory);
      pushSheet(ctx, project.id);
    })
    .catch(() => {});
}

/**
 * The stack kept owning what the turns changed. A file no layer owns yet —
 * a new one, most often — goes to the layer holding two thirds or more of
 * the owned files in its own folder; one whose folder no layer has that
 * hold on is left for a session or the user to place (`ruri architecture`
 * lists them) rather than guessed at. A file a layer owned by name that is
 * gone is let go.
 */
export function adoptFiles(ctx: ServerContext, projectId: string, projectDir: string, files: string[]): void {
  const brief = ctx.briefs.get(projectId);
  if (!layered(brief) || files.length === 0) return;
  let layers = brief.layers ?? [];
  let changed = false;
  for (const file of new Set(files)) {
    if (!fs.existsSync(path.join(projectDir, file))) {
      if (!layers.some((l) => l.paths?.includes(file))) continue;
      layers = layers.map((l) =>
        l.paths?.includes(file) ? { ...l, paths: l.paths.filter((p) => p !== file) } : l,
      );
      changed = true;
      continue;
    }
    if (layerOfFile(layers, file) || !layerCandidate(file)) continue;
    const slug = folderOwner(layers, projectDir, file);
    if (!slug) continue;
    layers = layers.map((l) => (l.slug === slug ? { ...l, paths: [...(l.paths ?? []), file] } : l));
    changed = true;
  }
  if (!changed) return;
  ctx.briefs.write(
    projectId,
    { description: brief.description, features: brief.features, layers },
    false,
    null,
  );
  pushSheet(ctx, projectId);
}

/** The layer holding two thirds or more of the owned files beside `file`. */
function folderOwner(layers: StackLayer[], projectDir: string, file: string): string | undefined {
  const dir = path.dirname(file);
  let names: string[];
  try {
    names = fs.readdirSync(path.join(projectDir, dir));
  } catch {
    return undefined;
  }
  const counts = new Map<string, number>();
  let owned = 0;
  for (const name of names) {
    const rel = dir === "." ? name : `${dir}/${name}`;
    if (rel === file) continue;
    const slug = layerOfFile(layers, rel)?.slug;
    if (!slug) continue;
    owned += 1;
    counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= (owned * 2) / 3 ? best[0] : undefined;
}

/** What a turn's own session kept true itself while it ran: the index,
 *  and the layers whose sheets it edited (server/sheetEdits.ts). */
function keptItself(turn: Gathered): { index: boolean; layers: Set<string> } {
  return turn.chat ? editedSince(turn.chat, turn.started ?? 0) : { index: false, layers: new Set() };
}

/**
 * The turns into the sheets of the layers whose files they changed — each
 * layer given only the turns that touched it, and only the few layers most
 * worked on, since each is a small-model call. A turn that changed nothing
 * a layer owns folds into no layer at all, and a layer whose sheet the
 * turn's own session put right is left as that session left it.
 */
export function foldLayers(ctx: ServerContext, projectId: string, turns: Gathered[]): void {
  const project = ctx.store.get(projectId);
  const brief = ctx.briefs.get(projectId);
  const layers = brief.layers ?? [];
  if (!project || !layered(brief)) return;
  const touched = new Map<string, { layer: StackLayer; turns: Gathered[]; files: number }>();
  for (const turn of turns) {
    const seen = new Set<string>();
    const kept = keptItself(turn).layers;
    for (const file of turn.files) {
      const layer = layerOfFile(layers, file);
      if (!layer?.slug || !brief.layerSheets?.[layer.slug] || kept.has(layer.slug)) continue;
      const entry = touched.get(layer.slug) ?? { layer, turns: [], files: 0 };
      entry.files += 1;
      if (!seen.has(layer.slug)) entry.turns.push(turn);
      seen.add(layer.slug);
      touched.set(layer.slug, entry);
    }
  }
  const busiest = [...touched.entries()].sort((a, b) => b[1].files - a[1].files).slice(0, LAYER_FOLDS);
  for (const [slug, { layer, turns: its }] of busiest) {
    const before = brief.layerSheets![slug]!;
    foldLayerSheet(
      project.name,
      layer,
      before,
      its.map((turn) => turn.text).join("\n\n---\n\n"),
      project.path,
    )
      .then((next) => {
        if (!next) return;
        const { updated: _was, ...old } = before;
        if (JSON.stringify(next) === JSON.stringify(old)) return;
        // the user corrected the sheet while the model wrote: theirs stands
        const live = ctx.briefs.get(projectId).layerSheets?.[slug];
        if (JSON.stringify(live) !== JSON.stringify(before)) return;
        ctx.briefs.writeLayer(projectId, slug, next);
        pushSheet(ctx, projectId);
      })
      .catch(() => {});
  }
}

/** The parts of a sheet a fold of the shape can change. */
function pickShape(brief: ReturnType<ServerContext["briefs"]["get"]>) {
  return {
    description: brief.description,
    features: brief.features,
    layers: brief.layers ?? [],
    flows: brief.flows ?? [],
    layout: brief.layout ?? [],
    map: brief.map ?? [],
  };
}

/**
 * A project's `.ruri/` files brought in line with whether it is still blank
 * (server/ruriDir.ts): taken out as a prompt goes into a blank one, so a
 * scaffolder run that turn finds the folder as the user left it, and put
 * back as a turn ends, so the turn that gave the project something real is
 * the one its brief and index land with — not the next fold, minutes on.
 */
function syncProjectFiles(ctx: ServerContext, channelId: string): void {
  const project = ctx.store.findSession(channelId)?.project;
  if (!project) return;
  const blank = blankProject(project.path);
  const there = fs.existsSync(path.join(project.path, ".ruri"));
  if (blank && there) clearRuriDir(project.path);
  else if (!blank && !there) {
    writeIndexFile(project.path, ctx.components.items(project.id));
    pushSheet(ctx, project.id);
  }
}

/** A diff's path as the project names it: the transcript shows one from
 *  the project's folder name down ("ruri/web/src/…"), or whole when it is
 *  outside it — which makes it "../…" here. */
function relativeTo(owner: { name: string; path: string }, file: string): string {
  return path.isAbsolute(file) ? path.relative(owner.path, file) : projectRelative(file, owner.name);
}

/** The files other chats' edit tools changed in a stretch of time. */
function othersEdits(
  ctx: ServerContext,
  owner: { name: string; path: string; sessions: Array<{ id: string }> },
  channelId: string,
  from: number,
  to: number,
): Set<string> {
  const out = new Set<string>();
  for (const session of owner.sessions) {
    if (session.id === channelId) continue;
    for (const event of ctx.archive.events(session.id)) {
      if (event.kind === "tool" && event.diff?.path && event.ts >= from && event.ts <= to) {
        out.add(relativeTo(owner, event.diff.path));
      }
    }
  }
  return out;
}

/**
 * What a finished turn changed in its project, project-relative: the
 * difference between its two checkpoints — shell edits, generators, moves,
 * commits and merges, which the edit tools' diffs never show — less what
 * another chat's edit tools changed in the same stretch (that is theirs,
 * unless this turn's own tools touched it too). Only the edit tools' files,
 * for a project that is not a git repository. Kept beside the turn's notes,
 * for its compaction brief, recall and the layers it folds into.
 */
export async function settleTurnFiles(
  ctx: ServerContext,
  channelId: string,
  turn: { turnId: string; files?: string[]; started?: number },
): Promise<string[]> {
  const owner = ctx.store.findSession(channelId)?.project;
  if (!owner) return [];
  const edited = (turn.files ?? []).map((file) => relativeTo(owner, file)).filter((f) => !f.startsWith(".."));
  // the turn's closing checkpoint is asked for as the turn ends, in the same
  // breath as this — let it go first (server/chats.ts settleCheckpoint)
  await new Promise((resolve) => setImmediate(resolve));
  const snapped = await ctx.checkpoints.turnFiles(owner, channelId, turn.turnId).catch(() => undefined);
  let files = edited;
  if (snapped) {
    const theirs = othersEdits(ctx, owner, channelId, turn.started ?? 0, Date.now());
    const own = new Set(edited);
    files = [...new Set([...edited, ...snapped.filter((f) => own.has(f) || !theirs.has(f))])];
  }
  ctx.archive.setTurnFiles(channelId, turn.turnId, files);
  return files;
}

/** Every finished turn: its project's files, its role title, its reply's
 *  recall note, and the project's sheet folded forward. */
export function createTurnTracker(ctx: ServerContext): TurnTracker {
  return new TurnTracker((projectId, turn) => {
    syncProjectFiles(ctx, projectId);
    // the turn likely moved git — catch-up.md leads with it
    const owner = ctx.store.findSession(projectId)?.project;
    if (owner) refreshSheet(ctx, owner.id);
    if (!owner) return;
    void settleTurnFiles(ctx, projectId, turn)
      .then((files) => {
        // what it changed may be in the library, whose picture and note now
        // show it as it was
        if (files.length && ctx.components.touch(owner.id, files, turn.started ?? Date.now())) {
          pushComponents(ctx, owner.id, owner.path);
        }
        // a file it made finds its layer; one it removed is let go
        adoptFiles(ctx, owner.id, owner.path, files);
        if (smallModelEnabled()) foldBrief(ctx, projectId, { ...turn, files });
      })
      .catch((err: unknown) => warn("events", err, "settleTurnFiles"));
    if (!smallModelEnabled()) return;
    const found = ctx.store.findSession(projectId);
    if (found && !found.session.title) {
      sessionRoleTitle(turn)
        .then((title) => {
          if (!title) return;
          ctx.store.setSessionTitle(projectId, title);
          ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
        })
        .catch(() => {});
    }
    summarizeReply(turn)
      .then((note) => {
        if (note) noteSummary(ctx, projectId, turn.turnId, "reply", note);
      })
      .catch(() => {});
  });
}

/** An event with the vault's values taken back out of everything it
 *  shows — a subagent's card included: its brief, its line, its report. */
export function redacted(ctx: ServerContext, raw: TranscriptEvent): TranscriptEvent {
  if (raw.kind === "assistant" || raw.kind === "info") return { ...raw, text: ctx.secrets.redact(raw.text) };
  if (raw.kind !== "tool") return raw;
  const agent = raw.agent && {
    ...raw.agent,
    description: ctx.secrets.redact(raw.agent.description),
    ...(raw.agent.prompt ? { prompt: ctx.secrets.redact(raw.agent.prompt) } : {}),
    ...(raw.agent.activity ? { activity: ctx.secrets.redact(raw.agent.activity) } : {}),
    ...(raw.agent.result ? { result: ctx.secrets.redact(raw.agent.result) } : {}),
  };
  return { ...raw, summary: ctx.secrets.redact(raw.summary), ...(agent ? { agent } : {}) };
}

/**
 * Archive, observe, log (Home), and broadcast one transcript event.
 *
 * Anything the model produced is redacted first: a command that echoed a
 * vault value leaves the handle behind rather than the value, on screen
 * and on disk both. The user's own prompts are left exactly as typed —
 * rewinding matches a prompt against what the CLI recorded, and rewriting
 * it here would break that for the sake of a value the user chose to type.
 */
export function recordEvent(ctx: ServerContext, projectId: string, raw: TranscriptEvent): void {
  const event = redacted(ctx, raw);
  ctx.archive.append(projectId, event);
  ctx.turnTracker.observe(projectId, event);
  // a sheet opened with the session's own tools is a sheet it has read
  if (event.kind === "tool") noteToolRead(projectId, event);
  if (projectId === HOME_ID) ctx.homeLog.observe(event);
  ctx.clients.pushEvent(projectId, event);
  if (event.kind === "user") syncProjectFiles(ctx, projectId);
  // every prompt gets its recall note AND its tracker split the moment
  // it's sent — neither waits on (or survives only with) a finished turn,
  // so interrupted turns and "continue" follow-ups can't lose requests.
  // The reply's recall half lands separately when the turn finishes.
  if (event.kind === "user" && smallModelEnabled()) {
    summarizePrompt(event.text)
      .then((note) => {
        if (note) noteSummary(ctx, projectId, event.id, "user", note);
      })
      .catch(() => {});
    if (projectId !== HOME_ID) {
      extractTrackerItems(event.text, ctx.tracker.openTexts(projectId))
        .then((items) => {
          if (items.length === 0) return;
          for (const text of items) ctx.tracker.add(projectId, text, "auto", event.id);
          ctx.clients.broadcast({ type: "tracker", projectId, items: ctx.tracker.items(projectId) });
        })
        .catch(() => {});
    }
  }
}
