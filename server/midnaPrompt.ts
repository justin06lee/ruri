/**
 * midna the assistant, and the project called midna: two things with one
 * name, told apart here.
 *
 * midna is a program of the user's own that works across their projects.
 * It sends a chat its prompts over ruri's socket, each with a clientId
 * starting "midna-" (midna's rc.mjs), which ruri keeps as the prompt's id;
 * and it reads what came of one when the turn ends — the project's idle or
 * blocked event (server/projectHooks.ts), then the chat's transcript. It
 * is not a chat in ruri and has no handle.
 *
 * The folder midna's own code is written in is, on the user's machines, a
 * project in ruri too, and its chat answers to "midna" in message_agent and
 * ask_project. A chat midna had prompted would answer "midna" that way, and
 * its answer landed in that project's chat: an agent that knows nothing of
 * the prompt, with midna itself never hearing a word.
 *
 * So a prompt of midna's says, in the model's copy, who sent it and how it
 * is answered (midnaLine); and a message from a chat midna prompted to a
 * project named midna is held back once, with the same explanation
 * (midnaMixup).
 */

import type { Project, TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { foldName } from "./finder.js";

/** What the id of every prompt midna sends starts with. */
export const MIDNA_PROMPT_PREFIX = "midna-";

/** Whether a prompt's id is one midna gave it. */
export function fromMidna(id: string | undefined): boolean {
  return id?.startsWith(MIDNA_PROMPT_PREFIX) === true;
}

/** A prompt someone wrote, not one of ruri's own: those open with a mark
 *  (↩ back to work, ↪ passing an answer on, ↻ carrying on) or are `carried`. */
export function written(event: TranscriptEvent): event is Extract<TranscriptEvent, { kind: "user" }> {
  return event.kind === "user" && !event.from?.carried && !/^[↩↪↻]/.test(event.text);
}

/** The id of midna's prompt, when the latest prompt anyone wrote in a chat
 *  is midna's: the turn it is on is midna's work, whatever ruri has said in
 *  it since (an interruption, a compaction). */
export function midnaPromptOf(ctx: ServerContext, channelId: string): string | undefined {
  const event =
    ctx.archive.events(channelId).findLast(written) ??
    (ctx.archive.hasHistory(channelId) ? ctx.archive.allEvents(channelId).findLast(written) : undefined);
  return event && !event.from && fromMidna(event.id) ? event.id : undefined;
}

/** Whether a project is the one that shares midna's name. */
export function namedMidna(project: Pick<Project, "name">): boolean {
  return foldName(project.name).trim() === "midna";
}

/** What the model is told of a prompt midna sent, in its copy only. */
export function midnaLine(): string {
  return `\n\n<ruri:midna>This prompt came from midna, the user's assistant: a program of its own that works for them across their projects, passing on what they asked or following up on work it started here. It is not a chat in ruri — no project on the sidebar is it, not even one called "midna", which is only the chat where midna's code is written and knows nothing of this prompt. midna reads your last message when this turn ends: to answer it, report to it or ask it something, end your turn with that. Never use message_agent or ask_project to reach it.</ruri:midna>`;
}

/**
 * What goes under a prompt in the model's copy: midnaLine for one midna
 * sent, and for ruri's own carrying such a turn on after a compaction —
 * its fresh session never read the first telling. Nothing for anyone
 * else's, another agent's letter included.
 */
export function midnaNote(
  ctx: ServerContext,
  channelId: string,
  promptId: string,
  from: { carried?: boolean } | undefined,
): string {
  const midnas = from
    ? from.carried === true && midnaPromptOf(ctx, channelId) !== undefined
    : fromMidna(promptId);
  return midnas ? midnaLine() : "";
}

/** What list_agents says beside a project named midna, to a chat midna prompted. */
export const MIDNA_PROJECT_NOTE =
  " — NOT midna the assistant that prompted you: this is the chat where midna's code is written (answer the assistant by ending your turn)";

/** Chats told once that the project is not the assistant, by the prompt
 *  they were on — a server's own, so one run's telling isn't another's. */
const tellings = new WeakMap<ServerContext, Map<string, string>>();

/**
 * A chat midna prompted, about to message a project named midna: almost
 * always an answer meant for the assistant. Held back the first time, with
 * why, and let through when sent again in the same turn — a question about
 * midna's own code is the project chat's to answer.
 */
export function midnaMixup(
  ctx: ServerContext,
  channelId: string,
  to: Pick<Project, "name">,
): string | undefined {
  if (!namedMidna(to)) return undefined;
  const prompt = midnaPromptOf(ctx, channelId);
  if (!prompt) return undefined;
  const told = tellings.get(ctx) ?? new Map<string, string>();
  tellings.set(ctx, told);
  if (told.get(channelId) === prompt) return undefined;
  told.set(channelId, prompt);
  return `Not sent. "${to.name}" here is a project's chat — the one where midna's code is written — not midna the assistant that sent you the prompt you are on; it knows nothing of that prompt, and midna would never see what you send there. To answer midna, report to it or ask it something, end your turn with that as your last message: that is what it reads. If you do mean the project's chat (a question about midna's own code), send this again and it goes.`;
}
