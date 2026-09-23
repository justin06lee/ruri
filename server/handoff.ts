import { randomUUID } from "node:crypto";
import type { MemoryPart, TranscriptEvent } from "../shared/protocol.js";
import { memoryLineText } from "./brief.js";
import { sourceLabel } from "./catchupBrief.js";
import { ownerProject } from "./channel.js";
import { buildCompaction, relevantBlock, type BriefContext } from "./compaction.js";
import type { ServerContext } from "./context.js";
import { branchFacts, gitLines, gitStateSync } from "./gitState.js";
import { warn } from "./log.js";
import { allLines } from "./memoryLines.js";
import { exchangesOf } from "./recall.js";
import { claudeSessionGone, claudeSessionHas } from "./recent.js";

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
 * Before a prompt goes to a chat that has no process up — so the prompt
 * will resume the chat's Claude session, maybe at a rewind's fork point —
 * check both are there in Claude's own transcripts. A session that isn't
 * (a fork that failed as it started, a pruned file) or a fork point that
 * isn't in it used to fail the prompt, and every prompt after it, with
 * "No conversation found" or "No message found with message.uuid". Now the
 * chat lets go of it and starts a fresh session with a brief of the
 * conversation, the way a /compact would, and says so.
 */
export function checkResumable(ctx: ServerContext, channelId: string): void {
  if (ctx.manager.live(channelId)) return;
  const sessionId = ctx.archive.lastSessionId(channelId);
  // another harness's sessions aren't Claude's to find
  if (!sessionId || sessionId.includes(":")) return;
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
  ctx.archive.clearLastSessionId(channelId);
  if (!ctx.archive.hasPendingBrief(channelId)) {
    const built = buildCompaction(
      channelId,
      ctx.archive.allEvents(channelId),
      ctx.archive.summaries(channelId),
      ctx.archive.digest(channelId),
      briefContext(ctx, channelId),
    );
    if (built) ctx.archive.setPendingBrief(channelId, built.brief);
  }
  const event: TranscriptEvent = {
    kind: "info",
    id: randomUUID(),
    text: gone
      ? "the Claude session this chat was on is gone, so this prompt starts a fresh one, briefed on the conversation"
      : "the point this chat was rewound to isn't in its Claude session, so this prompt starts a fresh one, briefed on the conversation",
    ts: Date.now(),
  };
  ctx.archive.append(channelId, event);
  ctx.clients.pushEvent(channelId, event);
}
