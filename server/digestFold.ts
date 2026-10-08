import {
  DIGEST_SECTIONS,
  type Digest,
  type DigestExchange,
  type DigestOp,
  type DigestSection,
} from "./compaction.js";
import { parseOps } from "./memoryFold.js";
import { completeMemory, smallModelEnabled } from "./smallmodel.js";

/**
 * The edits that fold a long conversation's oldest exchanges into its
 * condensed past (server/compaction.ts keeps it) — asked of the memory
 * model, applied by code. The model is shown the sections as they stand,
 * each line by its id, and only the exchanges newly leaving the brief's
 * list; it answers with lines to add, reword or drop. It never writes the
 * whole thing again.
 */

const DIGEST_FOLD_SYSTEM = `You keep the condensed past of one long conversation between a user and a coding agent, so the agent can pick the work back up with only this, the most recent exchanges, and the full record of every exchange on file.

It is kept in fixed sections, each a short list of lines with ids:
- "intent": what the user is after across the conversation (1–3 lines).
- "decisions": what was decided, with the reason.
- "failed": what was tried and did not work, and why — so it isn't tried again.
- "rules": the rules and preferences the user set for how to work.
- "state": where the work stood at the end of what is condensed: built, shipped, versions.
- "open": asked for and not done yet, or put off.

You are given the sections as they stand and the next exchanges to fold in, oldest first — the user's words as they wrote them, and a note of what came of each. Answer with edits:
- {"op": "add", "section": "<section>", "text": "..."} — something the new exchanges add.
- {"op": "edit", "id": "<id>", "text": "..."} — a line the new exchanges refine or correct.
- {"op": "drop", "id": "<id>", "reason": "..."} — a line the new exchanges made untrue: an open item done, a decision reversed (add the reversal too).
Say nothing about a line that still holds. Keep names exact (files, commands, versions). One fact a line, under 25 words. Never invent. No files list: ruri keeps that.

Reply as JSON and nothing else: {"ops": [ ... ]}`;

/** The sections as the model is shown them. */
function shown(digest: Digest | undefined): string {
  const parts = DIGEST_SECTIONS.map((section) => {
    const lines = digest?.sections?.[section] ?? [];
    return lines.length
      ? `${section}:\n${lines.map((line) => `  ${line.id}: ${line.text}`).join("\n")}`
      : `${section}: (none)`;
  });
  if (digest?.text?.trim()) parts.unshift(`(kept from before the sections: ${digest.text.trim()})`);
  return parts.join("\n");
}

const isSection = (value: unknown): value is DigestSection =>
  typeof value === "string" && (DIGEST_SECTIONS as readonly string[]).includes(value);

/** Fold exchanges into the digest: the edits, or undefined when the model
 *  gave nothing usable (the digest then stays as it was, and the exchanges
 *  stay listed until the next try). */
export async function foldDigest(
  digest: Digest | undefined,
  exchanges: DigestExchange[],
  ask: (system: string, prompt: string, maxTokens: number) => Promise<string> = completeMemory,
): Promise<DigestOp[] | undefined> {
  if (!smallModelEnabled() || exchanges.length === 0) return undefined;
  const prompt =
    `THE SECTIONS AS THEY STAND:\n${shown(digest)}\n\n` +
    `THE NEXT EXCHANGES:\n${exchanges.map((e) => `${e.n}. user wrote: ${e.user}\n   what came of it: ${e.reply}`).join("\n")}`;
  const reply = await ask(DIGEST_FOLD_SYSTEM, prompt.slice(0, 60_000), 2000);
  const raw = parseOps(reply);
  if (raw.length === 0 && !/"ops"\s*:\s*\[\s*\]/.test(reply)) return undefined;
  return raw.flatMap((op): DigestOp[] => {
    const kind = op["op"];
    const text = typeof op["text"] === "string" ? op["text"] : undefined;
    const id = typeof op["id"] === "string" ? op["id"] : undefined;
    if (kind === "add" && isSection(op["section"]) && text)
      return [{ op: "add", section: op["section"], text }];
    if (kind === "edit" && id && text) return [{ op: "edit", id, text }];
    if (kind === "drop" && id) return [{ op: "drop", id }];
    return [];
  });
}
