import type { MemoryPart } from "../shared/protocol.js";
import { memoryLineText } from "./brief.js";
import { sourceLabel } from "./catchupBrief.js";
import { ownerProject } from "./channel.js";
import { relevantBlock, type BriefContext } from "./compaction.js";
import type { ServerContext } from "./context.js";
import { branchFacts, gitLines, gitStateSync } from "./gitState.js";
import { warn } from "./log.js";
import { allLines } from "./memoryLines.js";
import { exchangesOf } from "./recall.js";

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
