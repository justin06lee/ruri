import type { MemoryLine, MemoryPart, MemorySource, ProjectMemory } from "../shared/protocol.js";

/**
 * The working memory as lines that each know when they were learned, where
 * (the exchange — so a reader can check one before leaning on it), and who
 * wrote them.
 *
 * The memory used to be plain strings the small model rewrote whole on
 * every fold, and every rewrite was a chance to bend a line that was right:
 * a fix filed as a failure, a reason nobody gave. So now the model names
 * the lines it keeps by id and they come back exactly as stored; it may
 * reword only its own; an agent's lines (`ruri note`, from the session that
 * did the work) and the user's (from the page) it can keep or, for an
 * agent's, retire — never rephrase — and a pinned line stays whatever the
 * model does.
 */

export const MEMORY_PARTS: MemoryPart[] = ["now", "decisions", "worked", "failed", "gotchas", "open"];

/** How many lines each part keeps. */
export const MEMORY_CAPS: Record<MemoryPart, number> = {
  now: 4,
  decisions: 12,
  worked: 8,
  failed: 10,
  gotchas: 10,
  open: 8,
};

/** The calendar day in the user's own time — the date a person would
 *  write, not UTC's, which is already tomorrow on a US evening. */
export function dayOf(ts = Date.now()): string {
  const d = new Date(ts);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

export function emptyMemory(): ProjectMemory {
  return { now: [], decisions: [], worked: [], failed: [], gotchas: [], open: [] };
}

export function memoryEmpty(memory: ProjectMemory | undefined): boolean {
  return !memory || MEMORY_PARTS.every((part) => memory[part].length === 0);
}

const PREFIX: Record<MemoryPart, string> = {
  now: "n",
  decisions: "d",
  worked: "w",
  failed: "f",
  gotchas: "g",
  open: "o",
};

/** A short id, unique among `taken` (which it joins): the part's letter
 *  and four characters, short enough to type in `ruri forget`. */
export function newLineId(part: MemoryPart, taken: Set<string>): string {
  for (;;) {
    const id = PREFIX[part] + Math.random().toString(36).slice(2, 6).padEnd(4, "0");
    if (taken.has(id)) continue;
    taken.add(id);
    return id;
  }
}

export function lineIds(memory: ProjectMemory | undefined): Set<string> {
  const ids = new Set<string>();
  if (memory) for (const part of MEMORY_PARTS) for (const line of memory[part]) ids.add(line.id);
  return ids;
}

/** Every line, with the part it is in. */
export function allLines(memory: ProjectMemory): Array<{ part: MemoryPart; line: MemoryLine }> {
  return MEMORY_PARTS.flatMap((part) => memory[part].map((line) => ({ part, line })));
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** A line from an older ruri, which kept each as a string with the date on
 *  the end in brackets. */
function fromString(part: MemoryPart, raw: string, taken: Set<string>): MemoryLine {
  const dated = /\s*\((\d{4}-\d{2}-\d{2})\)\s*$/.exec(raw);
  const text = (dated ? raw.slice(0, dated.index) : raw).trim();
  return { id: newLineId(part, taken), text, ...(dated ? { date: dated[1]! } : {}), by: "model" };
}

function fromObject(
  part: MemoryPart,
  value: Record<string, unknown>,
  taken: Set<string>,
): MemoryLine | undefined {
  const text = str(value["text"]);
  if (!text) return undefined;
  const by = value["by"] === "agent" || value["by"] === "user" ? value["by"] : "model";
  const wanted = str(value["id"]);
  const id = wanted && !taken.has(wanted) ? (taken.add(wanted), wanted) : newLineId(part, taken);
  const source = value["source"] as Partial<MemorySource> | undefined;
  const why = str(value["why"]);
  const date = str(value["date"]);
  return {
    id,
    text,
    ...(why ? { why } : {}),
    ...(date ? { date } : {}),
    by,
    ...(source && typeof source.chat === "string" && typeof source.turn === "string"
      ? { source: { chat: source.chat, turn: source.turn } }
      : {}),
    ...(value["pinned"] === true ? { pinned: true } : {}),
  };
}

/** A stored memory, whatever shape it arrives in; undefined when there is
 *  none at all. */
export function readMemory(value: unknown): ProjectMemory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const taken = new Set<string>();
  const memory = emptyMemory();
  for (const part of MEMORY_PARTS) {
    const list = Array.isArray(raw[part]) ? (raw[part] as unknown[]) : [];
    for (const item of list) {
      const line =
        typeof item === "string"
          ? item.trim()
            ? fromString(part, item, taken)
            : undefined
          : item && typeof item === "object"
            ? fromObject(part, item as Record<string, unknown>, taken)
            : undefined;
      if (line) memory[part].push(line);
    }
  }
  return memory;
}

/** A part brought within its cap: pinned lines always stay, the rest in the
 *  order given until the part is full. */
function capped(lines: MemoryLine[], cap: number): MemoryLine[] {
  const pinned = lines.filter((line) => line.pinned).length;
  let room = Math.max(0, cap - pinned);
  return lines.filter((line) => line.pinned || room-- > 0);
}

/** One entry of a part as the model returns it: a line kept by `id` alone,
 *  one of its own reworded (`id` and `text`), or a new one, with the
 *  exchange it came from (`from`, a ref like 7a3637b4#16). */
export interface FoldEntry {
  id?: string;
  text?: string;
  why?: string;
  from?: string;
}

/**
 * The memory after a fold: every part as the model listed it, with the
 * kept lines exactly as they were stored, new lines dated today and traced
 * to their exchange, and every pinned line back where it was if the model
 * left it out.
 */
export function applyFold(
  current: ProjectMemory,
  proposed: Partial<Record<MemoryPart, FoldEntry[]>>,
  today: string,
  resolve: (ref: string) => MemorySource | undefined,
): ProjectMemory {
  const taken = lineIds(current);
  const stored = new Map(allLines(current).map(({ line }) => [line.id, line]));
  const used = new Set<string>();
  const next = emptyMemory();
  for (const part of MEMORY_PARTS) {
    for (const entry of proposed[part] ?? []) {
      const kept = entry.id ? stored.get(entry.id) : undefined;
      if (kept) {
        if (used.has(kept.id)) continue;
        used.add(kept.id);
        const text = entry.text?.trim();
        // only the model's own lines are the model's to reword
        if (text && kept.by === "model" && !kept.pinned) {
          const why = entry.why?.trim() || kept.why;
          const { why: _why, ...rest } = kept;
          next[part].push({ ...rest, text, ...(why ? { why } : {}) });
        } else next[part].push(kept);
        continue;
      }
      const text = entry.text?.trim();
      if (!text) continue;
      const why = entry.why?.trim();
      const source = entry.from ? resolve(entry.from.trim()) : undefined;
      next[part].push({
        id: newLineId(part, taken),
        text,
        ...(why ? { why } : {}),
        date: today,
        by: "model",
        ...(source ? { source } : {}),
      });
    }
  }
  for (const part of MEMORY_PARTS) {
    const missing = current[part].filter((line) => line.pinned && !used.has(line.id));
    next[part] = capped([...missing, ...next[part]], MEMORY_CAPS[part]);
  }
  return next;
}

/**
 * A line added from outside a fold — an agent's `ruri note`, the user's own
 * on the page. When the part is full, the oldest of the model's lines makes
 * room (then the oldest agent's); the user's and pinned lines never do.
 */
export function addLine(
  memory: ProjectMemory | undefined,
  part: MemoryPart,
  input: Omit<MemoryLine, "id">,
): { memory: ProjectMemory; line: MemoryLine } {
  const base = memory ?? emptyMemory();
  const line: MemoryLine = { ...input, id: newLineId(part, lineIds(base)) };
  let lines = [...base[part], line];
  while (lines.length > MEMORY_CAPS[part]) {
    const oldest = (by: MemoryLine["by"]) =>
      lines
        .filter((l) => l.by === by && !l.pinned && l !== line)
        .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""))[0];
    const out = oldest("model") ?? oldest("agent");
    if (!out) break;
    lines = lines.filter((l) => l !== out);
  }
  return { memory: { ...base, [part]: lines }, line };
}

/** Where a line is, by its id. */
export function findLine(
  memory: ProjectMemory | undefined,
  id: string,
): { part: MemoryPart; line: MemoryLine } | undefined {
  if (!memory) return undefined;
  const wanted = id.trim().toLowerCase();
  return allLines(memory).find(({ line }) => line.id.toLowerCase() === wanted);
}

/** The memory with one line changed (or, given nothing, taken out). */
export function replaceLine(memory: ProjectMemory, id: string, next: MemoryLine | undefined): ProjectMemory {
  const out = { ...memory };
  for (const part of MEMORY_PARTS) {
    if (!memory[part].some((line) => line.id === id)) continue;
    out[part] = memory[part].flatMap((line) => (line.id !== id ? [line] : next ? [next] : []));
  }
  return out;
}

/** A line as one line of text: what, and why. */
export function lineText(line: MemoryLine): string {
  return line.why ? `${line.text} — ${line.why}` : line.text;
}

/**
 * A fold's answer, brought up to what happened while the model wrote it:
 * a fold takes seconds, and in them an agent may `ruri note` a line or the
 * user strike, pin or correct one. Those win — the fold is laid over the
 * memory it was given, and every change since is laid over that.
 */
export function rebase(
  folded: ProjectMemory,
  before: ProjectMemory | undefined,
  now: ProjectMemory | undefined,
): ProjectMemory {
  const was = new Map((before ? allLines(before) : []).map(({ line }) => [line.id, line]));
  const is = new Map((now ? allLines(now) : []).map(({ part, line }) => [line.id, { part, line }]));
  let out = folded;
  for (const id of was.keys()) if (!is.has(id)) out = replaceLine(out, id, undefined);
  const present = lineIds(out);
  for (const [id, { part, line }] of is) {
    const old = was.get(id);
    if (!old) {
      if (!present.has(id)) out = { ...out, [part]: [...out[part], line] };
      continue;
    }
    if (JSON.stringify(old) === JSON.stringify(line)) continue;
    // changed since the fold began — the user's or an agent's doing
    out = present.has(id) ? replaceLine(out, id, line) : { ...out, [part]: [...out[part], line] };
  }
  return out;
}
