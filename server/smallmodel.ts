import { Yagami } from "@justin06lee/yagami";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * The "small model" behind turn summaries, session titles, prompt splitting,
 * and the feature tracker: yagami's zero-config completions client over the
 * user's signed-in CLIs, pointed at a cheap model. One call per sent prompt
 * and per finished reply, so cost stays in fractions of a cent. The
 * double-starred model from
 * the Settings catalog wins (any harness — yagami routes qualified ids);
 * RURI_SMALL_MODEL is the fallback override, then "haiku". RURI_NO_MEMORY=1
 * disables the whole layer.
 */

let client: Yagami | null = null;
let configured: string | undefined;

export function smallModelEnabled(): boolean {
  return process.env["RURI_NO_MEMORY"] !== "1";
}

/** Point the layer at the user's double-starred model ("" or undefined clears). */
export function setSmallModel(model: string | undefined): void {
  configured = model || undefined;
}

function model(): string {
  return configured ?? process.env["RURI_SMALL_MODEL"] ?? "haiku";
}

async function complete(system: string, prompt: string, maxTokens: number): Promise<string> {
  client ??= new Yagami();
  const response = await client.messages.create({
    model: model(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  return (response.content ?? [])
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();
}

/** One completed prompt→response exchange, assembled from transcript events. */
export interface Turn {
  turnId: string;
  user: string;
  assistant: string;
  tools: string[];
}

const PROMPT_SUMMARY_SYSTEM = `You compress messages a user sent to a coding agent into the fewest words that lose no detail.
Telegraphic fragments, almost caveman: drop greetings, filler, hedging, politeness; keep every concrete thing — feature/file/function names, symptoms, constraints, counts.
Never invent or interpret; only compress what is there. Plain text, one line, no markdown, no quotes, no trailing period.
Degree of compression: "hey so when I scroll down the page the header kind of flickers? oh and could we maybe make the logo a bit smaller too" becomes "header flickers on scroll; shrink logo".
Aim for under 15 words; one clause per request.`;

/** Compress one user prompt to a terse recall note — fired at send time. */
export async function summarizePrompt(text: string): Promise<string> {
  return complete(PROMPT_SUMMARY_SYSTEM, text.slice(0, 6000), 80);
}

const REPLY_SUMMARY_SYSTEM = `You compress a coding agent's reply into the fewest words that lose no outcome.
Telegraphic fragments, almost caveman: keep what changed and where (files, functions, commands), decisions, errors hit, test/build results; drop narration, reasoning, filler.
Never invent; only compress. Plain text, one line, no markdown, no trailing period.
Degree of compression: a long reply about moving date parsing into a helper, fixing a type error, and the build passing becomes "date parsing moved to utils.ts; Form.tsx type error fixed; build passes".
Aim for under 25 words.`;

/** Compress one finished turn's reply to a terse recall note. */
export async function summarizeReply(turn: Turn): Promise<string> {
  const prompt =
    `CONTEXT — WHAT THE USER HAD ASKED:\n${turn.user.slice(0, 1500)}\n\n` +
    (turn.tools.length ? `TOOLS THE AGENT USED: ${turn.tools.slice(0, 20).join(", ")}\n\n` : "") +
    `AGENT REPLY TO COMPRESS:\n${turn.assistant.slice(0, 6000)}`;
  return complete(REPLY_SUMMARY_SYSTEM, prompt, 120);
}

const TRACKER_SYSTEM = `You maintain the user's manual test checklist for a coding-agent session, working from the user's own prompts alone.
Given one prompt the user sent, list the features, changes, or fixes the USER ASKED FOR — the things they'll want to verify by hand once the agent is done.
Rules:
- Only explicit requests to add, change, or fix something make items. Questions, discussion, opinions, and look-at/analyze asks yield nothing.
- One item per distinct request, faithful to the user's own wording — never invent or interpret beyond what they said.
- Skip anything already covered by the EXISTING ITEMS list.
- Each item: one short imperative line ("Check the dark-mode toggle persists"), max 12 words.
- Output STRICT JSON: {"items": ["...", "..."]} — empty array if nothing.`;

/** Checklist items from ONE user prompt — the reply never feeds this: the
 *  checklist mirrors what the user asked for, not what the agent narrates. */
export async function extractTrackerItems(userText: string, existing: string[]): Promise<string[]> {
  const prompt =
    `EXISTING ITEMS:\n${existing.length ? existing.map((t) => `- ${t}`).join("\n") : "(none)"}\n\n` +
    `USER PROMPT:\n${userText.slice(0, 6000)}`;
  const raw = await complete(TRACKER_SYSTEM, prompt, 400);
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as {
      items?: unknown;
    };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0 && item.length < 200)
      .slice(0, 8);
  } catch {
    return [];
  }
}

const ROLE_SYSTEM = `You name coding-agent sessions by the ROLE they serve inside a project.
Given the session's first prompt (and response, if one exists yet), output a 2-4 word Title Case role name — what this session is FOR, not what was literally asked.
Examples: Frontend UI, Backend API, Test Infra, Release Prep, Bug Triage, Docs.
Output only the title — no quotes, no punctuation.`;

/** Name a session's role from its first prompt — fired the moment the prompt
 *  is sent (the response, when present, is extra context, not a requirement). */
export async function sessionRoleTitle(turn: Turn): Promise<string> {
  const prompt =
    `FIRST PROMPT:\n${turn.user.slice(0, 3000)}` +
    (turn.assistant ? `\n\nRESPONSE (truncated):\n${turn.assistant.slice(0, 2000)}` : "");
  const title = (await complete(ROLE_SYSTEM, prompt, 40)).replace(/["'.]/g, "").trim();
  return title.length > 0 && title.length <= 40 ? title : "";
}

const REVIEW_SYSTEM = `You turn a reviewed feature checklist into ONE follow-up prompt for a coding agent.
Input: items the user marked needs-work during manual testing, each with an optional note about what's wrong.
Rules:
- Write in the user's plain voice, addressed to the agent ("Fix ...", "The X still does Y ...").
- Cover EVERY item; keep each item's own wording and note as faithfully as possible.
- Never invent problems, solutions, or details the items don't state.
- Plain text, one item per line or short paragraph. No preamble, no headings.
Output only the prompt text.`;

/** Write the fix-it prompt for a finished tracker review. */
export async function reviewPrompt(
  items: Array<{ text: string; note: string }>,
): Promise<string> {
  const list = items
    .map((item) => `- ${item.text}${item.note.trim() ? ` — note: ${item.note.trim()}` : ""}`)
    .join("\n");
  const result = await complete(REVIEW_SYSTEM, `NEEDS-WORK ITEMS:\n${list}`, 1200);
  if (!result) throw new Error("empty review prompt");
  return result;
}

const SPLIT_SYSTEM = `You split one user message into its separate, independent requests.
Rules:
- Preserve the user's wording as faithfully as possible; trim only connective tissue ("also", "and then").
- NEVER invent, infer, or add anything the user did not say. No guessed intentions, no new content.
- Keep any [image #N] / [video #N] markers inside the request they belong with.
- Keep fragments that only make sense together in one request.
- If the message is really one request, return it alone.
Output STRICT JSON: {"prompts": ["...", "..."]} in the original order.`;

/** Split a long multi-request prompt into separate prompts (verbatim-ish). */
export async function splitPrompt(text: string): Promise<string[]> {
  const raw = await complete(SPLIT_SYSTEM, text.slice(0, 24000), 8000);
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "")) as {
      prompts?: unknown;
    };
    if (!Array.isArray(parsed.prompts)) return [text];
    const prompts = parsed.prompts
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    return prompts.length > 0 ? prompts : [text];
  } catch {
    return [text];
  }
}

/**
 * Assembles turns from the transcript event stream: a turn opens at a user
 * event and closes at its result event, collecting assistant text and tool
 * names along the way. `onTurn` fires with the finished turn.
 */
export class TurnTracker {
  private readonly open = new Map<string, Turn>();

  constructor(private readonly onTurn: (projectId: string, turn: Turn) => void) {}

  observe(projectId: string, event: TranscriptEvent): void {
    if (event.kind === "user") {
      this.open.set(projectId, { turnId: event.id, user: event.text, assistant: "", tools: [] });
      return;
    }
    const turn = this.open.get(projectId);
    if (!turn) return;
    if (event.kind === "assistant") {
      turn.assistant += (turn.assistant ? "\n\n" : "") + event.text;
    } else if (event.kind === "tool") {
      turn.tools.push(event.name);
    } else if (event.kind === "result") {
      this.open.delete(projectId);
      if (turn.assistant.trim()) this.onTurn(projectId, turn);
    }
  }
}
