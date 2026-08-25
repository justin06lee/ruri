import { Yagami } from "@justin06lee/yagami";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * The "small model" behind turn summaries and the feature tracker: yagami's
 * zero-config completions client over the user's signed-in CLI, pointed at a
 * cheap model. One call per finished turn, so cost stays in fractions of a
 * cent; RURI_SMALL_MODEL overrides the model, RURI_NO_MEMORY=1 disables the
 * whole layer.
 */

let client: Yagami | null = null;

export function smallModelEnabled(): boolean {
  return process.env["RURI_NO_MEMORY"] !== "1";
}

function model(): string {
  return process.env["RURI_SMALL_MODEL"] ?? "haiku";
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
