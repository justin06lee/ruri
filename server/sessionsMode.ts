import { SESSIONS_MODE_PREF } from "../shared/protocol.js";
import type { PrefStore } from "./prefs.js";

/**
 * Sessions or Team: the one global switch behind how a project runs.
 *
 * Sessions (the default) is a project as a list of ordinary chats, each one
 * a full-power session that runs only when it is sent a message. Team is a
 * project as its lead with a team behind it (server/team.ts, workers.ts,
 * talk.ts): kept whole in the tree, dormant until this pref says "team".
 * Read live, so flipping it needs no restart; web/src/prefs.ts reads the
 * same key.
 */

export function sessionsMode(ctx: { prefs: Pick<PrefStore, "all"> }): boolean {
  return ctx.prefs.all()[SESSIONS_MODE_PREF] !== "team";
}

/** The talk tools a chat keeps with no team: the other projects' chats —
 *  who is there, a message to one, a job for one by its name or its
 *  folder — and waiting on what they answer. */
export const PLAIN_TALK_TOOLS = [
  "mcp__ruri__list_agents",
  "mcp__ruri__message_agent",
  "mcp__ruri__ask_project",
  "mcp__ruri__wait_for_answer",
];

/** What a project's own chat is told when there is no team behind it. */
export function projectChatBriefing(project: string): string {
  return [
    "<ruri:project-chat>",
    `You are ${project}'s chat in ruri: the one chat the user keeps talking to about this project, across days. Do the work yourself — read, edit, run, test and commit as the job needs. Nobody is behind you to hand it to.`,
    "Start a subagent (the Agent tool) only when the user asks for someone to work on something in parallel, and then one at a time; never to split up work you can do yourself.",
    "The user's other projects open in ruri — the chats on their sidebar — are in reach, and you can message them: mcp__ruri__list_agents shows each one and what it is doing right now; mcp__ruri__message_agent sends one a message, which lands in that project's own chat where the user sees it, and brings its answer back; mcp__ruri__ask_project does the same by the project's name, and opens a folder as a project first if it isn't one; mcp__ruri__wait_for_answer keeps waiting on an answer that is taking long.",
    'A message interrupts a chat at work by default — it stops, reads yours, and goes back to what it was doing. When list_agents shows it deep in something your message can wait for, send it with delivery "queue".',
    "Reach for it when another project holds what you need — how its side of an API works, what it just changed, a job that belongs in its folder — rather than guessing or doing its work for it. A message arriving from another project's chat shows up as <ruri:message>: answer it by ending your turn with what it needs. For the chats in ruri use these tools, not ListAgents or SendMessage.",
    "</ruri:project-chat>",
  ].join("\n");
}
