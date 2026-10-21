/**
 * When a project's whole team is done, or waiting on the user — for midna,
 * the user's own assistant, through the hooks that deliver these events
 * (onProjectEvent).
 *
 * A project is at work while any of its chats is: the lead, the liaison,
 * every teammate. A chat is at work while a turn runs or waits at a card,
 * while anything waits in its line (a member waiting for a slot included),
 * while a dropped turn is to be tried again, while an agent it started runs
 * in the background — and a shell it left running, for a while — and while
 * it waits on another project for the answer to a message it sent. The
 * team is done when all of that has been still for IDLE_AFTER_MS after
 * being at work: a lead handing a job to a teammate, a message cutting in,
 * a chat compacting itself and carrying on, never fire it. Once per busy
 * stretch, with when it began.
 *
 * It is waiting on the user when a card is up for them — a permission, a
 * question, an agent asking to message another — or when a turn the user
 * will read ends asking them something (asksUser). Once per card, once per
 * turn, and only once it has gone unanswered for BLOCKED_AFTER_MS: a card
 * the user answers as it goes up is no news.
 *
 * Neither fires for what the user ended themselves (Stop, a rewind), nor at
 * a launch: what was at work before it is not seen ending.
 *
 * Every event goes to the hooks (server/projectHooks.ts fireProjectEvent),
 * which deliver it and try again; each stretch's start goes there too
 * (projectBusy), the baseline its spend is measured from.
 *
 * The state is read where it lives, every SWEEP_MS, rather than followed
 * through every path that changes it; only a turn starting is told as it
 * happens, so one shorter than a sweep is still a stretch at work.
 */
import type { Project, ProjectStatus, TranscriptEvent } from "../shared/protocol.js";
import { ownerProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import { warn } from "./log.js";
import { fireProjectEvent, projectBusy } from "./projectHooks.js";

/** What midna hears about a project. Times are epoch ms. */
export type ProjectEvent =
  | {
      kind: "project.idle";
      projectId: string;
      /** When the stretch at work that has just ended began. */
      busySince: number;
      at: number;
    }
  | {
      kind: "project.blocked";
      projectId: string;
      /** The chat waiting on the user. */
      chatId: string;
      /** A turn that ended asking them something, a card up for them, or
       *  the team's work ending on an error with nothing to try it again. */
      reason: "question" | "card" | "error";
      /** The question; what the card asks about; the error. */
      text?: string;
      /** When the stretch at work it came in began, when there was one. */
      busySince?: number;
      at: number;
    };

/** A wait the environment may shorten, for a test run (RURI_IDLE_MS,
 *  RURI_BLOCKED_MS). */
function waitFrom(name: string, fallback: number): number {
  const set = Number(process.env[name]);
  return Number.isFinite(set) && set > 0 ? set : fallback;
}
/** How long a project stays still before its team counts as done. */
export const IDLE_AFTER_MS = waitFrom("RURI_IDLE_MS", 60_000);
/** How long a question or a card goes unanswered before it is news. */
export const BLOCKED_AFTER_MS = waitFrom("RURI_BLOCKED_MS", 15_000);
/** How long after a chat's last turn a shell it left running still counts
 *  as its work: a build or a test run is over by then; a dev server is not
 *  the team at work. */
export const SCRIPTS_COUNT_MS = 15 * 60_000;
/** A message to another project still waiting on its answer after this is
 *  not the team at work: something lost it. */
export const LETTER_WAITS_MS = 6 * 60 * 60_000;
/** How often the state is read: often enough for the shortest wait. */
export const SWEEP_MS = Math.min(
  5_000,
  Math.max(250, Math.floor(Math.min(IDLE_AFTER_MS, BLOCKED_AFTER_MS) / 3)),
);
/** How long a chat the user stopped takes to wind down: at work, still,
 *  without that being new work. */
const STOP_SETTLES_MS = 10_000;
/** How much of a question midna is told. */
const TEXT_MAX = 300;

type Listener = (event: ProjectEvent) => void;
const listeners = new Set<Listener>();

/** Hear every project event; the answer stops it. */
export function onProjectEvent(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tell(event: ProjectEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      warn("projectWatch", err, event.kind);
    }
  }
}

/** A project's stretch at work, as far as it has been seen. */
interface Stretch {
  /** When it began; nothing while the project is at rest. */
  busySince?: number;
  /** When it was last seen at work — a stopped chat winding down aside. */
  lastBusy?: number;
  /** When it was first seen still, since. */
  quietSince?: number;
  /** When the user last stopped or rewound one of its chats. */
  userEnded?: number;
}

/** Something a chat is waiting on the user for. */
interface Block {
  projectId: string;
  chatId: string;
  reason: "question" | "card";
  text?: string;
  since: number;
  told: boolean;
}

export class ProjectWatch {
  private readonly stretches = new Map<string, Stretch>();
  /** Questions turns ended on, by chat, until the chat goes on. */
  private readonly questions = new Map<string, Block>();
  /** Cards up for the user, by request. */
  private readonly cards = new Map<string, Block>();
  /** When each chat's last turn ended, and how, for its shells and errors. */
  private readonly ended = new Map<string, { at: number; error?: string }>();
  /** When a chat's shells were first seen, for those of no turn seen ending. */
  private readonly shellsSeen = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly emit: Listener;
  private readonly stretchBegan: (projectId: string, busySince: number) => void;
  /** When this server began watching: a card up since before was told, if
   *  at all, by the run before it. */
  private readonly began: number;

  constructor(
    private readonly ctx: ServerContext,
    opts: {
      now?: () => number;
      emit?: Listener;
      /** A stretch at work began. */
      busy?: (projectId: string, busySince: number) => void;
    } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.emit =
      opts.emit ??
      ((event) => {
        fireProjectEvent(ctx, event);
        tell(event);
      });
    this.stretchBegan = opts.busy ?? ((projectId, busySince) => projectBusy(ctx, projectId, busySince));
    this.began = this.now();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch (err) {
        warn("projectWatch", err, "sweep");
      }
    }, SWEEP_MS);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** A chat's status changed: one at work, or at a card, is its project at
   *  work now — and a question it ended on has had its answer. */
  status(chatId: string, status: ProjectStatus): void {
    if (status !== "working" && status !== "permission") return;
    this.questions.delete(chatId);
    const project = ownerProject(this.ctx, chatId);
    if (project) this.busy(project.id);
  }

  /** Something a chat started — an agent, a shell — is running. */
  working(chatId: string): void {
    const project = ownerProject(this.ctx, chatId);
    if (project) this.busy(project.id);
  }

  /** A chat's turn ended: whether it ended asking the user something they
   *  will read, and how it ended, for its shells and its errors. */
  turnEnded(chatId: string, result: Extract<TranscriptEvent, { kind: "result" }>): void {
    const project = ownerProject(this.ctx, chatId);
    if (!project) return;
    const at = this.now();
    this.ended.set(chatId, { at, ...(!result.ok && result.error ? { error: result.error } : {}) });
    this.questions.delete(chatId);
    if (!result.ok) return;
    const events = this.ctx.archive.events(chatId);
    const start = events.findLastIndex((event) => event.kind === "user");
    const prompt = events[start];
    if (prompt?.kind !== "user" || !forTheUser(prompt)) return;
    const reply = events.slice(start + 1).findLast((event) => event.kind === "assistant");
    const asked = reply?.kind === "assistant" ? asksUser(reply.text) : undefined;
    if (asked) {
      this.questions.set(chatId, {
        projectId: project.id,
        chatId,
        reason: "question",
        text: clip(asked),
        since: at,
        told: false,
      });
    }
  }

  /** The user stopped a chat's turn, or rewound it: what was at work there
   *  isn't done, and the user, who did it, knows. A question it ended on
   *  is gone with a rewind. */
  userEnded(chatId: string): void {
    this.questions.delete(chatId);
    const project = ownerProject(this.ctx, chatId);
    if (project) this.stretch(project.id).userEnded = this.now();
  }

  /** Read every project's state, and say what has changed. */
  sweep(): void {
    const now = this.now();
    for (const project of this.ctx.store.list()) this.look(project, now);
    this.lookAtCards(now);
    for (const block of this.questions.values()) this.tellBlock(block, now);
  }

  /**
   * How a project stands right now, for the phone's status
   * (server/status.ts) — read only. Quiet but still `busySince` is a
   * stretch at work winding down: not done until IDLE_AFTER_MS says so.
   * `asks` are the questions turns ended on since this server began, each
   * until its chat goes on; cards are in ctx.permissions, not here.
   */
  standing(
    project: Project,
    now = this.now(),
  ): { atWork: boolean; busySince?: number; asks: Array<{ chatId: string; text?: string; since: number }> } {
    const chats = new Set(project.sessions.map((session) => session.id));
    const busySince = this.stretches.get(project.id)?.busySince;
    return {
      atWork: this.atWork(project, now),
      ...(busySince !== undefined ? { busySince } : {}),
      asks: [...this.questions.values()]
        .filter((block) => chats.has(block.chatId))
        .map((block) => ({
          chatId: block.chatId,
          ...(block.text !== undefined ? { text: block.text } : {}),
          since: block.since,
        })),
    };
  }

  private stretch(projectId: string): Stretch {
    let stretch = this.stretches.get(projectId);
    if (!stretch) this.stretches.set(projectId, (stretch = {}));
    return stretch;
  }

  private busy(projectId: string, now = this.now()): void {
    const stretch = this.stretch(projectId);
    if (stretch.busySince === undefined) {
      stretch.busySince = now;
      try {
        this.stretchBegan(projectId, now);
      } catch (err) {
        warn("projectWatch", err, "projectBusy");
      }
    }
    stretch.quietSince = undefined;
    // a chat the user stopped is still at work for a moment, winding down
    if (stretch.userEnded === undefined || now - stretch.userEnded > STOP_SETTLES_MS) stretch.lastBusy = now;
  }

  private look(project: Project, now: number): void {
    if (this.atWork(project, now)) {
      this.busy(project.id, now);
      return;
    }
    const stretch = this.stretches.get(project.id);
    if (stretch?.busySince === undefined) return;
    stretch.quietSince ??= now;
    if (now - stretch.quietSince < IDLE_AFTER_MS) return;
    const busySince = stretch.busySince;
    const lastBusy = stretch.lastBusy ?? busySince;
    const byUser = stretch.userEnded !== undefined && stretch.userEnded >= lastBusy;
    this.stretches.set(project.id, {});
    if (byUser) return;
    // ended on a question to the user: that is what they hear, not "done"
    const chats = new Set(project.sessions.map((session) => session.id));
    const asked = [...this.questions.values()].some(
      (block) => chats.has(block.chatId) && block.since >= lastBusy - SWEEP_MS,
    );
    if (asked) return;
    // the work ended on an error, in this stretch, with nothing to try again
    const failed = project.sessions.find((session) => {
      const ended = this.ended.get(session.id);
      return (
        this.ctx.manager.statuses()[session.id] === "error" &&
        ended?.error !== undefined &&
        ended.at >= busySince
      );
    });
    if (failed) {
      const error = this.ended.get(failed.id)?.error;
      this.emit({
        kind: "project.blocked",
        projectId: project.id,
        chatId: failed.id,
        reason: "error",
        ...(error ? { text: clip(error) } : {}),
        busySince,
        at: now,
      });
      return;
    }
    this.emit({ kind: "project.idle", projectId: project.id, busySince, at: now });
  }

  /** Whether any of a project's chats is at work, or waiting on another
   *  project for an answer. */
  private atWork(project: Project, now: number): boolean {
    const ctx = this.ctx;
    const statuses = ctx.manager.statuses();
    const chats = new Set(project.sessions.map((session) => session.id));
    for (const chat of chats) {
      const status = statuses[chat];
      if (status === "working" || status === "permission") return true;
      // a line the user's Stop left standing waits on them, not the team
      const held = ctx.queues.held.get(chat);
      if (ctx.queues.pending(chat) > 0 && held?.by !== "stop") return true;
      if (ctx.queues.cutIn.has(chat) || ctx.governor.waiting.includes(chat)) return true;
      if (ctx.retries.has(chat)) return true;
      const work = ctx.turns.work.get(chat);
      if (work?.agents) return true;
      if (work?.scripts) {
        const seen = this.shellsSeen.get(chat) ?? now;
        this.shellsSeen.set(chat, seen);
        if (now - Math.max(this.ended.get(chat)?.at ?? 0, seen) < SCRIPTS_COUNT_MS) return true;
      } else this.shellsSeen.delete(chat);
    }
    // a message to another project, its answer still on its way: one to a
    // chat of its own is that chat at work, or its answer in a line here
    for (const letter of ctx.talk.pending.values()) {
      if (!chats.has(letter.from) || chats.has(letter.to)) continue;
      if (letter.reply === "none" || now - letter.ts > LETTER_WAITS_MS) continue;
      return true;
    }
    return false;
  }

  /** The cards up for the user: news once each has waited long enough. */
  private lookAtCards(now: number): void {
    const up = new Set<string>();
    for (const request of this.ctx.permissions.values()) {
      // naming a component: the model goes on, and the name comes when it comes
      if (request.kind === "component") continue;
      const project = ownerProject(this.ctx, request.projectId);
      if (!project) continue;
      up.add(request.requestId);
      let block = this.cards.get(request.requestId);
      if (!block) {
        block = {
          projectId: project.id,
          chatId: request.projectId,
          reason: "card",
          text:
            request.kind === "question"
              ? "a question"
              : request.kind === "message"
                ? "a message to send"
                : request.toolName,
          since: Math.min(request.ts || now, now),
          told: (request.ts || now) < this.began,
        };
        this.cards.set(request.requestId, block);
      }
      this.tellBlock(block, now);
    }
    for (const id of this.cards.keys()) if (!up.has(id)) this.cards.delete(id);
  }

  private tellBlock(block: Block, now: number): void {
    if (block.told || now - block.since < BLOCKED_AFTER_MS) return;
    block.told = true;
    const busySince = this.stretches.get(block.projectId)?.busySince;
    this.emit({
      kind: "project.blocked",
      projectId: block.projectId,
      chatId: block.chatId,
      reason: block.reason,
      ...(block.text ? { text: block.text } : {}),
      ...(busySince !== undefined ? { busySince } : {}),
      at: now,
    });
  }
}

/** Whether the words a turn ends on are for the user to read: a prompt of
 *  theirs (or ruri's on their behalf — carrying on, back to work), or an
 *  answer coming back to the chat that asked for them. Not when the turn
 *  answers another agent: its last words go there. */
function forTheUser(prompt: Extract<TranscriptEvent, { kind: "user" }>): boolean {
  const from = prompt.from;
  if (!from) return true;
  if (from.answer) return !from.owes;
  return false;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TEXT_MAX ? `${flat.slice(0, TEXT_MAX - 1)}…` : flat;
}

/* ── does a reply ask the user something ──────────────────────────── */

/** Words that ask for an answer, a choice or a go-ahead without a "?". */
const ASKS =
  /\b(?:let me know (?:which|what|whether|how|when)|tell me (?:which|what|whether|how|when)|please (?:confirm|choose|pick|decide|advise|review|approve|reply|answer)|confirm (?:whether|that|which|if)|(?:it'?s )?your call|up to you|say the word|(?:i'?m )?waiting (?:on|for) (?:you|your)|i need (?:you|your|a decision|an answer|a go-ahead)|need your (?:input|call|decision|go-ahead|ok|okay|approval|answer)|(?:pick|choose) one|which (?:one|option|way) (?:do )?you)\b/i;
/** An offer made in passing — "let me know if you'd like the docs too" —
 *  which leaves the job done, not waiting. */
const OFFER =
  /^(?:(?:let me know|tell me|just say) if|feel free|happy to|i can|if you(?:'d)? (?:want|like|prefer))\b/i;
/** What may follow the question it closes on: a sign-off, a default, an
 *  either-way — not an answer of its own. */
const AFTER =
  /^(?:if (?:so|yes|not|you)|either|otherwise|or (?:i|we)|happy to|i can|i'?ll|just say|no rush|thanks|thank you)\b/i;
/** A line of a list, a table or a rule: options, results, layout. */
const LISTED = /^(?:[-*•+]|\d+[.)]|[a-z][.)])\s+|^\||^[-─—=*_]{3,}$/i;
/** A sentence that ends asking. */
const QUESTION = /[?？]["')\]]*$/;

/**
 * The question a reply ends on for the user, if it ends on one — cheaply,
 * on its last words alone. A rhetorical question the reply answers itself,
 * one quoted or in code, a "?" in a URL, an offer made in passing: none of
 * them. A question with its options listed under it, or a sign-off after
 * it: still the question. Words asking for a decision without a "?" ("your
 * call", "please confirm which"): a question too.
 */
export function asksUser(reply: string): string | undefined {
  const lines = reply
    .replace(/```[\s\S]*?(?:```|$)/g, "\n")
    .replace(/`[^`\n]*`/g, "code")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/\b(?:https?|file):\/\/\S+/g, "link")
    // a short quotation is someone else's words
    .replace(/[“"][^“”"\n]{1,200}[”"]/g, "quote")
    .split("\n")
    .map((line) => line.trim());
  // past the options listed under the question — unless one of them asks
  let end = lines.length - 1;
  while (end >= 0 && (!lines[end] || LISTED.test(lines[end]!))) {
    const item = plain(lines[end]!);
    if (item && QUESTION.test(item)) return item;
    end -= 1;
  }
  let start = end;
  while (start > 0 && lines[start - 1] && !LISTED.test(lines[start - 1]!)) start -= 1;
  const sentences = lines
    .slice(start, end + 1)
    .join(" ")
    .split(/(?<=[.?!？])\s+/)
    .map(plain)
    .filter(Boolean);
  const final = sentences.at(-1);
  if (!final) return undefined;
  const asks = (sentence: string) =>
    QUESTION.test(sentence) || (ASKS.test(sentence) && !OFFER.test(sentence));
  if (asks(final)) return final;
  const before = sentences.at(-2);
  if (before && AFTER.test(final) && asks(before)) return `${before} ${final}`;
  return undefined;
}

/** A line as it reads: no list mark, no emphasis, no heading. */
function plain(line: string): string {
  return line
    .replace(/^(?:[-*•+>#]+|\d+[.)]|[a-z][.)])\s+/i, "")
    .replace(/[*_~]+/g, "")
    .trim();
}

/* ── one per server ─────────────────────────────────────────────────── */

const watches = new WeakMap<ServerContext, ProjectWatch>();

/** The server's watch on its projects, made the first time it is asked for. */
export function projectWatch(ctx: ServerContext): ProjectWatch {
  let watch = watches.get(ctx);
  if (!watch) watches.set(ctx, (watch = new ProjectWatch(ctx)));
  return watch;
}
