/**
 * Going back: a rewind (conversation and files, to just before a prompt
 * ran, the prompt back in the composer). Each harness gets the truest
 * version it can — a native fork back to the kept exchange where there is
 * one, ruri's own checkpoint and a brief of what is kept where there is
 * not.
 */
import { WebSocket } from "ws";
import type { ServerMessage, TranscriptEvent } from "../../shared/protocol.js";
import { busy, channelProject } from "../channel.js";
import { pushTranscript } from "../clients.js";
import { buildCompaction } from "../compaction.js";
import type { ServerContext } from "../context.js";
import { briefContext } from "../handoff.js";
import { errorMessage } from "../log.js";
import { HOME_ID } from "../manager.js";
import { promptChain } from "../sessions.js";
import type { RewindReport } from "../checkpoints.js";
import { restoreContext } from "../turns.js";
import type { Handlers } from "./types.js";

/**
 * The words for what a rewind did with the files and the repository —
 * nothing when all it did was the obvious (the files went back), a clause
 * for anything worth knowing: a branch moved back, a tag taken away, a
 * file something else had also changed, a ref left alone and why.
 */
function describe(report: RewindReport, channelId: string): string[] {
  const short = (name: string) => name.replace(/^refs\/(heads|tags)\//, "");
  const parts: string[] = [];
  if (report.head) parts.push(`back on ${short(report.head)}`);
  for (const ref of report.refs) {
    const tag = ref.name.startsWith("refs/tags/");
    if (!ref.to) parts.push(`${tag ? "tag" : "branch"} ${short(ref.name)} taken away`);
    else if (ref.commits > 0)
      parts.push(`${short(ref.name)} back ${ref.commits} commit${ref.commits === 1 ? "" : "s"}`);
    else parts.push(`${tag ? "tag " : ""}${short(ref.name)} put back`);
  }
  const kept = (why: RewindReport["kept"][number]["why"]) => [
    ...new Set(report.kept.filter((k) => k.why === why).map((k) => short(k.name))),
  ];
  const pushed = kept("pushed");
  if (pushed.length)
    parts.push(`${pushed.join(", ")} left where it is — its new commits are on a remote already`);
  const moved = kept("moved");
  if (moved.length) parts.push(`${moved.join(", ")} left where it is — it has moved on since`);
  const busyHere = kept("worktree");
  if (busyHere.length) parts.push(`${busyHere.join(", ")} left alone — another worktree has it checked out`);
  if (report.conflicts.length) {
    const names = report.conflicts.slice(0, 3).join(", ");
    const more = report.conflicts.length > 3 ? ` and ${report.conflicts.length - 3} more` : "";
    const one = report.conflicts.length === 1;
    parts.push(
      `${names}${more} put back whole — something else had changed ${one ? "it" : "them"} since, ` +
        `and what ${one ? "it" : "they"} held is kept at refs/ruri/${channelId}/undo`,
    );
  }
  return parts;
}

/**
 * Put the project back as it was before the discarded prompts ran: their
 * turns' changes taken out of the files, and the branches and tags they
 * moved put back where that is safe (server/checkpoints.ts) — from ruri's
 * own checkpoints, which see everything a turn did, the shell included.
 * Only where ruri has none (a project that is not a git repository) does
 * Claude's own file checkpoint stand in, for the files its edits touched.
 * Answers what to tell the user, and whether the files went back at all.
 */
async function putBack(
  ctx: ServerContext,
  channelId: string,
  project: { path?: string } | undefined,
  discarded: string[],
  claudeFiles?: () => Promise<{ canRewind: boolean; error?: string }>,
): Promise<{ parts: string[]; restored: boolean }> {
  if (channelId === HOME_ID || !project?.path) {
    return { parts: ["there were no files to put back"], restored: false };
  }
  const report = await ctx.checkpoints.rewind({ path: project.path }, channelId, discarded);
  if (!report.error) return { parts: describe(report, channelId), restored: true };
  if (claudeFiles && (await claudeFiles()).canRewind) return { parts: [], restored: true };
  return { parts: [`the files were left as they are — ${report.error}`], restored: false };
}

/**
 * A rewound prompt goes back to the composer whole: the words, and every
 * file that was clipped to them — the archive still holds the bytes, and
 * the boxes drawn on the images ride the attachment record, so the strip
 * comes back exactly as it was sent.
 */
function composeBack(channelId: string, target: Extract<TranscriptEvent, { kind: "user" }>): ServerMessage {
  return {
    type: "compose",
    projectId: channelId,
    text: target.text,
    ...(target.attachments?.length ? { attachments: target.attachments } : {}),
  };
}

export const rewindHandlers = {
  rewind: (ctx, ws, msg) => {
    // Everything back to just before this prompt ran, and the prompt back
    // in the composer — nothing is sent for you.
    //
    // - The conversation: resumed at the exchange before the prompt where
    //   the harness can fork there (Claude's session file, a native
    //   provider thread), so the model holds exactly what is on screen;
    //   otherwise retired, and the next prompt re-seeds a fresh session
    //   with a brief of everything kept (what /compact writes). With
    //   nothing kept at all, the next prompt simply starts afresh.
    // - The files and the repository: what the discarded turns did, taken
    //   back out (putBack).
    // - The context gauge: what the conversation now holds — the reading
    //   taken when the kept exchange was over, or empty for a fresh start.
    // - The transcript, its notes, the tracker items split from the
    //   discarded prompts, and their checkpoints: gone with them.
    const channelId = msg.projectId;
    const eventId = msg.eventId;
    void (async () => {
      try {
        if (busy(ctx, channelId)) throw new Error("stop the running turn first");
        const events = ctx.archive.allEvents(channelId);
        const idx = events.findIndex((e) => e.id === eventId);
        const target = idx >= 0 ? events[idx] : undefined;
        if (!target || target.kind !== "user") throw new Error("that prompt is gone");
        const project = channelProject(ctx, channelId);
        if (!project) throw new Error("unknown session");
        const kept = events.slice(0, idx);
        const discarded = events.slice(idx).flatMap((e) => (e.kind === "user" ? [e.id] : []));
        const keptHasContext = kept.some((e) => e.kind === "user" || e.kind === "compaction");
        const lastKept = kept.findLast((e) => e.kind === "user");
        // A compaction after the prompt means the session running now began
        // at that boundary: it holds nothing to fork at, and the brief is
        // the only honest way back.
        const compactedSince = events.some((e, i) => i > idx && e.kind === "compaction");
        // the harness the chat is on now, and its session there: that is
        // the conversation a rewind takes back (a chat that has moved
        // between harnesses has one on each — see below for the others)
        const harness = ctx.manager.harnessFor(project);
        const claude = harness === "claude";
        const sessionId = ctx.archive.sessionOn(channelId, harness);

        // Where the conversation can resume. From the chain map when a turn
        // recorded it — only this harness's turns, whose ids its own record
        // knows; the scan stops at a compaction, where a different session
        // began — and on Claude from the session's own transcript, which is
        // where it comes from nowadays (the SDK stopped echoing prompts, so
        // the chain is usually empty).
        const chain = ctx.archive.chain(channelId);
        const ours = (id: string) => (chain[id]?.harness ?? harness) === harness;
        let resumeAt: string | undefined;
        let userUuid: string | undefined;
        let contextBefore: number | undefined;
        let chained: string | undefined;
        /** The exchange whose chain point that is — the last the fork holds. */
        let chainedFrom: string | undefined;
        if (!compactedSince) {
          for (let i = idx - 1; i >= 0; i--) {
            const ev = events[i]!;
            if (ev.kind === "compaction") break;
            if (ev.kind === "user" && chain[ev.id]?.last && ours(ev.id)) {
              chained = chain[ev.id]!.last;
              chainedFrom = ev.id;
              break;
            }
          }
          if (claude) {
            // `ordinal` picks between prompts sent with identical text
            const ordinal = kept.filter(
              (e) => e.kind === "user" && e.text.trim() === target.text.trim(),
            ).length;
            const found = sessionId ? await promptChain(project, sessionId, target.text, ordinal) : undefined;
            userUuid = found?.user ?? (ours(eventId) ? chain[eventId]?.user : undefined);
            // the session's own transcript first: it can only name a point in
            // that session, where the chain map (which records no session)
            // can name one in a session the chat has since left
            resumeAt = found?.before ?? chained;
            if (found?.before) chainedFrom = undefined;
            contextBefore = found?.contextBefore;
          } else resumeAt = chained;
        }
        const canFork = !compactedSince && (claude || ctx.models.registry.canForkSession(harness));
        const mode: "fork" | "fresh" | "brief" = !keptHasContext
          ? "fresh"
          : canFork && resumeAt && sessionId
            ? "fork"
            : "brief";

        // The files first, while the session is still there: Claude's own
        // checkpoints live in its process, and are the stand-in where ruri
        // has none of its own.
        const files = await putBack(
          ctx,
          channelId,
          project,
          discarded,
          claude && userUuid && !compactedSince
            ? () => ctx.manager.rewindFiles(project, userUuid)
            : undefined,
        );

        ctx.manager.dispose(channelId);
        // Every harness's session, made to hold what is kept and no more.
        // This harness's forks back to the kept exchange where it can — it
        // then holds the conversation through the last kept exchange it ran
        // itself, and is caught up on any kept ones that ran elsewhere — and
        // is let go of where it can't. Another harness's session is kept
        // only if nothing the rewind takes out ever went to it; one that may
        // hold a discarded exchange is let go of, and starts afresh from a
        // brief when the chat goes back to it.
        const keptPrompts = new Set(kept.flatMap((e) => (e.kind === "user" ? [e.id] : [])));
        if (mode === "fresh") ctx.archive.clearLastSessionId(channelId);
        else {
          if (mode === "fork") {
            ctx.archive.setResumeAt(channelId, sessionId!, resumeAt!);
            // a point from the chain map is the end of that exchange; one
            // from Claude's own record is just before the rewound prompt,
            // so the fork holds every kept exchange that went to Claude
            const tagged = kept.some((e) => e.kind === "user" && chain[e.id]?.harness !== undefined);
            const ranHere = kept.findLast((e) => e.kind === "user" && chain[e.id]?.harness === harness);
            ctx.archive.rewoundTo(channelId, harness, chainedFrom ?? (tagged ? ranHere?.id : lastKept?.id));
          } else ctx.archive.dropHarness(channelId, harness);
          for (const [other, held] of Object.entries(ctx.archive.harnessSessions(channelId))) {
            if (other === harness) continue;
            const newest = held.sent ?? held.seen;
            if (newest === undefined || !keptPrompts.has(newest)) ctx.archive.dropHarness(channelId, other);
          }
        }
        const removed = ctx.archive.truncateFrom(channelId, eventId);
        if (removed.length > 0) {
          ctx.clients.broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
          pushTranscript(ctx, channelId);
          // items are tied to the prompts they were split from — the
          // rewound prompt's items (and every discarded later prompt's)
          // go too; the edited prompt re-extracts fresh ones on send
          if (ctx.tracker.removeForTurns(channelId, removed)) {
            ctx.clients.broadcast({
              type: "tracker",
              projectId: channelId,
              items: ctx.tracker.items(channelId),
            });
          }
          // the prompt itself keeps its checkpoint while it sits in the
          // composer; sending it again is a new prompt with a new one
          if (project.path) {
            void ctx.checkpoints.forget(
              project,
              channelId,
              removed.filter((id) => id !== eventId),
            );
          }
        }
        // the brief covers what survived the truncation — the harness comes
        // back knowing that and nothing after it; a fork or a fresh start
        // must not have any brief left from before ride along
        const brief =
          mode === "brief"
            ? buildCompaction(
                channelId,
                ctx.archive.allEvents(channelId),
                ctx.archive.summaries(channelId),
                ctx.archive.digest(channelId),
                briefContext(ctx, channelId),
              )?.brief
            : undefined;
        ctx.archive.setPendingBrief(channelId, brief ?? "");
        const tokens =
          mode === "fork"
            ? ((lastKept && ctx.archive.contextAfter(channelId, lastKept.id)) ?? contextBefore ?? 0)
            : 0;
        restoreContext(ctx, channelId, tokens);
        ctx.clients.broadcast({ type: "status", projectId: channelId, status: "idle" });

        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify(composeBack(channelId, target)));
        const parts = [
          ...files.parts,
          ...(mode === "brief" ? ["the harness restarts from a brief of what's kept"] : []),
        ];
        if (parts.length > 0) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: `rewound — ${parts.join("; ")}`,
            } satisfies ServerMessage),
          );
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: `rewind failed: ${errorMessage(err)}`,
            } satisfies ServerMessage),
          );
        }
      }
    })();
  },
} satisfies Partial<Handlers>;
