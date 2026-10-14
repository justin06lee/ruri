/**
 * An agent that minds its own context, the way Codex does.
 *
 * Every chat in a project — the lead, its team, whoever else ruri runs
 * there — knows how much of its context window it has used: a
 * <ruri:context> line rides in with every prompt (handoff.ts catchUp),
 * Claude hears it again mid-turn as it climbs (a PostToolBatch hook in
 * server/sessions.ts), and a tool tells it any time (mcp__ruri__context,
 * or {"do": "context"} on the talk endpoint for every other harness).
 *
 * At its compaction point — half its window unless the user says
 * otherwise — it is told to write a handoff note and call compact. ruri
 * can't take a session's context away mid-turn, so the tool only keeps
 * the note and tells the model to end its turn; at that turn's end ruri
 * compacts the chat the way it always has (dispatch.ts compactChannel:
 * every exchange on file, a brief of them for a fresh session) and the
 * first thing in its line is a prompt holding the note, telling the fresh
 * session to carry on — nobody has to say a word. A message from another
 * agent that the job was answering is still owed: the prompt carries it
 * (`carries`), and the last words of the turn that finishes the job are
 * its answer (server/handlers/talk.ts talkTurnEnded).
 *
 * ruri's own compaction at about four fifths of the window
 * (dispatch.ts autoCompactDue) stays the backstop for an agent that never
 * gets round to it. The system prompt's words about all this never change
 * (contextBriefing), so the cache holds; the figures ride per turn.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TranscriptEvent } from "../shared/protocol.js";
import { channelProject } from "./channel.js";
import type { ServerContext } from "./context.js";
import { autoCompactShare, compactChannel } from "./dispatch.js";
import { HOME_ID } from "./manager.js";
import type { QueueEntry } from "./queue.js";
import { seatName } from "./talk.js";
import { contextWindow } from "./turns.js";

/** The tool names, auto-allowed: they act on the chat's own session. */
export const CONTEXT_TOOLS = ["mcp__ruri__context", "mcp__ruri__compact"];

/** Where an agent compacts itself unless told otherwise: half its window. */
export const SELF_COMPACT_SHARE = 0.5;

/** How far the context climbs mid-turn before the model hears it again —
 *  a share of the window — and, past its compaction point, how far
 *  between reminders. */
const TELL_EVERY = 0.05;
const REMIND_EVERY = 0.025;

/** A note shorter than this is no handoff; one longer than this is the
 *  conversation again, not a note. */
const NOTE_MIN = 80;
const NOTE_MAX = 24_000;

/** What ruri holds for one chat between the calls. */
interface Mind {
  /** A compaction the agent asked for, waiting on its turn's end, and
   *  when it asked. */
  note?: { text: string; at: number };
  /** The context, in tokens, when the model was last told it. */
  told?: number;
  /** Compacted, and its fresh session not measured yet (true) — or what
   *  that session held at its first reading. */
  fresh?: true | number;
}

const minds = new WeakMap<ServerContext, Map<string, Mind>>();

function mind(ctx: ServerContext, channelId: string): Mind {
  let all = minds.get(ctx);
  if (!all) minds.set(ctx, (all = new Map()));
  let one = all.get(channelId);
  if (!one) all.set(channelId, (one = {}));
  return one;
}

/** "500k", "1M", "0.5", "500000" — a share of the window (at most 1) or a
 *  number of tokens; undefined for "off" or nonsense. */
export function parseCompactAt(raw: string | undefined): { share?: number; tokens?: number } | undefined {
  const text = raw?.trim().toLowerCase();
  if (!text || text === "off") return undefined;
  const m = /^(\d+(?:\.\d+)?)\s*(k|m|%)?$/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!(n > 0)) return undefined;
  if (m[2] === "%") return n <= 100 ? { share: n / 100 } : undefined;
  if (m[2] === "k") return { tokens: n * 1000 };
  if (m[2] === "m") return { tokens: n * 1_000_000 };
  return n <= 1 ? { share: n } : { tokens: Math.round(n) };
}

/** Where a chat compacts itself, in tokens — RURI_SELF_COMPACT_AT, then the
 *  "ruri-self-compact-at" preference, then half the window. Undefined when
 *  it is off ("off" in either), or for a chat that is not a project's. */
export function selfCompactAt(ctx: ServerContext, channelId: string): number | undefined {
  if (channelId === HOME_ID || !channelProject(ctx, channelId)) return undefined;
  const env = process.env["RURI_SELF_COMPACT_AT"];
  const pref = ctx.prefs.all()["ruri-self-compact-at"];
  const said = env?.trim() ? env : pref;
  if (said?.trim().toLowerCase() === "off") return undefined;
  const at = parseCompactAt(said) ?? { share: SELF_COMPACT_SHARE };
  const window = contextWindow(ctx, channelId);
  return Math.min(window, at.tokens ?? Math.round(window * (at.share ?? SELF_COMPACT_SHARE)));
}

/** What room a fresh session gets at least, as a share of the point. */
const FRESH_ROOM = 0.25;

/**
 * The point the chat is held to now: where it compacts itself, but never
 * less than a quarter of that above what its fresh session started with.
 * A point set low enough that a brief and a system prompt reach it — or a
 * step that brings back more than the room left — would otherwise have a
 * fresh session told to compact before it had done anything, and again.
 */
function heldAt(ctx: ServerContext, channelId: string, tokens: number): number | undefined {
  const at = selfCompactAt(ctx, channelId);
  if (at === undefined) return undefined;
  const one = mind(ctx, channelId);
  if (one.fresh === true && tokens > 0) one.fresh = tokens;
  return typeof one.fresh === "number" ? Math.max(at, one.fresh + Math.round(at * FRESH_ROOM)) : at;
}

/** Where ruri compacts the chat itself, whatever the agent does. */
function backstopAt(ctx: ServerContext, channelId: string): number | undefined {
  const project = channelProject(ctx, channelId);
  if (!project || ctx.prefs.all()["ruri-auto-compact"] === "off") return undefined;
  return Math.round(contextWindow(ctx, channelId) * autoCompactShare(ctx.manager.harnessFor(project)));
}

const k = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`;

/** How the chat calls compact: its tool, or the talk endpoint. */
function compactCall(ctx: ServerContext, channelId: string): string {
  const project = channelProject(ctx, channelId);
  const claude = !project || ctx.manager.harnessFor(project) === "claude";
  return claude ? "mcp__ruri__compact" : 'the talk endpoint\'s {"do": "compact"}';
}

/**
 * Where the chat's context stands, in words: tokens used of its window, and
 * how that sits with the point where it compacts itself. "" for Home, and
 * for a chat ruri has no reading for yet. `added` is what has come in since
 * the last reading, estimated.
 */
export function contextStanding(ctx: ServerContext, channelId: string, added = 0): string {
  if (channelId === HOME_ID || !channelProject(ctx, channelId)) return "";
  const read = ctx.turns.contexts.get(channelId)?.tokens ?? ctx.archive.contextTokens(channelId) ?? 0;
  const tokens = read > 0 ? read + added : 0;
  const window = contextWindow(ctx, channelId);
  const at = heldAt(ctx, channelId, tokens);
  const backstop = backstopAt(ctx, channelId);
  const point = at !== undefined ? ` You compact yourself at ${k(at)}.` : "";
  if (tokens <= 0) return `A fresh session: nothing measured yet, of a ${k(window)} window.${point}`;
  const used = `${k(tokens)} of ${k(window)} tokens used (${Math.round((tokens / window) * 100)}%).`;
  if (at === undefined) return `${used}${backstop ? ` ruri compacts you at ${k(backstop)}.` : ""}`;
  if (mind(ctx, channelId).note !== undefined)
    return `${used} Your compaction is set: ruri compacts you at the end of this turn (once nothing you started is still running in the background) — end it now.`;
  if (tokens < at) return `${used} You compact yourself at ${k(at)}, ${k(at - tokens)} from here.`;
  return (
    `${used} That is past ${k(at)}, where you compact yourself: finish the step you are on, write your handoff note and call ${compactCall(ctx, channelId)} with it — it ends this turn and a fresh session carries on from your note.` +
    (backstop && backstop > tokens
      ? ` If you don't, ruri compacts you at ${k(backstop)} from its own brief alone.`
      : "")
  );
}

/** The line that rides in with a prompt (handoff.ts catchUp); it counts as
 *  the model having been told. "" when there is no reading to give — a
 *  stand-in context in a test, a project gone. */
export function contextLine(ctx: ServerContext, channelId: string): string {
  let standing: string;
  try {
    standing = contextStanding(ctx, channelId);
  } catch {
    return "";
  }
  if (!standing) return "";
  mind(ctx, channelId).told = ctx.turns.contexts.get(channelId)?.tokens ?? 0;
  return `<ruri:context>${standing}</ruri:context>\n`;
}

/**
 * What the model hears mid-turn as its context climbs (a Claude session's
 * PostToolBatch hook): the standing again once it has grown a twentieth of
 * the window since it last heard, and every fortieth once it is past its
 * compaction point. Undefined in between — most steps of most turns.
 * `added` is what the step's tool results bring to the next call — the
 * last reading is the call that asked for them (Codex counts the same way:
 * the last reported total, plus what has come in since at four bytes a
 * token).
 */
export function contextNotice(ctx: ServerContext, channelId: string, added = 0): string | undefined {
  const read = ctx.turns.contexts.get(channelId)?.tokens;
  if (!read || channelId === HOME_ID) return undefined;
  const tokens = read + added;
  const one = mind(ctx, channelId);
  if (one.note !== undefined) return undefined;
  const window = contextWindow(ctx, channelId);
  const at = heldAt(ctx, channelId, tokens);
  // fallen since it was told — compacted under it some other way (Claude
  // Code's own, ruri's): it climbs from here
  if (tokens < (one.told ?? 0)) one.told = tokens;
  const told = one.told ?? 0;
  const past = at !== undefined && tokens >= at;
  const crossed = at !== undefined && told < at && past;
  const step = (past ? REMIND_EVERY : TELL_EVERY) * window;
  if (!crossed && tokens - told < step) return undefined;
  const standing = contextStanding(ctx, channelId, added);
  if (!standing) return undefined;
  one.told = tokens;
  return `<ruri:context>${standing}</ruri:context>`;
}

/**
 * The agent asks to be compacted, with its handoff note. Kept until its
 * turn ends (selfCompactDue); what comes back is the tool's answer, which
 * tells it to end the turn — or why not now.
 */
export function requestCompaction(ctx: ServerContext, channelId: string, raw: string): string {
  const project = channelProject(ctx, channelId);
  if (channelId === HOME_ID || !project)
    return "Compaction is for a project's chats; this one compacts with /compact.";
  const note = raw.trim();
  if (note.length < NOTE_MIN) {
    return `That note is too short to carry on from (${note.length} characters). Write it in full — what you are doing and for whom, how far you got, what comes next, the files and decisions that matter, and what not to redo — then call again.`;
  }
  if (note.length > NOTE_MAX) {
    return `That note is ${note.length} characters — the conversation again, not a note. Keep it under ${NOTE_MAX}: point at files and exchange records rather than pasting them, then call again.`;
  }
  const tokens = ctx.turns.contexts.get(channelId)?.tokens ?? ctx.archive.contextTokens(channelId) ?? 0;
  const at = heldAt(ctx, channelId, tokens) ?? Math.round(contextWindow(ctx, channelId) * SELF_COMPACT_SHARE);
  if (tokens < at / 2) {
    return `Not yet: your context holds ${k(tokens)}, and you compact yourself at ${k(at)}. A compaction now would lose detail for nothing — carry on.`;
  }
  const work = ctx.manager.backgroundWork(channelId);
  if (work.agents > 0 || work.scripts > 0) {
    const what = [
      work.agents ? `${work.agents} agent${work.agents > 1 ? "s" : ""}` : "",
      work.scripts ? `${work.scripts} background script${work.scripts > 1 ? "s" : ""}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    return `Not now: ${what} you started ${work.agents + work.scripts > 1 ? "are" : "is"} still running in this session, and compacting would end ${work.agents + work.scripts > 1 ? "them" : "it"}. Wait for ${work.agents + work.scripts > 1 ? "them" : "it"} to finish, then call again.`;
  }
  const again = mind(ctx, channelId).note !== undefined;
  mind(ctx, channelId).note = { text: note, at: Date.now() };
  const owed = carriedLetter(ctx, channelId);
  return [
    `${again ? "ruri has your new note in place of the last." : "ruri has your note."} End this turn now: a line saying you are compacting is enough — start nothing else.`,
    "When it ends, ruri compacts this conversation (every exchange stays on file) and starts a fresh session with its brief, your note, and word to carry on — nobody needs to say anything.",
    ...(owed
      ? [`Your answer to ${owed.who} is still owed: the fresh session finishes the job and answers it.`]
      : []),
  ].join(" ");
}

/** What the check tool says: the standing, and what compacting does. */
export function contextReport(ctx: ServerContext, channelId: string): string {
  const standing = contextStanding(ctx, channelId);
  if (!standing) return "ruri keeps no context reading for this chat.";
  mind(ctx, channelId).told = ctx.turns.contexts.get(channelId)?.tokens ?? 0;
  return standing;
}

/** The letter the chat's current job answers, if any: the message that
 *  started it, or one a compaction carried into it. */
function carriedLetter(
  ctx: ServerContext,
  channelId: string,
): { letter: string; who: string; reply: string } | undefined {
  const prompt = ctx.archive.events(channelId).findLast((event) => event.kind === "user");
  if (prompt?.kind !== "user") return undefined;
  const id = prompt.from && !prompt.from.answer ? prompt.from.letter : prompt.carries;
  const pending = id ? ctx.talk.pending.get(id) : undefined;
  if (!id || !pending || pending.to !== channelId || pending.ending) return undefined;
  const who = pending.sender
    ? seatName(pending.sender.project, pending.sender.title)
    : prompt.from
      ? seatName(prompt.from.project, prompt.from.title)
      : "the agent that messaged you";
  return { letter: id, who, reply: pending.reply };
}

/**
 * Whether the turn that just ended leaves a compaction to run: its note,
 * or undefined. A stopped turn takes its note with it — the user changed
 * their mind about that turn, not just its answer — and one that failed
 * keeps it for the next to end well; so does one that left an agent or a
 * script running, which a compaction would end.
 */
export function selfCompactDue(
  ctx: ServerContext,
  channelId: string,
  event: Extract<TranscriptEvent, { kind: "result" }>,
): string | undefined {
  const one = minds.get(ctx)?.get(channelId);
  if (one?.note === undefined) return undefined;
  // stopped, or overtaken by a compaction since (the user's /compact, ruri's
  // own): the note is about a session that is gone
  const mark = ctx.archive.events(channelId)[0];
  if (event.stopped || (mark?.kind === "compaction" && mark.ts >= one.note.at)) {
    delete one.note;
    return undefined;
  }
  if (!event.ok) return undefined;
  const work = ctx.manager.backgroundWork(channelId);
  if (work.agents > 0 || work.scripts > 0) return undefined;
  const note = one.note.text;
  delete one.note;
  return note;
}

/** What the fresh session is sent, ahead of everything else in its line. */
export function continuePrompt(note: string, owed?: { who: string; reply: string }): string {
  return [
    "↻ You compacted yourself: this is a fresh session, and the brief above is the conversation so far. This is the handoff note you wrote for this moment:",
    "",
    "<handoff-note>",
    note,
    "</handoff-note>",
    "",
    "Carry on from where it leaves off, now — nobody else will tell you to. Don't redo what it says is done, and look at the files before you change them: the brief's <state> is how they stand now.",
    ...(owed
      ? [
          owed.reply === "none"
            ? `The job is a message from ${owed.who}, who asked for no answer: just finish it.`
            : `The job is a message from ${owed.who}: when you finish it, your last message goes back to it as its answer, so end with what it needs.`,
        ]
      : []),
  ].join("\n");
}

/**
 * Compact a chat that asked for it, with its note: the prompt that carries
 * on goes to the head of its line first — so it is what the compaction's
 * own drain sends, into the fresh session — then compactChannel does the
 * rest, saying why in the transcript.
 */
export function selfCompact(ctx: ServerContext, channelId: string, note: string): void {
  const owed = carriedLetter(ctx, channelId);
  const tokens = ctx.turns.contexts.get(channelId)?.tokens ?? ctx.archive.contextTokens(channelId) ?? 0;
  const window = contextWindow(ctx, channelId);
  const entry: QueueEntry = {
    id: randomUUID(),
    text: continuePrompt(note, owed),
    uploads: [],
    silent: false,
    ...(owed ? { carries: owed.letter } : {}),
  };
  const queue = ctx.queues.entries.get(channelId) ?? [];
  queue.unshift(entry);
  ctx.queues.entries.set(channelId, queue);
  ctx.queues.broadcastQueue(channelId);
  const share = tokens && window ? ` at ${Math.round((tokens / window) * 100)}% of ${k(window)}` : "";
  compactChannel(
    ctx,
    channelId,
    `the agent compacted itself${share}, from a handoff note of its own — every exchange stays on file, and the fresh session carries on from the note`,
  );
  startedFresh(ctx, channelId);
}

/** The chat's session was just compacted away: nothing told yet, and the
 *  fresh one's first reading is what its room is counted from. */
export function startedFresh(ctx: ServerContext, channelId: string): void {
  const one = mind(ctx, channelId);
  one.told = 0;
  one.fresh = true;
}

/** The context tools, for the `ruri` MCP server a Claude chat gets. */
export function contextTools(ctx: ServerContext, channelId: string) {
  return [
    tool(
      "context",
      "How much of your context window you have used — tokens out of your window — and how far that is from the point where you compact yourself. ruri also tells you at the start of every turn and as it climbs; call this whenever you want to know now.",
      {},
      async () => ({ content: [{ type: "text", text: contextReport(ctx, channelId) }] }),
    ),
    tool(
      "compact",
      "Compact yourself, with a handoff note for the fresh session that carries on. Call it when ruri tells you you have reached your compaction point (or you are close and at a natural break), never on the last step of a job — finish and answer first. ruri keeps the note and you end your turn; then it compacts this conversation (every exchange stays on file and in its brief) and the fresh session is sent your note with word to carry on, with no word needed from anyone. An answer you owe another agent is still owed: the fresh session gives it when it finishes the job.",
      {
        note: z
          .string()
          .describe(
            "Your handoff note, written for yourself coming to it cold: what you are doing and for whom (the user's request, or the agent whose message you are answering and what it needs back); how far you got — done and verified, half-done; what comes next, in order; the files, commands and decisions that matter, and why; what not to redo or retry, and why. Point at files rather than pasting them.",
          ),
      },
      async (args) => ({ content: [{ type: "text", text: requestCompaction(ctx, channelId, args.note) }] }),
    ),
  ];
}

/** A note for compact over HTTP: given inline, or as a file the agent
 *  wrote it to — a long note is easier written than quoted into JSON. */
export function noteFromCall(body: { note?: unknown; file?: unknown }): string {
  if (typeof body.note === "string" && body.note.trim()) return body.note;
  if (typeof body.file === "string" && body.file.trim()) {
    try {
      const stat = fs.statSync(body.file);
      if (stat.isFile() && stat.size <= NOTE_MAX * 4) return fs.readFileSync(body.file, "utf8");
    } catch {
      return "";
    }
  }
  return "";
}

/**
 * What every project session is told about its context, before it starts
 * — the same words every time, so the prompt stays cached: the figures
 * come with each prompt, never here. `http` is the talk endpoint for a
 * harness without ruri's tools.
 */
export function contextBriefing(http?: string): string {
  const check = http
    ? `POST {"do": "context"} to ${http} tells you any time`
    : "mcp__ruri__context tells you any time";
  const compact = http
    ? `write your handoff note to a file and POST {"do": "compact", "file": "<its path>"} to ${http} (or {"do": "compact", "note": "..."})`
    : "call mcp__ruri__compact with your handoff note";
  return [
    "<ruri:context>",
    `Your context window is finite, and you manage it yourself. ruri tells you how much of it you have used — tokens out of your window — in a <ruri:context> line with every prompt${http ? "" : " and again as it climbs mid-turn"}, and ${check}.`,
    `When a line says you have reached the point where you compact yourself, finish the step you are on, then ${compact}, and end your turn. Your fresh session starts from ruri's brief of the conversation — every prompt word for word, each exchange's full record on file, the repo's state read from git — plus your note, and carries on at once with no word from anyone. The note is what makes it productive: write it for yourself coming to it cold —`,
    "- what you are doing and for whom: the user's request, or the agent whose message you are answering and what it needs back;",
    "- how far you got: what is done and verified, what is half-done;",
    "- what comes next, in order;",
    "- the files, commands and decisions that matter, and why;",
    "- what not to redo or retry, and why.",
    "Don't compact on the last step of a job — finish and answer first. If you never compact yourself, ruri compacts you anyway near the top of your window, from its brief alone.",
    "</ruri:context>",
  ].join("\n");
}
