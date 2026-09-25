import { randomUUID } from "node:crypto";
import type { MemoryPart, TranscriptEvent } from "../shared/protocol.js";
import { memoryLineText } from "./brief.js";
import { sourceLabel } from "./catchupBrief.js";
import { harnessOfSession } from "./archive.js";
import { channelProject, ownerProject } from "./channel.js";
import { buildCatchUp, buildCompaction, relevantBlock, type BriefContext } from "./compaction.js";
import type { ServerContext } from "./context.js";
import { branchFacts, gitLines, gitStateSync } from "./gitState.js";
import { warn } from "./log.js";
import { allLines } from "./memoryLines.js";
import { exchangesOf } from "./recall.js";
import { claudeSessionGone, claudeSessionHas } from "./recent.js";
import type { LostPrompt } from "./sessions.js";

/**
 * What the app adds to a compaction brief that the transcript alone can't
 * give it (server/compaction.ts builds the brief): git's account of the
 * repo as the conversation is folded, and — when the brief goes out with
 * the next prompt — what of the conversation and the project's memory
 * bears on that prompt.
 */

/** Git's account, read now. Blocking, and meant to be: the brief must be
 *  whole before the next prompt can take it, and git answers in
 *  milliseconds. */
export function briefContext(ctx: ServerContext, channelId: string): BriefContext {
  const project = ownerProject(ctx, channelId);
  const state = project ? gitStateSync(project.path) : undefined;
  return {
    ...(project ? { projectName: project.name } : {}),
    ...(state ? { git: gitLines(state), facts: (text: string) => branchFacts(text, state) } : {}),
  };
}

const LABEL: Record<MemoryPart, string> = {
  now: "now",
  decisions: "decision",
  worked: "worked",
  failed: "didn't work",
  gotchas: "gotcha",
  open: "still open",
};

/** The brief with what bears on `prompt` added after it — or as it was,
 *  when nothing does, or anything goes wrong: the pick is a help, never a
 *  reason for the prompt not to go. */
export function withRelevance(ctx: ServerContext, channelId: string, brief: string, prompt: string): string {
  if (!brief) return brief;
  try {
    const owner = ownerProject(ctx, channelId);
    const exchanges = exchangesOf(
      channelId,
      ctx.archive.allEvents(channelId),
      ctx.archive.summaries(channelId),
      owner?.name,
    );
    const memory = owner ? ctx.briefs.get(owner.id).memory : undefined;
    const lines = memory
      ? allLines(memory)
          .filter(({ part }) => part !== "now")
          .map(({ part, line }) => {
            const ref = line.source ? sourceLabel(ctx, line.source)?.ref : undefined;
            return {
              label: LABEL[part],
              text: memoryLineText(line, ref ? { refs: { [line.id]: ref } } : {}),
            };
          })
      : [];
    return brief + relevantBlock(channelId, exchanges, lines, prompt);
  } catch (err) {
    warn("compaction", err, "withRelevance");
    return brief;
  }
}

/**
 * The conversation up to the prompt going out: everything before `current`
 * (its own exchange is the one being sent, not one to be told about), or
 * all of it when the prompt is not in the transcript yet.
 */
function conversationBefore(ctx: ServerContext, channelId: string, current?: string): TranscriptEvent[] {
  const all = ctx.archive.allEvents(channelId);
  const at = current ? all.findIndex((event) => event.id === current) : -1;
  return at === -1 ? all : all.slice(0, at);
}

/** Whether the chat has any exchange before `current` — asked of the live
 *  part first, so a new chat's first prompt reads no history. */
function hasEarlierExchange(ctx: ServerContext, channelId: string, current?: string): boolean {
  return (
    ctx.archive.events(channelId).some((event) => event.kind === "user" && event.id !== current) ||
    ctx.archive.hasHistory(channelId)
  );
}

/** A brief of the whole conversation before `current`, for a fresh session
 *  — what a /compact writes. "" when there is nothing to tell. */
function wholeBrief(ctx: ServerContext, channelId: string, current?: string): string {
  if (!hasEarlierExchange(ctx, channelId, current)) return "";
  return (
    buildCompaction(
      channelId,
      conversationBefore(ctx, channelId, current),
      ctx.archive.summaries(channelId),
      ctx.archive.digest(channelId),
      briefContext(ctx, channelId),
    )?.brief ?? ""
  );
}

/**
 * What a session that already exists has not been told: the exchanges after
 * `seen`, the last one it holds. Nothing when it holds them all — the
 * ordinary case, a chat that stayed on one harness, answered from the live
 * part alone. A session whose place in the conversation can't be found (it
 * never finished a turn, or what it saw is gone) is told the whole of it:
 * too much is a few tokens, too little is the conversation.
 */
function missedBrief(
  ctx: ServerContext,
  channelId: string,
  seen: string | undefined,
  current?: string,
): string {
  const newest = ctx.archive
    .events(channelId)
    .findLast((event) => event.kind === "user" && event.id !== current);
  if (seen !== undefined && newest?.id === seen) return "";
  if (!hasEarlierExchange(ctx, channelId, current)) return "";
  const events = conversationBefore(ctx, channelId, current);
  if (seen === undefined || !events.some((event) => event.id === seen)) {
    return wholeBrief(ctx, channelId, current);
  }
  return (
    buildCatchUp(channelId, events, ctx.archive.summaries(channelId), seen, briefContext(ctx, channelId)) ??
    ""
  );
}

/**
 * What rides in ahead of a prompt so that the session it lands in holds the
 * whole conversation — decided here, from what each harness's session is
 * recorded as holding, every time a prompt goes out.
 *
 * - The harness the prompt goes to has no session for this chat (it never
 *   ran here, or the chat let go of it — a compaction, a rewind, a session
 *   that went missing): a fresh one starts, and is told everything — the
 *   brief waiting for it, or one made now.
 * - It has one: that session is resumed, and told only what it missed — the
 *   exchanges that ran on other harnesses while the chat was away from it.
 *   Nothing, when it was there for all of them.
 *
 * Nothing here is spent until the harness has taken it: what a session holds
 * moves on only when a turn on it ends (archive.noteSeen), so a start that
 * failed, a quit or a crash before the first reply leaves the next prompt to
 * be told again. A brief waiting for a fresh session is taken either way —
 * when the session exists it is stale, and a fresh start later makes its own.
 *
 * `current` is the prompt's own event id when it is already in the
 * transcript (a split's sub-prompts, a lost start's resend). Answers the
 * brief and the harness it was made for, which is where the caller records
 * the prompt as sent (archive.noteSent).
 */
export function catchUp(
  ctx: ServerContext,
  channelId: string,
  prompt: string,
  current?: string,
): { brief: string; harness: string } {
  const project = channelProject(ctx, channelId);
  const harness = project ? ctx.manager.harnessFor(project) : "claude";
  const waiting = ctx.archive.takePendingBrief(channelId);
  const had = ctx.archive.harnessSession(channelId, harness);
  if (!had?.session) {
    const brief = waiting ?? wholeBrief(ctx, channelId, current);
    return { harness, brief: withRelevance(ctx, channelId, brief, prompt) };
  }
  return { harness, brief: missedBrief(ctx, channelId, had.seen, current) };
}

/** A harness's name, as a line in the transcript says it. */
function harnessLabel(harness: string): string {
  const known: Record<string, string> = {
    claude: "Claude",
    codex: "Codex",
    opencode: "OpenCode",
    gemini: "Gemini",
    goose: "Goose",
  };
  return known[harness] ?? harness;
}

/**
 * Before a prompt goes to a chat that has no Claude process up — so the
 * prompt will resume the chat's Claude session, maybe at a rewind's fork
 * point — check both are there in Claude's own transcripts. A session that
 * isn't (a fork that failed as it started, a pruned file) or a fork point
 * that isn't in it used to fail the prompt, and every prompt after it, with
 * "No conversation found" or "No message found with message.uuid". Now the
 * chat lets go of it and starts a fresh session with a brief of the
 * conversation, the way a /compact would, and says so.
 */
export function checkResumable(ctx: ServerContext, channelId: string): void {
  const channel = channelProject(ctx, channelId);
  // another harness's sessions aren't Claude's to find
  if (!channel || ctx.manager.harnessFor(channel) !== "claude") return;
  if (ctx.manager.live(channelId, "claude")) return;
  const sessionId = ctx.archive.sessionOn(channelId, "claude");
  if (!sessionId) return;
  const project = ownerProject(ctx, channelId);
  if (!project) return;
  const point = ctx.archive.resumePoint(channelId);
  const gone = claudeSessionGone(project.path, sessionId);
  const lost =
    !gone && point?.session === sessionId && claudeSessionHas(project.path, sessionId, point.uuid) === false;
  if (!gone && !lost) return;
  warn(
    "sessions",
    new Error(
      gone ? `session ${sessionId} is gone` : `fork point ${point!.uuid} isn't in session ${sessionId}`,
    ),
    "checkResumable",
  );
  letGo(
    ctx,
    channelId,
    "claude",
    gone ? goneLine(harnessLabel("claude")) : lostPointLine(harnessLabel("claude")),
  );
}

const goneLine = (label: string) =>
  `the ${label} session this chat was on is gone, so this prompt starts a fresh one, briefed on the conversation`;
const lostPointLine = (label: string) =>
  `the point this chat was rewound to isn't in its ${label} session, so this prompt starts a fresh one, briefed on the conversation`;

/**
 * Let go of the chat's session on one harness: the next prompt there starts
 * a fresh one, told the whole conversation (catchUp), and the transcript
 * says why. Its sessions on other harnesses are left as they are.
 *
 * The process goes too. One that died holding the old id — a start that
 * failed, a crash — stays in the manager's hands until something replaces
 * it; the manager asks the archive before it resumes anything now, but a
 * process still up would take the next prompt as it is.
 */
function letGo(ctx: ServerContext, channelId: string, harness: string, why: string): void {
  ctx.manager.dispose(channelId);
  ctx.archive.dropHarness(channelId, harness);
  const event: TranscriptEvent = { kind: "info", id: randomUUID(), text: why, ts: Date.now() };
  ctx.archive.append(channelId, event);
  ctx.clients.pushEvent(channelId, event);
}

/**
 * A resume the check above let through failed anyway (SessionEvents.
 * onLostStart): the session or its fork point wasn't there by the time the
 * harness looked, or the check couldn't tell (every harness but Claude). The
 * prompts it was given go again, word for word, to a fresh session briefed
 * on the conversation — the turn carries on as if it had started there,
 * rather than ending in "No conversation found" with every prompt after it
 * headed the same way.
 */
export function recoverLostStart(
  ctx: ServerContext,
  channelId: string,
  sessionId: string,
  lost: "session" | "point",
  prompts: LostPrompt[],
): void {
  warn("sessions", new Error(`session ${sessionId} could not be resumed (${lost})`), "recoverLostStart");
  const harness = harnessOfSession(sessionId);
  const label = harnessLabel(harness);
  letGo(ctx, channelId, harness, lost === "point" ? lostPointLine(label) : goneLine(label));
  const project = channelProject(ctx, channelId);
  if (!project) return;
  prompts.forEach((prompt, i) => {
    let text = prompt.text;
    if (i === 0) {
      const { brief, harness: to } = catchUp(ctx, channelId, prompt.text, prompt.eventId);
      text = brief + prompt.text;
      if (prompt.eventId) ctx.archive.noteSent(channelId, to, prompt.eventId);
    }
    ctx.manager.send(project, text, prompt.images, undefined, true, prompt.eventId);
  });
}
