/**
 * The turn in flight, per channel: how far along it is (the working line's
 * counter), the reply it is streaming, and each channel's context
 * occupancy against the window its model gets.
 */
import type { BackgroundWork, ContextUsage, ServerMessage, TurnProgress } from "../shared/protocol.js";
import { channelProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import type { ParagraphGate } from "./paragraphs.js";

/** Last broadcast per channel, so a stream of deltas is one message a
 *  second rather than one a token. */
const TURN_TICK_MS = 900;
/** Output tokens are about four characters each — close enough for a
 *  line whose job is "something is still coming back". */
const CHARS_PER_TOKEN = 4;

export class Turns {
  /**
   * How the turn in flight is getting on, per channel — the numbers the
   * working line counts up. Kept here rather than in the window because a
   * turn outlives a reload, and a clock that restarts at zero every time
   * the page comes back is worse than no clock.
   */
  readonly progress = new Map<string, TurnProgress>();
  /** When each channel's turn was last broadcast (TURN_TICK_MS). */
  readonly sent = new Map<string, number>();
  /** Per-channel context occupancy, reported by the live sessions. */
  readonly contexts = new Map<string, ContextUsage>();
  /** Per channel, the background work last sent out (chats.ts pushWork):
   *  only chats with some are in it. */
  readonly work = new Map<string, BackgroundWork>();
  /** Each channel's reply in progress, held back to whole paragraphs
   *  (server/paragraphs.ts) — and what has been let through so far, for a
   *  window that opens the chat halfway through it. */
  readonly gates = new Map<string, { messageId: string; gate: ParagraphGate; shown: string }>();

  constructor(private readonly toViewers: (channelId: string, message: ServerMessage) => void) {}

  pushTurn = (channelId: string, force = false): void => {
    const turn = this.progress.get(channelId);
    if (!turn) {
      this.sent.delete(channelId);
      this.toViewers(channelId, { type: "turn", projectId: channelId, turn: null });
      return;
    }
    const now = Date.now();
    if (!force && now - (this.sent.get(channelId) ?? 0) < TURN_TICK_MS) return;
    this.sent.set(channelId, now);
    this.toViewers(channelId, {
      type: "turn",
      projectId: channelId,
      turn: { ...turn, tokens: Math.round(turn.tokens) },
    });
  };

  startTurn = (channelId: string): void => {
    if (this.progress.has(channelId)) return;
    const now = Date.now();
    this.progress.set(channelId, { startedAt: now, tokens: 0, at: now });
    this.pushTurn(channelId, true);
  };

  endTurn = (channelId: string): void => {
    if (!this.progress.delete(channelId)) return;
    this.pushTurn(channelId);
  };

  /** The running turn got further along (SessionEvents.onProgress). */
  advance = (channelId: string, progress: { chars?: number; tokens?: number }): void => {
    const turn = this.progress.get(channelId);
    if (!turn) return;
    turn.at = Date.now();
    // an exact count replaces the running estimate; an estimate only
    // ever adds to it, so the number never walks backwards mid-stream
    if (progress.tokens !== undefined) turn.tokens = Math.max(turn.tokens, progress.tokens);
    else if (progress.chars) turn.tokens += progress.chars / CHARS_PER_TOKEN;
    this.pushTurn(channelId);
  };

  /** Every turn in flight, as the snapshot carries them. */
  snapshot(): Record<string, TurnProgress> {
    return Object.fromEntries(
      [...this.progress].map(([id, turn]) => [id, { ...turn, tokens: Math.round(turn.tokens) }]),
    );
  }

  forgetChannel(channelId: string): void {
    this.contexts.delete(channelId);
    this.progress.delete(channelId);
    this.sent.delete(channelId);
  }
}

/**
 * The context window a channel's model gets. The size its harness named for
 * this channel wins (Claude's CLI and Codex both report it with a turn) —
 * but only for the model that named it; then the size any chat's turn has
 * reported for that model (this run, or the last one's, which server.ts
 * reads back from the archive at launch); and only with neither, a guess
 * (windowFor).
 */
export function contextWindow(ctx: ServerContext, channelId: string): number {
  const model = channelProject(ctx, channelId)?.model || ctx.store.defaultModel();
  const reported = ctx.archive.contextWindowOf(channelId, model) ?? ctx.models.windows.get(model);
  const tokens = ctx.turns.contexts.get(channelId)?.tokens ?? ctx.archive.contextTokens(channelId) ?? 0;
  return windowFor(model, reported, tokens);
}

/**
 * A window reported for the model, or a guess at it: Claude's two sizes, 1M
 * with the [1m] flag — and 1M whenever the chat already holds more than the
 * smaller one could, since a context can't be bigger than its window. The
 * plain models have the million-token window now too, and guessing 200k for
 * a 374k chat just switched onto one drew its gauge full.
 */
export function windowFor(model: string, reported: number | undefined, tokens: number): number {
  if (reported) return reported;
  const guess = model.includes("[1m]") ? 1_000_000 : 200_000;
  return tokens > guess ? 1_000_000 : guess;
}

/**
 * Re-announce one channel's occupancy against the window it has now.
 *
 * Switching a project's model changes the denominator without spending a
 * token, so nothing would otherwise re-measure until the next turn — the
 * gauge would keep reading a 393k session as full because the model it was
 * measured against is gone.
 */
export function republishContext(ctx: ServerContext, channelId: string): void {
  const tokens = ctx.turns.contexts.get(channelId)?.tokens ?? ctx.archive.contextTokens(channelId);
  if (tokens === undefined) return;
  const context: ContextUsage = { tokens, window: contextWindow(ctx, channelId) };
  ctx.turns.contexts.set(channelId, context);
  ctx.clients.broadcast({ type: "context", projectId: channelId, context });
}

/**
 * Re-announce every channel's context occupancy.
 *
 * The limit windows already re-push on a timer and after every turn, so a
 * client that missed their snapshot value heals within minutes. Context
 * had no such path — it was only ever announced mid-turn, so a client that
 * missed the snapshot would sit on a stale zero forever while the gauges
 * either side of it stayed correct. Now it heals the same way.
 */
export function pushContexts(ctx: ServerContext): void {
  for (const [channelId, context] of ctx.turns.contexts) {
    ctx.clients.broadcast({ type: "context", projectId: channelId, context });
  }
}

/**
 * A chat's background work, sent out when it has changed: the agents and
 * scripts it has running whether or not a turn is — its own, and the ones
 * the user started from its agents page. It is what lets the sidebar and
 * the projects page say a chat is busy after its turn has ended.
 */
export function pushWork(ctx: ServerContext, channelId: string): void {
  const live = ctx.manager.backgroundWork(channelId);
  const crew = ctx.crew.list(channelId).filter((agent) => agent.status === "running").length;
  const work: BackgroundWork = { agents: live.agents + crew, scripts: live.scripts };
  const before = ctx.turns.work.get(channelId);
  const none = work.agents === 0 && work.scripts === 0;
  if (none ? !before : before?.agents === work.agents && before.scripts === work.scripts) return;
  if (none) ctx.turns.work.delete(channelId);
  else ctx.turns.work.set(channelId, work);
  ctx.clients.broadcast({ type: "work", projectId: channelId, ...(none ? {} : { work }) });
}

/** A channel's context wiped — after a compaction, or a rewind that
 *  leaves the next prompt to open a fresh session. */
export function resetContext(ctx: ServerContext, channelId: string): void {
  restoreContext(ctx, channelId, 0);
}

/**
 * A channel's context set back to a reading from before — a rewind or a
 * fork that resumes the conversation at an earlier exchange holds exactly
 * what it held when that exchange was over, and the gauge says so now
 * rather than at the end of the next turn.
 */
export function restoreContext(ctx: ServerContext, channelId: string, tokens: number): void {
  const context: ContextUsage = { tokens, window: contextWindow(ctx, channelId) };
  ctx.archive.setContextTokens(channelId, tokens);
  if (tokens > 0) ctx.turns.contexts.set(channelId, context);
  else ctx.turns.contexts.delete(channelId);
  ctx.clients.broadcast({ type: "context", projectId: channelId, context });
}
