/**
 * One transcript event's way in: redacted, archived, observed, pushed to the
 * windows — and the small-model work every prompt and finished turn sets
 * off (recall notes, tracker items, the project's sheet, the role title).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import {
  exchangeRef,
  pushSheet,
  rebuildCatchup,
  refreshSheet,
  resolveRef,
  shapeless,
} from "./catchupBrief.js";
import { writeIndexFile } from "./components.js";
import { pushComponents } from "./handlers/components.js";
import type { ServerContext } from "./context.js";
import { HOME_ID } from "./manager.js";
import { rebuildMemory } from "./memory.js";
import { dayOf, rebase } from "./memoryLines.js";
import { projectRelative } from "./recall.js";
import { noteSummary } from "./notes.js";
import { blankProject, clearRuriDir } from "./ruriDir.js";
import {
  endsIntact,
  extractTrackerItems,
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

const gathering = new Map<string, { turns: string[]; timer?: NodeJS.Timeout; last: number }>();

/** One finished turn, for the sheet to take in with the others — opening
 *  with its ref, so a line the model learns from it can say where. */
export function foldBrief(
  ctx: ServerContext,
  channelId: string,
  turn: { turnId?: string; user: string; assistant: string; files?: string[] },
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
  const changed = (turn.files ?? []).map((file) => projectRelative(file, project.name));
  const files = changed.length ? `\n\nFiles it changed: ${changed.slice(0, 30).join(", ")}` : "";
  held.turns.push(
    `[${tag}]${chat} The user asked:\n${turn.user.slice(0, BRIEF_USER_CHARS)}\n\n` +
      `What the agent did and said:\n${endsIntact(turn.assistant, BRIEF_REPLY_CHARS)}${files}`,
  );
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
  const happened = turns.join("\n\n---\n\n");
  const current = ctx.briefs.get(project.id);

  // A sheet from before layers and flows is drawn whole from the repo
  // once, rather than folded forward from a shape that has none.
  if (shapeless(ctx, project.id) && current.description) void rebuildCatchup(ctx, project.id);
  else {
    updateShape(project.name, pickShape(current), happened, project.path)
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
  foldMemory(project.name, before, happened, dayOf(), (ref) => resolveRef(ctx, project.id, ref))
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

/** Every finished turn: its project's files, its role title, its reply's
 *  recall note, and the project's sheet folded forward. */
export function createTurnTracker(ctx: ServerContext): TurnTracker {
  return new TurnTracker((projectId, turn) => {
    syncProjectFiles(ctx, projectId);
    // the turn likely moved git — catch-up.md leads with it
    const owner = ctx.store.findSession(projectId)?.project;
    if (owner) refreshSheet(ctx, owner.id);
    // what it edited may be in the library, whose picture and note now
    // show it as it was
    if (owner && turn.files?.length) {
      // diffs name a file from the project's folder name down
      // ("ruri/web/src/…"), or whole when it is outside it
      const files = turn.files.map((file) =>
        path.isAbsolute(file) ? path.relative(owner.path, file) : projectRelative(file, owner.name),
      );
      if (ctx.components.touch(owner.id, files, turn.started ?? Date.now())) {
        pushComponents(ctx, owner.id, owner.path);
      }
    }
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
    foldBrief(ctx, projectId, turn);
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
