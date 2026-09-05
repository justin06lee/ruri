import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CommandInfo } from "../shared/protocol.js";
import { scanSkills } from "./skills.js";

/**
 * Slash commands written inside a prompt.
 *
 * A long prompt is where you notice the context is full, and "/compact" is
 * the thing to say about it — but said in the middle of the prompt, it used
 * to go to the model as three words. Now a command on its own line (or
 * ruri's own argument-less ones anywhere, as a word) is lifted out and run
 * first, in order, and what is left is sent after them as the prompt.
 *
 * Quoting a command makes it plain text again: '/compact', "/compact" or
 * `/compact` is a mention of the command, not a use of it, and goes to the
 * model untouched, quotes and all.
 *
 * Only commands that exist count: ruri's own, the handful the harness takes
 * in a prompt, and every installed skill or custom command. "/tmp" on a line
 * of its own is a path, and stays in the prompt.
 */

/** ruri's own, run by the server rather than sent anywhere. */
export const RURI_COMMANDS = new Set(["compact"]);

/** What the harness itself answers to when it arrives as a prompt. */
const HARNESS_COMMANDS = ["clear", "context", "cost", "review", "init", "memory", "todos"];

/** A line each for the commands ruri and the harnesses answer, so the
 *  composer's menu says what a thing does rather than only its name. */
const DESCRIBED: Record<string, string> = {
  compact: "ruri compacts the session itself — instant, and it costs nothing",
  clear: "start the conversation over",
  context: "what is in the context window right now",
  cost: "what this session has spent",
  review: "review the changes on this branch",
  init: "write a CLAUDE.md for this project",
  memory: "edit the memory files",
  todos: "the harness's own todo list",
};

/**
 * Every slash command that means something here, described — what the
 * composer's menu offers when you type "/". The same names `knownCommands`
 * lifts out of a prompt, so the menu can only offer what will actually run.
 */
export function listCommands(projectDir?: string): CommandInfo[] {
  const out: CommandInfo[] = [];
  for (const name of RURI_COMMANDS) out.push({ name, kind: "ruri", description: DESCRIBED[name] ?? "" });
  for (const name of HARNESS_COMMANDS) {
    out.push({ name, kind: "harness", ...(DESCRIBED[name] ? { description: DESCRIBED[name] } : {}) });
  }
  for (const skill of scanSkills(projectDir)) {
    if (!skill.enabled) continue;
    out.push({ name: skill.name, kind: "skill", ...(skill.description ? { description: skill.description } : {}) });
  }
  const custom = new Set([
    ...commandFiles(path.join(os.homedir(), ".claude", "commands")),
    ...(projectDir ? commandFiles(path.join(projectDir, ".claude", "commands")) : []),
  ]);
  for (const name of custom) if (!out.some((c) => c.name === name)) out.push({ name, kind: "custom" });
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Names of the custom commands in a .claude/commands folder. */
function commandFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.slice(0, -3));
  } catch {
    return [];
  }
}

/** Every command that means something in this project right now. Held
 *  for a moment per project: installing a skill is rare, sending is not. */
const cache = new Map<string, { at: number; names: Set<string> }>();
const CACHE_MS = 15_000;

export function knownCommands(projectDir?: string): Set<string> {
  const key = projectDir ?? "";
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.names;
  const names = new Set<string>([...RURI_COMMANDS, ...HARNESS_COMMANDS]);
  for (const skill of scanSkills(projectDir)) if (skill.enabled) names.add(skill.name);
  for (const name of commandFiles(path.join(os.homedir(), ".claude", "commands"))) names.add(name);
  if (projectDir) {
    for (const name of commandFiles(path.join(projectDir, ".claude", "commands"))) names.add(name);
  }
  cache.set(key, { at: Date.now(), names });
  return names;
}

/** A whole line that is one command and its arguments. */
const COMMAND_LINE = /^\/([a-z0-9][\w:.-]*)(\s+\S.*)?$/i;

/**
 * Lift the commands out of a prompt. `commands` is what to run first, in
 * the order written; `rest` is the prompt with them gone (possibly empty).
 */
export function splitCommands(
  text: string,
  known: Set<string>,
): { commands: string[]; rest: string } {
  const commands: string[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    const whole = COMMAND_LINE.exec(trimmed);
    const name = whole?.[1]?.toLowerCase();
    // The whole line is one command and everything after it — but only for
    // the commands that take arguments. ruri's own take none, so "/compact
    // now go and read the provider layer" is a compaction and then a
    // prompt, not a compaction with a paragraph attached. Reading it whole
    // here is how a "/compact" typed at the head of a prompt used to reach
    // the harness intact, and the harness has a /compact of its own — so
    // that is the one that ran. It falls through to the word pass below,
    // which is what pulls the two apart.
    if (name && known.has(name) && !RURI_COMMANDS.has(name)) {
      commands.push(trimmed);
      continue;
    }
    // ruri's own commands take no arguments, so they work as words too:
    // "…and /compact before you start" — lifted out of the line, run first.
    // A quoted one ('/compact') never matches: the quote, not whitespace,
    // is what sits against the slash, so it stays in the prompt as written.
    let remaining = line;
    for (const name of RURI_COMMANDS) {
      const word = new RegExp(`(^|\\s)/${name}(?:\\s+|$)`, "gi");
      if (!new RegExp(word.source, "i").test(remaining)) continue;
      remaining = remaining.replace(word, (_match, lead: string) => {
        commands.push(`/${name}`);
        return lead;
      });
    }
    kept.push(remaining === line ? line : remaining.replace(/\s+$/, ""));
  }
  const rest = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { commands, rest };
}
