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

/** The talk tools a chat keeps with no team: other projects, and waiting
 *  on what they answer — no teammates to message. */
export const PLAIN_TALK_TOOLS = [
  "mcp__ruri__list_agents",
  "mcp__ruri__ask_project",
  "mcp__ruri__wait_for_answer",
];

/** What a project's own chat is told when there is no team behind it. */
export function projectChatBriefing(project: string): string {
  return [
    "<ruri:project-chat>",
    `You are ${project}'s chat in ruri: the one chat the user keeps talking to about this project, across days. Do the work yourself — read, edit, run, test and commit as the job needs. Nobody is behind you to hand it to.`,
    "Start a subagent (the Agent tool) only when the user asks for someone to work on something in parallel, and then one at a time; never to split up work you can do yourself.",
    "Other projects open in ruri stay in reach: mcp__ruri__ask_project hands one a job or a question (its own chat for other projects takes it, so the user's chat there is not interrupted), mcp__ruri__wait_for_answer waits on its answer, mcp__ruri__list_agents shows who is open. For the chats in ruri use these, not ListAgents or SendMessage.",
    "</ruri:project-chat>",
  ].join("\n");
}

/** What the /btw side chat is told: quick answers, nothing changed. */
export function sideChatBriefing(project: string): string {
  return [
    "<ruri:btw>",
    `You are the side chat of ${project} in ruri: the user asks quick questions here — "by the way" — while the project's own chat gets on with its work in the same folder. Answer short and plainly, a few lines unless more is asked for. Read the code, git and the project's notes (.ruri/catchup.md) to answer; run read-only commands.`,
    "Change nothing: no edits, no commits, no installs, no starting servers. When a question turns into a job, say it belongs in the project chat and say what to ask it.",
    "</ruri:btw>",
  ].join("\n");
}

/** The tools the side chat is refused, and why. */
export const SIDE_REFUSED = ["Edit", "Write", "NotebookEdit", "MultiEdit", "Agent", "Task"];
export const sideRefusal = (tool: string) =>
  `The side chat changes nothing and starts no one (${tool}): answer from what you can read, and when it needs doing, tell the user to ask the project chat.`;
