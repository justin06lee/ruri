/**
 * One transcript event's way in: redacted, archived, observed, pushed to the
 * windows — and the small-model work every prompt and finished turn sets
 * off (recall notes, tracker items, the catch-up brief, the role title).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { writeCatchupFile } from "./brief.js";
import { writeIndexFile } from "./components.js";
import type { ServerContext } from "./context.js";
import { HOME_ID } from "./manager.js";
import { noteSummary } from "./notes.js";
import { blankProject, clearRuriDir } from "./ruriDir.js";
import {
  extractTrackerItems,
  sessionRoleTitle,
  smallModelEnabled,
  summarizePrompt,
  summarizeReply,
  TurnTracker,
  updateBrief,
} from "./smallmodel.js";

// Every finished turn goes to the small model in the background for a
// reply recall note (instant compaction). Failures are silent — a nicety.

/**
 * How often a project's catch-up brief takes in what its turns did. The
 * brief writes itself from finished turns, and most turns change nothing
 * in it — a fix or a polish pass is not a feature — yet each fold is a
 * small-model call: a whole CLI process for several seconds. Ten agents
 * working in one project used to mean ten of those a round. Now a
 * project's first finished turn folds at once, and the turns after it
 * gather and fold together, at most once a window.
 */
const BRIEF_EVERY_MS = Number(process.env["RURI_BRIEF_EVERY_MS"]) || 10 * 60_000;
/** The turns a fold takes, newest kept — and how much of each. */
const BRIEF_TURNS = 5;
const BRIEF_USER_CHARS = 600;
const BRIEF_REPLY_CHARS = 1_000;

const gathering = new Map<string, { turns: string[]; timer?: NodeJS.Timeout; last: number }>();

/** One finished turn, for the brief to take in with the others. */
export function foldBrief(
  ctx: ServerContext,
  channelId: string,
  turn: { user: string; assistant: string },
): void {
  if (channelId === HOME_ID) return;
  const project = ctx.store.findSession(channelId)?.project;
  if (!project) return;
  const held = gathering.get(project.id) ?? { turns: [], last: 0 };
  gathering.set(project.id, held);
  held.turns.push(
    `The user asked:\n${turn.user.slice(0, BRIEF_USER_CHARS)}\n\n` +
      `What the agent did:\n${turn.assistant.slice(0, BRIEF_REPLY_CHARS)}`,
  );
  if (held.turns.length > BRIEF_TURNS) held.turns.splice(0, held.turns.length - BRIEF_TURNS);
  if (held.timer) return;
  held.timer = setTimeout(
    () => foldGathered(ctx, project.id),
    Math.max(0, held.last + BRIEF_EVERY_MS - Date.now()),
  );
  held.timer.unref?.();
}

/** What a project's turns did since the last fold, into its brief. */
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
  const current = ctx.briefs.get(project.id);
  updateBrief(
    project.name,
    { description: current.description, features: current.features },
    turns.join("\n\n---\n\n"),
  )
    .then((next) => {
      if (!next) return;
      if (
        next.description === current.description &&
        next.features.join("\n") === current.features.join("\n")
      ) {
        return;
      }
      writeCatchupFile(project.path, project.name, ctx.briefs.write(project.id, next));
    })
    .catch(() => {});
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
    writeCatchupFile(project.path, project.name, ctx.briefs.get(project.id));
  }
}

/** Every finished turn: its project's files, its role title, its reply's
 *  recall note, and the catch-up brief folded forward. */
export function createTurnTracker(ctx: ServerContext): TurnTracker {
  return new TurnTracker((projectId, turn) => {
    syncProjectFiles(ctx, projectId);
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
