import { GUSTEAU_PREF } from "../shared/protocol.js";
import type { PrefStore } from "./prefs.js";
import { findCommand } from "./projectHooks.js";

/**
 * gusteau, the user's taste layer (github.com/justin06lee/gusteau): their
 * design preferences and each project's design sheet, behind one command.
 * With the "Design taste" setting on and gusteau on this machine, every
 * new session is told to read its brief before interface work, to run its
 * check after, and to record what the user approves or corrects — through
 * the shell, so it is the same on every harness. Off by default; read when
 * a session starts, so a flip reaches new sessions without a restart.
 *
 * RURI_GUSTEAU names a gusteau to use instead (a file), or "" for none —
 * what tests set, so they never reach the real one.
 */

export function findGusteau(): string | null {
  return findCommand("gusteau", "RURI_GUSTEAU");
}

export function tasteOn(ctx: { prefs: Pick<PrefStore, "all"> }): boolean {
  return ctx.prefs.all()[GUSTEAU_PREF] === "on";
}

/** What a session is told, or "" when the setting is off or gusteau isn't
 *  here. The words change only with where gusteau is, so the prompt stays
 *  cached. */
export function tasteBriefing(ctx: { prefs: Pick<PrefStore, "all"> }): string {
  if (!tasteOn(ctx)) return "";
  const bin = findGusteau();
  return bin ? gusteauBriefing(bin) : "";
}

export function gusteauBriefing(bin: string): string {
  const g = /\s/.test(bin) ? `"${bin}"` : bin;
  return [
    "<ruri:taste>",
    `The user keeps their design taste in gusteau and wants this project's interface held to it. It is \`${g}\` in your shell, run from the project's folder:`,
    `  ${g} brief                 what to read before interface work: the goal, the rules, their preferences, this project's tokens and decisions`,
    `  ${g} check --limit 20      what in the code is off the design sheet, worst first, with a fix for each; exits 1 until it passes`,
    `  ${g} learn --says "<preference>" --why "<their reason>"    record a preference`,
    `  ${g} ref <name>            the saved sheet for a named look ("make it feel like Linear"), or not found`,
    `Before building or changing interface, run \`${g} brief\` and work from it. A project with no .gusteau folder yet gets one first: \`${g} init "<what the project is, in the user's words>"\`.`,
    `After the change, run \`${g} check\` and fix what your change brought in, from the top, until none of it is left.`,
    `When the user states, approves or corrects a design choice, record it with \`${g} learn\`, with their reason, so the next project starts from it.`,
    "Interface you build still goes in ruri's component library, as above; gusteau's own component commands stay unused here.",
    "</ruri:taste>",
  ].join("\n");
}
