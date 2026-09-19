/**
 * One transcript event's way in: redacted, archived, observed, pushed to the
 * windows — and the small-model work every prompt and finished turn sets
 * off (recall notes, tracker items, the catch-up brief, the role title).
 */
import type { TranscriptEvent } from "../shared/protocol.js";
import { writeCatchupFile } from "./brief.js";
import type { ServerContext } from "./context.js";
import { HOME_ID } from "./manager.js";
import { noteSummary } from "./notes.js";
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
// The catch-up brief writes itself: each finished turn is folded in, and
// most turns change nothing — a fix or a polish pass is not a feature.
export function foldBrief(
  ctx: ServerContext,
  channelId: string,
  turn: { user: string; assistant: string },
): void {
  if (channelId === HOME_ID) return;
  const project = ctx.store.findSession(channelId)?.project;
  if (!project) return;
  const current = ctx.briefs.get(project.id);
  updateBrief(
    project.name,
    { description: current.description, features: current.features },
    `The user asked:\n${turn.user}\n\nWhat the agent did:\n${turn.assistant}`,
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

/** Every finished turn: its role title, its reply's recall note, and the
 *  catch-up brief folded forward. */
export function createTurnTracker(ctx: ServerContext): TurnTracker {
  return new TurnTracker((projectId, turn) => {
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
