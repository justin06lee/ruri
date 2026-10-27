import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { GUSTEAU_PREF, type TranscriptEvent } from "../shared/protocol.js";
import { ownerProject } from "./channel.js";
import type { ServerContext } from "./context.js";
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

/** gusteau run in a folder: its exit code and what it printed. Never
 *  throws — a missing or broken gusteau is code -1. */
function run(bin: string, args: string[], cwd: string, ms: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd, timeout: ms, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      resolve({ code, out: `${stdout}`.trim() || `${stderr}`.trim() });
    });
  });
}

type Failure = { severity: number; message: string };

/** One quiet line on a `gusteau check --json` report: that it passes, or
 *  how many things are off and the worst three. Null when it isn't one. */
export function checkSummary(json: string): string | null {
  let report: { passed?: unknown; failures?: unknown };
  try {
    report = JSON.parse(json);
  } catch {
    return null;
  }
  if (!report || !Array.isArray(report.failures)) return null;
  const failures = report.failures as Failure[];
  if (report.passed === true || failures.length === 0) return "Design check passes";
  const worst = [...failures]
    .sort((a, b) => (b.severity ?? 0) - (a.severity ?? 0))
    .slice(0, 3)
    .map((f) => f.message);
  const n = failures.length;
  return `Design check: ${n} ${n === 1 ? "issue" : "issues"} — ${worst.join("; ")}${n > 3 ? "; …" : ""}`;
}

/** `gusteau check` on a project, summed up — null when it has no .gusteau
 *  folder, gusteau isn't here, or the check didn't answer. */
export async function tasteCheck(cwd: string, bin = findGusteau()): Promise<string | null> {
  if (!bin || !existsSync(join(cwd, ".gusteau"))) return null;
  return checkSummary((await run(bin, ["check", "--json"], cwd, 60_000)).out);
}

/** Settings' "Learn from project": `gusteau learn --from-project` in the
 *  project's folder, which reads its review notes and decisions. */
export async function learnFromProject(cwd: string, bin = findGusteau()): Promise<{ ok: boolean; output: string }> {
  if (!bin) return { ok: false, output: "gusteau isn't installed." };
  const { code, out } = await run(bin, ["learn", "--from-project"], cwd, 60_000);
  return { ok: code === 0, output: out || (code === 0 ? "Done." : "gusteau couldn't learn from this project.") };
}

// what each chat was last told, so a turn that changed nothing says nothing
const lastSaid = new Map<string, string>();

/** After a turn lands, with the setting on: the check's result under it in
 *  the chat, as a quiet info line — only when it differs from the last.
 *  Never holds the turn up; a failed check says nothing. */
export function afterTurnTaste(ctx: ServerContext, channelId: string): void {
  if (!tasteOn(ctx)) return;
  const project = ownerProject(ctx, channelId);
  if (!project?.path) return;
  void tasteCheck(project.path)
    .then((said) => {
      if (!said || lastSaid.get(channelId) === said) return;
      lastSaid.set(channelId, said);
      const event: TranscriptEvent = { kind: "info", id: randomUUID(), text: said, ts: Date.now() };
      ctx.archive.append(channelId, event);
      ctx.clients.pushEvent(channelId, event);
    })
    .catch(() => {});
}
