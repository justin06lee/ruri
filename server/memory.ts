/**
 * A project's working memory written whole, from its chats.
 *
 * The memory (`.ruri/catchup.md`: what was decided and why, what worked,
 * what was tried and failed and why, the traps, what is still open)
 * usually writes itself a few turns at a time (server/events.ts). That is
 * no help to a project that already has months of chats in it: none of
 * what they found out is in the memory until somebody runs into it again.
 * This is the other door — read every chat in the project the way the
 * compaction brief reads one, and have the small model write the memory
 * in one go. It runs by itself the first time a project with history
 * folds a turn and has no memory yet, and whenever the user asks.
 *
 * It reads what ruri already keeps rather than the raw transcripts: each
 * chat's digest (the condensed memory of its oldest exchanges), the recall
 * notes of its recent ones, and the last few replies at more length —
 * those are where an agent says what it tried, what broke and why.
 */
import type { ProjectMemory } from "../shared/protocol.js";
import { assembleTurns, endsIntact, foldMemory, smallModelEnabled } from "./smallmodel.js";
import { exchangeRef, pushSheet, resolveRef } from "./catchupBrief.js";
import { dayOf, MEMORY_PARTS, rebase } from "./memoryLines.js";
import type { ServerContext } from "./context.js";
import { warn } from "./log.js";

/** Exchanges read per chat, newest kept. */
const EXCHANGES_PER_CHAT = 30;
/** How many of a chat's last replies are read at length, and how much. */
const FULL_REPLIES = 5;
const REPLY_CHARS = 1500;
/** The whole reading, at most — the oldest chats give way first. */
const BUDGET = 40_000;

/** A note's stand-in when the small model never wrote one. */
function squash(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const day = dayOf;

/** Everything the memory is written from: one block per chat, the chat
 *  least recently at work first, so the newest is what the model reads
 *  last. "" when there is nothing to read. */
export function memoryMaterial(ctx: ServerContext, projectId: string): string {
  const project = ctx.store.get(projectId);
  if (!project) return "";
  const chats = project.sessions.flatMap((session) => {
    const turns = assembleTurns(ctx.archive.allEvents(session.id)).filter((t) => t.finished);
    if (turns.length === 0) return [];
    const notes = ctx.archive.summaries(session.id);
    const digest = ctx.archive.digest(session.id);
    const recent = turns.slice(-EXCHANGES_PER_CHAT);
    const start = turns.length - recent.length;
    const parts = [
      `=== CHAT: ${session.title || "untitled"} (its exchanges' refs start ${session.id.slice(0, 8)}; last at work ${day(recent.at(-1)!.ts)}) ===`,
    ];
    if (digest?.text && start > 0) parts.push(`Its earlier exchanges, condensed:\n${digest.text.trim()}`);
    parts.push(
      "Its exchanges, oldest first:",
      ...recent.map(({ turn, ts }, i) => {
        const note = notes[turn.turnId];
        return `[${exchangeRef(session.id, start + i + 1)} · ${day(ts)}] user: ${note?.user?.trim() || squash(turn.user)}\n   agent: ${note?.reply?.trim() || squash(turn.assistant)}`;
      }),
    );
    const full = recent
      .map((entry, i) => ({ ...entry, n: start + i + 1 }))
      .slice(-FULL_REPLIES)
      .filter(({ turn }) => turn.assistant.trim());
    if (full.length) {
      parts.push(
        "Its last replies, at more length:",
        ...full.map(
          ({ turn, ts, n }) =>
            `[${exchangeRef(session.id, n)} · ${day(ts)}] ${endsIntact(turn.assistant.trim(), REPLY_CHARS)}`,
        ),
      );
    }
    return [{ last: recent.at(-1)!.ts, text: parts.join("\n") }];
  });
  chats.sort((a, b) => a.last - b.last);
  // within the budget, keeping the chats most recently at work
  const kept: string[] = [];
  let used = 0;
  for (const chat of [...chats].reverse()) {
    if (used + chat.text.length > BUDGET && kept.length > 0) break;
    kept.unshift(chat.text.slice(0, BUDGET));
    used += chat.text.length;
  }
  return kept.join("\n\n");
}

function recallNote(ctx: ServerContext, projectId: string, busy: boolean, note?: string): void {
  ctx.clients.broadcast({ type: "recall", projectId, busy, ...(note ? { note } : {}) });
}

/** What a rewrite from the chats starts from: the lines the model doesn't
 *  own — the user's, the agents', whatever the user pinned. The model's
 *  own it writes again from the whole history. */
function keptThroughRewrite(memory: ProjectMemory | undefined): ProjectMemory | undefined {
  if (!memory) return undefined;
  return Object.fromEntries(
    MEMORY_PARTS.map((part) => [
      part,
      part === "now" ? [] : memory[part].filter((line) => line.by !== "model" || line.pinned),
    ]),
  ) as unknown as ProjectMemory;
}

/** Write a project's memory from its chats, replacing the small model's
 *  own lines; the user's, the agents' and the pinned stay. */
export async function rebuildMemory(ctx: ServerContext, projectId: string): Promise<void> {
  const project = ctx.store.get(projectId);
  if (!project || ctx.recalling.has(projectId) || !smallModelEnabled()) return;
  ctx.recalling.add(projectId);
  recallNote(ctx, projectId, true, "reading the chats…");
  try {
    const material = memoryMaterial(ctx, projectId);
    if (!material) {
      recallNote(ctx, projectId, false, "no finished work in any chat yet");
      return;
    }
    const before = keptThroughRewrite(ctx.briefs.get(projectId).memory);
    const folded = await foldMemory(project.name, before, material, day(Date.now()), (ref) =>
      resolveRef(ctx, projectId, ref),
    );
    const memory = folded && rebase(folded, before, keptThroughRewrite(ctx.briefs.get(projectId).memory));
    if (!memory) {
      recallNote(ctx, projectId, false, "the memory could not be written — try again");
      return;
    }
    ctx.briefs.remember(projectId, memory, true);
    pushSheet(ctx, projectId);
    recallNote(ctx, projectId, false, "written from the chats");
  } catch (err) {
    warn("memory", err, "rebuildMemory");
    recallNote(ctx, projectId, false, "the memory could not be written — try again");
  } finally {
    ctx.recalling.delete(projectId);
  }
}
