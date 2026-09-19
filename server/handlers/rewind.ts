/**
 * Going back: a rewind (conversation and files, to just before a prompt
 * ran, the prompt back in the composer) and a fork (a new session holding
 * everything through a prompt's exchange). Each harness gets the truest
 * version it can — a native fork where there is one, ruri's own
 * checkpoint and a brief of what is kept where there is not.
 */
import { WebSocket } from "ws";
import type { ServerMessage, TranscriptEvent } from "../../shared/protocol.js";
import { busy, channelProject } from "../channel.js";
import { pushTranscript } from "../clients.js";
import { buildCompaction } from "../compaction.js";
import type { ServerContext } from "../context.js";
import { errorMessage } from "../log.js";
import { HOME_ID } from "../manager.js";
import { promptChain } from "../sessions.js";
import { contextWindow, resetContext } from "../turns.js";
import type { Handlers } from "./types.js";

/**
 * Rewind a session running on a non-Claude harness.
 *
 * Those harnesses cannot fork a conversation at a message, so this rewinds
 * what ruri owns: the transcript truncates, the live session is retired,
 * and the next prompt re-seeds a fresh one with a brief of everything kept
 * — so what the model knows matches what is on screen.
 *
 * The files go back too, from ruri's own checkpoint of the moment before
 * the prompt ran (see checkpoints.ts). That is what makes a rewind here
 * the same move it is on Claude rather than a conversation-only apology.
 * A project that is not a git repository has no checkpoint, and the reply
 * says so instead of implying the files moved.
 */
async function rewindOnHarness(
  ctx: ServerContext,
  ws: WebSocket,
  channelId: string,
  target: Extract<TranscriptEvent, { kind: "user" }>,
  why?: string,
): Promise<void> {
  const eventId = target.id;
  const project = channelProject(ctx, channelId);
  const failed =
    channelId === HOME_ID || !project?.path
      ? "there are no files to put back"
      : await ctx.checkpoints.restore(project, channelId, eventId);
  why ??= failed
    ? `the files were left as they are — ${failed} — and it restarts from a brief of what's kept`
    : "the files went back with it, and the harness restarts from a brief of what's kept";
  ctx.manager.dispose(channelId);
  ctx.archive.clearLastSessionId(channelId);
  const removed = ctx.archive.truncateFrom(channelId, eventId);
  if (removed.length > 0) {
    ctx.clients.broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
    pushTranscript(ctx, channelId);
    if (ctx.tracker.removeForTurns(channelId, removed)) {
      ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: ctx.tracker.items(channelId) });
    }
    // the prompt itself keeps its checkpoint: it is back in the composer,
    // and sending it again is a new prompt with a new one
    if (project?.path) void ctx.checkpoints.forget(project, channelId, removed.filter((id) => id !== eventId));
  }
  // the brief covers what survived the truncation — the harness comes back
  // knowing that and nothing after it
  const kept = buildCompaction(
    channelId,
    ctx.archive.allEvents(channelId),
    ctx.archive.summaries(channelId),
    ctx.archive.digest(channelId),
  );
  // nothing survived: the next prompt opens a genuinely new session, so
  // any brief left from before must not ride along
  ctx.archive.setPendingBrief(channelId, kept?.brief ?? "");
  resetContext(ctx, channelId);
  ctx.clients.broadcast({ type: "status", projectId: channelId, status: "idle" });
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(composeBack(channelId, target)));
  ws.send(
    JSON.stringify({
      type: "error",
      message: `rewound the conversation — ${why}`,
    } satisfies ServerMessage),
  );
}

/** Restore ruri's file checkpoint and retain the provider's real context. */
async function rewindOnNativeProvider(
  ctx: ServerContext,
  ws: WebSocket,
  channelId: string,
  target: Extract<TranscriptEvent, { kind: "user" }>,
  resumeAt?: string,
): Promise<void> {
  const project = channelProject(ctx, channelId);
  const failed = project?.path
    ? await ctx.checkpoints.restore(project, channelId, target.id)
    : "there are no files to put back";
  ctx.manager.dispose(channelId);
  if (resumeAt) ctx.archive.setResumeAt(channelId, resumeAt);
  else ctx.archive.clearLastSessionId(channelId);
  const removed = ctx.archive.truncateFrom(channelId, target.id);
  if (removed.length > 0) {
    ctx.clients.broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
    pushTranscript(ctx, channelId);
    if (ctx.tracker.removeForTurns(channelId, removed)) {
      ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: ctx.tracker.items(channelId) });
    }
  }
  if (project?.path) void ctx.checkpoints.forget(project, channelId, removed.filter((id) => id !== target.id));
  ctx.archive.setPendingBrief(channelId, "");
  resetContext(ctx, channelId);
  ctx.clients.broadcast({ type: "status", projectId: channelId, status: "idle" });
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(composeBack(channelId, target)));
  ws.send(
    JSON.stringify({
      type: "error",
      message: failed
        ? `rewound the native conversation — the files were left as they are: ${failed}`
        : "rewound the native conversation and restored the project's files",
    } satisfies ServerMessage),
  );
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
    // Conversation AND code, back to just before this prompt ran: the
    // CLI restores its file checkpoints, then the session resumes
    // truncated (forked) at the kept turn's last chain entry. The prompt
    // itself lands back in the composer — nothing is sent for you.
    //
    // Other harnesses keep no checkpoints and cannot fork a conversation,
    // so theirs rewinds what ruri owns: the transcript is truncated and
    // the harness is retired, re-seeded on the next prompt with a brief
    // of everything kept (the same brief /compact writes). Their files
    // stay as they are, and the reply says so.
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
        const chain = ctx.archive.chain(channelId);
        // The fork point: the latest checkpointed turn before the target.
        // A compaction started a different session, so the scan stops
        // there rather than failing — it only means the chain has nothing
        // to offer, and the fork point is then read from the session's own
        // transcript below, which is where it comes from nowadays anyway
        // (the SDK stopped echoing prompts, so `chain` is usually empty).
        let resumeAt: string | undefined;
        for (let i = idx - 1; i >= 0; i--) {
          const ev = events[i]!;
          if (ev.kind === "compaction") break;
          if (ev.kind === "user" && chain[ev.id]?.last) {
            resumeAt = chain[ev.id]!.last;
            break;
          }
        }
        // A compaction *after* the prompt is different: the session running
        // now began at that boundary, so it holds neither a uuid to fork at
        // nor a checkpoint to restore. That isn't a reason to refuse — it's
        // the same ground a harness rewind stands on, so it takes that path
        // and says so.
        if (events.some((e, i) => i > idx && e.kind === "compaction")) {
          // The CLI's session began at that boundary, so it has nothing
          // to restore — but ruri's checkpoint was taken by ruri, and a
          // compaction is not a thing that happens to it.
          await rewindOnHarness(ctx, ws, channelId, target);
          return;
        }
        const providerId = ctx.models.registry.parse(project.model).providerId;
        if (providerId !== undefined) {
          if (ctx.models.registry.canForkSession(providerId)) {
            // A native provider fork can keep the exact conversation
            // prefix. If this is the first prompt ever, clearing the
            // source id is the exact same empty prefix. A first prompt
            // after a compaction has older briefed context but no prior
            // provider turn to anchor, so it takes the honest fallback.
            const keptHasContext = events
              .slice(0, idx)
              .some((event) => event.kind === "user" || event.kind === "compaction");
            if (resumeAt || !keptHasContext) {
              await rewindOnNativeProvider(ctx, ws, channelId, target, resumeAt);
              return;
            }
          }
          await rewindOnHarness(ctx, ws, channelId, target);
          return;
        }
        // The prompt's uuid, which the CLI keys its file checkpoints by,
        // comes from the session's own transcript: the SDK no longer
        // echoes prompts back, so the chain map built from those echoes
        // can be empty — or, worse, have pinned a neighbouring message.
        // `ordinal` picks between prompts sent with identical text.
        const sessionId = ctx.archive.lastSessionId(channelId);
        const ordinal = events.filter(
          (e, i) => i < idx && e.kind === "user" && e.text.trim() === target.text.trim(),
        ).length;
        const found = sessionId
          ? await promptChain(project, sessionId, target.text, ordinal)
          : undefined;
        const userUuid = found?.user ?? chain[eventId]?.user;
        if (userUuid) ctx.archive.setChain(channelId, eventId, "user", userUuid);
        resumeAt ??= found?.before;
        // A missing file checkpoint is not the end of the rewind: the CLI
        // keeps checkpoints with the process that took them, so a prompt
        // from before a relaunch has none. The conversation still rewinds
        // and the prompt still comes back — the files are simply left as
        // they are, and the user is told so.
        const result = userUuid
          ? await ctx.manager.rewindFiles(project, userUuid)
          : { canRewind: false, error: "no checkpoint recorded for that prompt" };
        // The CLI's own checkpoint is the better one when it is there —
        // it knows the session. When it isn't, ruri took its own before
        // the prompt went out, and that is what a relaunch cannot lose.
        const mine = result.canRewind ? undefined : await ctx.checkpoints.restore(project, channelId, eventId);
        const filesKept = result.canRewind || mine === undefined
          ? undefined
          : (result.error ?? "the CLI couldn't restore the files");
        ctx.manager.dispose(channelId);
        if (resumeAt) ctx.archive.setResumeAt(channelId, resumeAt);
        else ctx.archive.clearLastSessionId(channelId);
        const removed = ctx.archive.truncateFrom(channelId, eventId);
        if (removed.length > 0) {
          ctx.clients.broadcast({ type: "events_removed", projectId: channelId, eventIds: removed });
          pushTranscript(ctx, channelId);
          // items are tied to the prompts they were split from — the
          // rewound prompt's items (and every discarded later prompt's)
          // go too; the edited prompt re-extracts fresh ones on send
          if (ctx.tracker.removeForTurns(channelId, removed)) {
            ctx.clients.broadcast({ type: "tracker", projectId: channelId, items: ctx.tracker.items(channelId) });
          }
          void ctx.checkpoints.forget(project, channelId, removed.filter((id) => id !== eventId));
        }
        ctx.clients.broadcast({ type: "status", projectId: channelId, status: "idle" });
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(composeBack(channelId, target)));
        if (filesKept && ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: `rewound the conversation, but the files were left as they are — ${filesKept}`,
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
  fork: (ctx, ws, msg) => {
    // A new session in the same project, holding everything through
    // this prompt's exchange and carrying on from there; the original
    // is not touched. On Claude the CLI session itself forks at that
    // point (a shared file up to it, then its own); Codex forks its native
    // thread at the provider turn recorded for the exchange. A harness
    // without that primitive — or a retired pre-compaction session —
    // opens on a brief of what the fork holds.
    const channelId = msg.projectId;
    void (async () => {
      try {
        const found = ctx.store.findSession(channelId);
        if (!found) throw new Error("only a project's session can be forked");
        const events = ctx.archive.allEvents(channelId);
        const idx = events.findIndex((e) => e.id === msg.eventId);
        const target = idx >= 0 ? events[idx] : undefined;
        if (!target || target.kind !== "user") throw new Error("that prompt is gone");
        let end = idx + 1;
        while (end < events.length && events[end]!.kind !== "user" && events[end]!.kind !== "compaction") end++;
        const kept = events.slice(0, end);
        const next = events.slice(end).find((e) => e.kind === "user");
        const compactedSince = events.slice(end).some((e) => e.kind === "compaction");
        const project = channelProject(ctx, channelId) ?? found.project;
        const fresh = ctx.store.newSession(found.project.id);
        if (!fresh) throw new Error("unknown project");
        const title = found.session.title ? `${found.session.title} fork` : "fork";
        ctx.store.setSessionTitle(fresh.id, title);
        // the fork runs on what it forked from, not on whatever the
        // project's default has become since
        ctx.store.copySessionSettings(channelId, fresh.id);
        const source = ctx.archive.raw(channelId);
        ctx.archive.seed(fresh.id, {
          events: kept,
          summaries: source.summaries,
          chain: source.chain ?? {},
          ...(source.contextTokens !== undefined ? { contextTokens: source.contextTokens } : {}),
          ...(source.contextWindow !== undefined && source.contextWindowModel !== undefined
            ? { contextWindow: source.contextWindow, contextWindowModel: source.contextWindowModel }
            : {}),
        });
        const providerId = ctx.models.registry.parse(project.model).providerId;
        const claude = providerId === undefined;
        const nativeFork = claude || ctx.models.registry.canForkSession(providerId);
        const sessionId = ctx.archive.lastSessionId(channelId);
        let forked = false;
        if (nativeFork && sessionId && !compactedSince) {
          // the branch point: the last chain entry of this exchange. From
          // the chain map when a turn recorded it, else from the CLI's
          // own transcript as the entry before the next prompt — and a
          // fork at the latest exchange needs no point at all.
          let at = ctx.archive.chain(channelId)[target.id]?.last;
          if (!at && next && claude) {
            const ordinal = events.filter(
              (e, i) => i < events.indexOf(next) && e.kind === "user" && e.text.trim() === next.text.trim(),
            ).length;
            at = (await promptChain(project, sessionId, next.text, ordinal))?.before;
          }
          if (at || !next) {
            ctx.archive.setLastSessionId(fresh.id, sessionId);
            if (at) ctx.archive.setResumeAt(fresh.id, at);
            else ctx.archive.setForkNext(fresh.id);
            forked = true;
          }
        }
        if (!forked) {
          // the source's digest comes along when the fork keeps all it
          // folded; one that reaches past the fork point would remember
          // exchanges the fork never had
          const source = ctx.archive.digest(channelId);
          const digest =
            source && kept.some((e) => e.kind === "user" && e.id === source.through) ? source : undefined;
          if (digest) ctx.archive.setDigest(fresh.id, digest);
          const built = buildCompaction(fresh.id, kept, ctx.archive.summaries(fresh.id), digest);
          if (built) ctx.archive.setPendingBrief(fresh.id, built.brief);
        }
        ctx.clients.broadcast({ type: "projects", projects: ctx.store.list() });
        ctx.clients.broadcast({
          type: "transcript",
          projectId: fresh.id,
          events: ctx.readable.allowArchived({ [fresh.id]: ctx.archive.events(fresh.id) })[fresh.id] ?? [],
          summaries: ctx.archive.allSummaries([fresh.id])[fresh.id] ?? {},
          earlier: ctx.archive.earlier(fresh.id),
        });
        const tokens = ctx.archive.contextTokens(fresh.id);
        if (tokens !== undefined) {
          ctx.clients.broadcast({ type: "context", projectId: fresh.id, context: { tokens, window: contextWindow(ctx, fresh.id) } });
        }
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "open_session", projectId: fresh.id } satisfies ServerMessage));
          if (!forked && nativeFork) {
            ws.send(
              JSON.stringify({
                type: "error",
                message: "forked the conversation — the session that held it is gone, so the fork starts from a brief of what it holds",
              } satisfies ServerMessage),
            );
          }
        }
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: `fork failed: ${errorMessage(err)}`,
            } satisfies ServerMessage),
          );
        }
      }
    })();
  },
} satisfies Partial<Handlers>;
