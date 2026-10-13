import type { MemoryPart, MemorySource } from "../shared/protocol.js";
import { warn } from "./log.js";
import { MEMORY_PARTS, type FoldLayers } from "./memoryLines.js";
import type { LineRecord, MemoryChange } from "./memoryLog.js";
import { mostAlike } from "./similarity.js";

/**
 * What finished turns teach the project's memory, as changes to it.
 *
 * The model used to be handed the memory and asked for it back, whole,
 * with the turns folded in — and whatever it left out was gone. A model
 * rewriting a list shortens it, merges it and drops a little more each
 * time; nothing it did could be told from what it meant to do. Now it
 * answers with deltas — add this, sharpen that line of yours, this one is
 * superseded by that, this one is done — and code applies them through the
 * memory's log (server/memoryLog.ts), under the same rules as every other
 * writer. A line it says nothing about stays exactly as it is.
 *
 * Each new line is then held up against the lines most like it, Mem0's
 * way: one that plainly says what a line already says is dropped; one
 * that might is put to the model with those lines beside it — new, the
 * same, or newer than one of them.
 */

/** One finished turn as a fold reads it. */
export interface FoldTurn {
  chat: string;
  turnId: string;
  /** Its ref, `7a3637b4#16`. */
  ref: string;
  title?: string;
  /** The day it ran. */
  day: string;
  user: string;
  assistant: string;
  /** What it changed in the project, project-relative. */
  files: string[];
  /** The changes themselves (Checkpoints.turnDiff), budgeted. */
  diff?: string;
  /** The tools it used that brought text in from outside the project —
   *  web pages, other services: what it learned there waits to be
   *  confirmed before sessions read it. */
  outside?: string[];
}

/** What a fold is told about the project. */
export interface FoldInput {
  project: string;
  today: string;
  /** The stack, a line a layer by slug — and how a new line finds its
   *  layer (the one its exchange worked in). */
  stack?: { text: string; fold: FoldLayers };
  /** The memory's current lines. */
  lines: LineRecord[];
  turns: FoldTurn[];
  /** `7a3637b4#16` back to its chat and prompt. */
  resolve: (ref: string) => MemorySource | undefined;
}

/** One request to the model: its text answer. */
export type Ask = (system: string, prompt: string, maxTokens: number) => Promise<string>;

/** How much of each turn a fold reads. */
const USER_CHARS = 3000;
const REPLY_CHARS = 8000;
const DIFF_CHARS = 8000;

/** Text cut to `budget` from the middle: the opening and, longer, the close —
 *  where a reply says what it concluded. */
function cut(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const head = Math.floor(budget / 3);
  return `${text.slice(0, head)}\n[… ${text.length - budget} characters of the middle cut …]\n${text.slice(-(budget - head))}`;
}

/** One turn, as the fold's material. */
export function turnMaterial(turn: FoldTurn): string {
  const parts = [
    `[${turn.ref} · ${turn.day}]${turn.title ? ` (in the "${turn.title}" chat)` : ""}`,
    `The user asked:\n${cut(turn.user.trim(), USER_CHARS)}`,
    `What the agent did and said:\n${cut(turn.assistant.trim(), REPLY_CHARS) || "(no reply)"}`,
  ];
  if (turn.files.length) parts.push(`Files it changed: ${turn.files.slice(0, 40).join(", ")}`);
  if (turn.diff?.trim()) parts.push(`The diff:\n${cut(turn.diff.trim(), DIFF_CHARS)}`);
  if (turn.outside?.length) {
    parts.push(`It read content from outside the project, through: ${[...new Set(turn.outside)].join(", ")}`);
  }
  return parts.join("\n\n");
}

/** The memory as the model is shown it: every current line by its id. */
function linesForModel(lines: LineRecord[], layered: boolean): string {
  const shown = MEMORY_PARTS.map((part) => {
    const ofPart = lines.filter((line) => line.part === part);
    if (!ofPart.length) return `${part}: (none)`;
    return [
      `${part}:`,
      ...ofPart.map((line) => {
        const who = line.pinned && line.by === "model" ? "user" : line.by;
        const layer = layered && part !== "now" ? ` [${line.layer ?? "project"}]` : "";
        const stale = line.check ? ` (may be stale: ${line.check.reason})` : "";
        return `  ${line.id} by ${who}${layer}: ${line.text}${line.why ? ` — ${line.why}` : ""}${stale}`;
      }),
    ].join("\n");
  });
  return shown.join("\n");
}

export const DELTA_SYSTEM = `You keep the working memory of a software project: what a coding agent picking the work up cold needs to know that the code itself won't tell it. Fresh sessions read it, other agents working in the same project at the same time read it, and the next harness to take over reads it — so that nobody redoes a settled decision, repeats an attempt that already failed, or trips the same trap twice.

You are given the memory as it stands — every line with its id, its part, who wrote it and (when the project has a stack) the layer it is filed under — and what just happened: finished exchanges between the user and a coding agent, oldest first, each opening with its ref like [7a3637b4#16 · 2026-09-22], with the files it changed and usually the diff.

Answer with CHANGES to the memory, never the memory itself. Code applies them. A line you say nothing about stays exactly as it is, so say nothing about a line that still holds.

THE CHANGES — objects in "ops":
- {"op": "add", "part": "<part>", "text": "...", "why": "...", "from": "<ref>", "layer": "<slug or project>"} — something new worth keeping. "from" is the ref of the exchange that shows it; always give it.
- {"op": "update", "id": "<id>", "text": "...", "why": "..."} — sharpen or correct one of your own lines (by "model") that the exchanges refine. Give "part" and/or "layer" instead of (or with) "text" to move it.
- {"op": "supersede", "id": "<id>", "text": "...", "why": "...", "reason": "...", "evidence": "...", "from": "<ref>"} — what a line says was replaced: a decision reversed, a value or a version changed, a plan settled another way. The old line is kept in the log as superseded and the new one takes its place.
- {"op": "retire", "id": "<id>", "reason": "...", "evidence": "..."} — a line no longer holds and nothing replaces it: an open item that got done, a trap fixed for good, a "now" line the work moved past.
- {"op": "noop"} — nothing in these exchanges belongs in the memory. Often the right answer: most exchanges build things, and building things is not memory.

WHO WROTE A LINE DECIDES WHAT YOU MAY DO WITH IT
- by "user": the user's own word. Never touch it.
- by "agent": written first-hand by the session that did the work. Never reword it. Supersede or retire it only when an exchange plainly shows it no longer holds, and say where in "evidence": the ref, and what in it shows it.
- by "model": yours. Update, supersede or retire it whenever the exchanges call for it.
- Every supersede and retire needs a "reason". Taking many lines out at once is refused.

THE PARTS
- "now": where the work stands at the end of these exchanges — in progress, just finished, next. At most 4 lines. Supersede or retire the "now" lines the work has moved past.
- "decisions": choices about how the project works or is built, with the reason in "why" — only a reason the exchanges give; with none, say what it was chosen over, or leave "why" out.
- "worked": approaches, techniques and fixes that proved out here and are worth repeating, with where.
- "failed": what was tried and did NOT work, with the cause in "why", so nobody tries it again. A bug that got fixed is not a failure.
- "gotchas": traps, constraints and standing rules — quirks that break things silently, what the user insists on or forbids.
- "open": asked for and not done, put off, or known broken — only what is still open.

WHAT BELONGS
- Not a changelog. A feature that was simply built belongs nowhere unless a decision, a lesson or a trap came with it. Nothing about this memory itself.
- Not one session's circumstances: an integration asking to be signed in to, the network being down, a turn that never ran.
- One fact per line, in ONE part. Before you add, look for a line that already says it: update yours or supersede it instead of adding a twin. A "now" line and an "open" line must never say the same thing.
- Keep names exact: files, commands, flags, settings, versions, values. Where the diff and the reply disagree, the diff is right.
- "text" under 25 words, "why" under 20. No dates: ruri keeps those.
- Only what the exchanges show. Never invent a reason, a result or a rule; a missing "why" is better than a made-up one.

LAYERS
When a STACK is given, every line but "now" belongs to one layer or to the whole project: "layer": "<slug>" for a line about working in that layer (only sessions working there read it), "layer": "project" for what holds wherever a session works (how to build, test or ship, rules for every session, the user's standing preferences, what spans layers). Give "layer" on every add.

Reply as JSON and nothing else: {"ops": [ ... ]}`;

/** The prompt a fold sends. */
export function foldPrompt(input: FoldInput): string {
  return (
    `PROJECT NAME: ${input.project}\nTODAY: ${input.today}\n\n` +
    (input.stack ? `STACK:\n${input.stack.text}\n\n` : "") +
    `MEMORY AS IT STANDS:\n${linesForModel(input.lines, !!input.stack)}\n\n` +
    `WHAT HAPPENED:\n${input.turns.map(turnMaterial).join("\n\n---\n\n")}`
  );
}

/* ── reading the answer ────────────────────────────────────────────── */

/** An op as the model wrote it. */
export type RawOp = Record<string, unknown>;

/**
 * The objects in a JSON array that starts at `from`, as far as they go
 * whole — an answer cut off mid-way still gives the ops it finished.
 */
function objectsFrom(text: string, from: number): RawOp[] {
  const out: RawOp[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0 && start !== -1) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1)) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as RawOp);
        } catch {
          // a malformed op is skipped; the ones around it stand
        }
        start = -1;
      }
      if (depth < 0) break;
    } else if (c === "]" && depth === 0) break;
  }
  return out;
}

/**
 * The ops in a model's answer: the whole JSON when it parses, else every
 * op it finished before it was cut off or went wrong. Nothing at all for
 * an answer with no ops in it — which changes nothing.
 */
export function parseOps(reply: string, key = "ops"): RawOp[] {
  const at = reply.search(new RegExp(`"${key}"\\s*:\\s*\\[`));
  if (at === -1) return [];
  try {
    const whole = JSON.parse(reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1)) as Record<
      string,
      unknown
    >;
    if (Array.isArray(whole[key])) {
      return (whole[key] as unknown[]).filter(
        (op): op is RawOp => !!op && typeof op === "object" && !Array.isArray(op),
      );
    }
  } catch {
    // salvaged below
  }
  return objectsFrom(reply, reply.indexOf("[", at) + 1);
}

const text = (op: RawOp, key: string): string | undefined =>
  typeof op[key] === "string" && (op[key] as string).trim() ? (op[key] as string).trim() : undefined;

const isPart = (value: string | undefined): value is MemoryPart =>
  value !== undefined && (MEMORY_PARTS as string[]).includes(value);

/** The tools whose output is somebody else's text: a web page, a search,
 *  another service. ruri's own tools aren't; the bridge is when it opened
 *  a page off this machine. */
export function outsideTool(name: string, summary = ""): boolean {
  if (/^(webfetch|websearch|web_search|web_fetch|fetch|browse|browser)$/i.test(name)) return true;
  if (!name.startsWith("mcp__") || name.startsWith("mcp__ruri__")) return false;
  if (name.startsWith("mcp__bridge__")) {
    const url = /https?:\/\/([^/\s:]+)/i.exec(summary)?.[1];
    return !!url && !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i.test(url);
  }
  return true;
}

/**
 * The model's ops as changes the log can apply — each checked for its
 * shape, its refs turned back into the exchanges they name, each new line
 * filed under a layer, and a line learned from a turn that read outside
 * content marked to wait for confirmation. An op of no known kind, or
 * missing what it needs, is dropped; the log refuses ops on lines that
 * aren't there.
 */
export function opsToChanges(ops: RawOp[], input: FoldInput): MemoryChange[] {
  const byId = new Map(input.lines.map((line) => [line.id, line]));
  const turnOf = new Map(input.turns.map((turn) => [turn.ref, turn]));
  const anyOutside = input.turns.some((turn) => turn.outside?.length);
  const fromOutside = (ref: string | undefined) =>
    ref ? !!turnOf.get(ref)?.outside?.length || (!turnOf.has(ref) && anyOutside) : anyOutside;
  const layerOf = (named: string | undefined, source: MemorySource | undefined, part: MemoryPart) => {
    if (part === "now" || !input.stack) return undefined;
    if (named === "project") return null;
    if (named && input.stack.fold.slugs.has(named)) return named;
    return source ? (input.stack.fold.of?.(source) ?? null) : null;
  };
  const changes: MemoryChange[] = [];
  for (const op of ops) {
    const kind = text(op, "op")?.toLowerCase();
    const from = text(op, "from");
    const source = from ? input.resolve(from) : undefined;
    const why = text(op, "why");
    const reason = text(op, "reason");
    const evidence = text(op, "evidence") ?? (from && reason ? `${from}` : undefined);
    if (kind === "add") {
      const part = text(op, "part");
      const words = text(op, "text");
      if (!isPart(part) || !words) continue;
      const layer = layerOf(text(op, "layer"), source, part);
      changes.push({
        op: "add",
        part,
        text: words,
        ...(why ? { why } : {}),
        ...(source ? { source } : {}),
        ...(layer ? { layer } : {}),
        ...(fromOutside(from) ? { quarantined: true } : {}),
      });
    } else if (kind === "update") {
      const id = text(op, "id");
      const line = id ? byId.get(id) : undefined;
      if (!id) continue;
      const part = text(op, "part");
      const words = text(op, "text");
      const named = text(op, "layer");
      const movesPart = isPart(part) && part !== line?.part;
      if (!words && !movesPart && !named && !why) continue;
      changes.push({
        op: "edit",
        line: id,
        ...(words ? { text: words } : {}),
        ...(why ? { why } : {}),
        ...(movesPart ? { part } : {}),
        ...(named && input.stack
          ? { layer: named === "project" ? null : input.stack.fold.slugs.has(named) ? named : undefined }
          : {}),
        ...(reason ? { reason } : {}),
      });
    } else if (kind === "supersede") {
      const id = text(op, "id");
      const words = text(op, "text");
      if (!id || !words) continue;
      const line = byId.get(id);
      const part = text(op, "part");
      const into = isPart(part) ? part : (line?.part ?? "decisions");
      const named = text(op, "layer");
      changes.push({
        op: "supersede",
        line: id,
        text: words,
        ...(why ? { why } : {}),
        ...(isPart(part) ? { part } : {}),
        ...(named ? { layer: layerOf(named, source, into) ?? null } : {}),
        ...(source ? { source } : {}),
        reason: reason ?? "",
        ...(evidence ? { evidence } : {}),
        ...(fromOutside(from) ? { quarantined: true } : {}),
      });
    } else if (kind === "retire") {
      const id = text(op, "id");
      if (!id) continue;
      changes.push({ op: "retire", line: id, reason: reason ?? "", ...(evidence ? { evidence } : {}) });
    }
  }
  return changes;
}

/* ── one line said twice ───────────────────────────────────────────── */

/** At or past this, a new line says what an existing one does: dropped
 *  without asking. Below `ASK_FROM`, it is new. Between, the model says.
 *  (Measured on 779 real lines: pairs past 0.8 were the same fact; from
 *  0.45 to 0.8, mostly a "now" restating an "open", with a few distinct
 *  facts about one thing — which is why that band is asked about.) */
export const SAME_AT = 0.8;
export const ASK_FROM = 0.45;

const DEDUP_SYSTEM = `You keep a software project's memory free of repeats. You are given candidate lines about to be added to it, each with the existing lines most like it.

For each candidate decide:
- "add" — it says something none of the listed lines says.
- "skip" — a listed line already says it, in whatever words. Name that line in "same".
- "replace" — it says what a listed line says, but is newer or more exact, so that line should give way to it. Name the line in "id". A line by "user" is never replaced: skip instead.

A "now" line and an "open" line saying the same thing are the same. Two lines about one subject that say different things are not the same.

Reply as JSON and nothing else: {"decisions": [{"candidate": 1, "decision": "add"}, {"candidate": 2, "decision": "skip", "same": "o2zt"}, {"candidate": 3, "decision": "replace", "id": "d4k2"}]}`;

/** The text a line is compared by. */
const said = (line: { text: string; why?: string | undefined }) => `${line.text} ${line.why ?? ""}`;

/**
 * The adds held up against the memory: one that plainly repeats a line is
 * dropped, one that might is put to the model with the lines most like it,
 * and a "replace" becomes a supersede of the line it outdates. Everything
 * but adds passes through untouched. A model that can't be asked leaves
 * the doubtful ones in — a repeat is cheaper than a lost line.
 */
export async function withoutRepeats(
  changes: MemoryChange[],
  lines: LineRecord[],
  ask: Ask,
): Promise<{ changes: MemoryChange[]; skipped: number }> {
  const doubtful: Array<{ at: number; similar: LineRecord[] }> = [];
  const keep: boolean[] = changes.map(() => true);
  // the memory, and the adds already let through — one fold saying a
  // thing twice is a repeat too
  const pool = [...lines];
  changes.forEach((change, at) => {
    if (change.op !== "add") return;
    const hits = mostAlike(said(change), pool, said, { limit: 3, floor: ASK_FROM });
    if (hits[0] && hits[0].score >= SAME_AT) {
      keep[at] = false;
      return;
    }
    if (hits.length) doubtful.push({ at, similar: hits.map((hit) => hit.item) });
    pool.push({
      id: `new${at + 1}`,
      text: change.text,
      ...(change.why ? { why: change.why } : {}),
      by: "model",
      part: change.part,
      status: "current",
      rank: 0,
    });
  });
  const out = changes.map((change) => change);
  if (doubtful.length) {
    const prompt = doubtful
      .map(({ at, similar }, i) => {
        const change = changes[at] as Extract<MemoryChange, { op: "add" }>;
        return [
          `CANDIDATE ${i + 1} (${change.part}): ${said(change).trim()}`,
          ...similar.map((line) => `  ${line.id} (${line.part}, by ${line.by}): ${said(line).trim()}`),
        ].join("\n");
      })
      .join("\n\n");
    let decisions: RawOp[] = [];
    try {
      decisions = parseOps(await ask(DEDUP_SYSTEM, prompt, 1500), "decisions");
    } catch (err) {
      warn("memory", err, "withoutRepeats");
    }
    for (const decision of decisions) {
      const n = Number(decision["candidate"]);
      const entry = doubtful[n - 1];
      if (!entry) continue;
      const verdict = typeof decision["decision"] === "string" ? decision["decision"].toLowerCase() : "";
      const change = changes[entry.at] as Extract<MemoryChange, { op: "add" }>;
      if (verdict === "skip") keep[entry.at] = false;
      else if (verdict === "replace") {
        const id = typeof decision["id"] === "string" ? decision["id"] : "";
        const target = entry.similar.find((line) => line.id === id);
        if (!target || target.by === "user" || target.pinned) {
          keep[entry.at] = false;
          continue;
        }
        out[entry.at] = {
          op: "supersede",
          line: target.id,
          text: change.text,
          ...(change.why ? { why: change.why } : {}),
          ...(change.part !== target.part ? { part: change.part } : {}),
          ...(change.layer !== undefined ? { layer: change.layer } : {}),
          ...(change.source ? { source: change.source } : {}),
          reason: "said again, newer or more exact",
          evidence: change.source ? `restated in ${change.source.chat.slice(0, 8)}` : "restated by a fold",
          ...(change.quarantined ? { quarantined: true } : {}),
        };
      }
    }
  }
  const kept = out.filter((_, at) => keep[at]);
  return { changes: kept, skipped: changes.length - kept.length };
}

/**
 * Fold finished turns into the memory: the model's ops, read and checked,
 * then held up against the memory for repeats. The changes come back for
 * the log to apply; an answer with nothing usable in it is no changes at
 * all — never a memory emptied.
 */
export async function foldTurns(
  input: FoldInput,
  ask: Ask,
): Promise<{ changes: MemoryChange[]; ops: number; skipped: number; answered: boolean }> {
  if (input.turns.length === 0) return { changes: [], ops: 0, skipped: 0, answered: true };
  const reply = await ask(DELTA_SYSTEM, foldPrompt(input), 4000);
  const ops = parseOps(reply);
  const answered = ops.length > 0 || /"ops"\s*:\s*\[\s*\]/.test(reply);
  const changes = opsToChanges(ops, input);
  const { changes: kept, skipped } = await withoutRepeats(changes, input.lines, ask);
  return { changes: kept, ops: ops.length, skipped, answered };
}
