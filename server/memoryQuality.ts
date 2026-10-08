import type { MemoryLine, MemoryPart } from "../shared/protocol.js";

/**
 * What a memory line has to be before it is kept: short, filed under the
 * right part, and about the project rather than one session's weather.
 *
 * Measured on a real memory of 777 lines across 41 projects: 41% ran past
 * the twenty words the model was asked for (a tenth past 38), a fixed bug
 * sat under "what didn't work", and "authorise Asana/Atlassian/… via /mcp"
 * — a nag from one session's harness — was kept as an open item of the
 * project. A prompt asks; these refuse. The user's own lines are theirs and
 * are never refused (server/memoryLog.ts calls this for the model and the
 * agents only).
 */

/** How long a line may run, in words, by who writes it. An agent writes
 *  first-hand and gets a little more room than the model gathering. */
export const TEXT_WORDS: Record<"model" | "agent", number> = { model: 30, agent: 40 };
export const WHY_WORDS: Record<"model" | "agent", number> = { model: 25, agent: 30 };

export function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** A session's own circumstances, not the project's: an integration that
 *  wants signing in to, the network being down, a turn that never ran. */
const TRIVIA: RegExp[] = [
  // the harness asking for connectors to be authorised
  /\b(?:authori[sz]e|authenticate|sign(?:ed)?\s+in|log(?:ged)?\s+in|oauth)\b[^.]{0,80}\b(?:mcp|asana|atlassian|datadog|linear|notion|pagerduty|slack|connectors?)\b/i,
  /(?:^|\s)\/mcp\b/i,
  // a session's connection trouble
  /\b(?:session|chat|turn)\b[^.]{0,80}\b(?:ENOTFOUND|ECONNREFUSED|ETIMEDOUT|offline|wi-?fi)\b/i,
  /\bno work (?:was )?done\b/i,
];

/** Words that say a bug got fixed — which makes it not a failure — unless
 *  they say the fix didn't hold. */
const FIXED = /\b(?:fixed|resolved|now (?:works|passes)|got fixed|was fixed)\b/i;
const NOT_FIXED = /\b(?:didn'?t|did not|never|not|couldn'?t|failed to)\b[^.]{0,20}\b(?:fix|work|hold|help)/i;

/**
 * Why a line can't be kept as written, or undefined when it can. `by` is
 * who is writing it — the user's are never checked.
 */
export function lineRefusal(
  part: MemoryPart,
  text: string,
  why: string | undefined,
  by: MemoryLine["by"] | "system",
): string | undefined {
  if (by === "user" || by === "system") return undefined;
  const limit = TEXT_WORDS[by];
  if (words(text) > limit) return `too long: ${words(text)} words, and a line is at most ${limit}`;
  if (why && words(why) > WHY_WORDS[by]) {
    return `its reason is too long: ${words(why)} words, at most ${WHY_WORDS[by]}`;
  }
  const said = `${text} ${why ?? ""}`;
  if (TRIVIA.some((pattern) => pattern.test(said))) {
    return "that is about one session's circumstances (an integration to sign in to, the network), not the project";
  }
  if (by === "model" && part === "failed" && FIXED.test(said) && !NOT_FIXED.test(said)) {
    return "a bug that got fixed is not a failure — if the fix is worth repeating it is a 'worked' line";
  }
  return undefined;
}
