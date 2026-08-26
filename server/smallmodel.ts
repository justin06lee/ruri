import { Yagami } from "@justin06lee/yagami";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * The "small model" behind turn summaries, session titles, prompt splitting,
 * and the feature tracker: yagami's zero-config completions client over the
 * user's signed-in CLIs, pointed at a cheap model. One call per finished
 * turn, so cost stays in fractions of a cent. The double-starred model from
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

const SUMMARY_SYSTEM = `You compress coding-agent conversation turns into terse recall notes.
Style: telegraphic, dense, no filler — like a skill cheat-sheet. 1-2 sentences, max ~45 words.
Always keep: file/function/command names, decisions made, errors hit, what changed.
Drop: pleasantries, restatements, markdown.
Output only the note text.`;

export async function summarizeTurn(turn: Turn): Promise<string> {
  const prompt =
    `USER PROMPT:\n${turn.user.slice(0, 4000)}\n\n` +
    (turn.tools.length ? `TOOLS USED: ${turn.tools.slice(0, 20).join(", ")}\n\n` : "") +
    `ASSISTANT RESPONSE:\n${turn.assistant.slice(0, 6000)}`;
  return complete(SUMMARY_SYSTEM, prompt, 220);
}

const TRACKER_SYSTEM = `You watch a coding-agent session and maintain the user's manual test checklist.
Given one finished turn, list NEW user-visible features, behaviors, or changes the user should verify by hand.
Rules:
- Only include things this turn actually added or changed (code/UI/behavior). Questions, discussion, or read-only turns yield nothing.
- Skip anything already covered by the EXISTING ITEMS list.
- Each item: one short imperative line ("Check the dark-mode toggle persists"), max 12 words.
- Output STRICT JSON: {"items": ["...", "..."]} — empty array if nothing new.`;

export async function extractTrackerItems(turn: Turn, existing: string[]): Promise<string[]> {
  const prompt =
    `EXISTING ITEMS:\n${existing.length ? existing.map((t) => `- ${t}`).join("\n") : "(none)"}\n\n` +
    `USER PROMPT:\n${turn.user.slice(0, 4000)}\n\n` +
    (turn.tools.length ? `TOOLS USED: ${turn.tools.slice(0, 20).join(", ")}\n\n` : "") +
    `ASSISTANT RESPONSE:\n${turn.assistant.slice(0, 6000)}`;
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
Given the session's first exchange, output a 2-4 word Title Case role name — what this session is FOR, not what was literally asked.
Examples: Frontend UI, Backend API, Test Infra, Release Prep, Bug Triage, Docs.
Output only the title — no quotes, no punctuation.`;

/** Name a session's role from its first exchange (sidebar titles). */
export async function sessionRoleTitle(turn: Turn): Promise<string> {
  const prompt =
    `FIRST PROMPT:\n${turn.user.slice(0, 3000)}\n\n` +
    `RESPONSE (truncated):\n${turn.assistant.slice(0, 2000)}`;
  const title = (await complete(ROLE_SYSTEM, prompt, 40)).replace(/["'.]/g, "").trim();
  return title.length > 0 && title.length <= 40 ? title : "";
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
