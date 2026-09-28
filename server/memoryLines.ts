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

/** How many lines each part keeps across the project — what catchup.md
 *  holds, and every session reads. */
export const MEMORY_CAPS: Record<MemoryPart, number> = {
  now: 4,
  decisions: 12,
  worked: 8,
  failed: 10,
  gotchas: 10,
  open: 8,
};

/** How many each layer keeps of its own, beside those — read only with
 *  that layer's sheet, by a session about to work there. Where the work
 *  stands is the project's, never one layer's. */
export const LAYER_CAPS: Record<MemoryPart, number> = {
  now: 0,
  decisions: 6,
  worked: 4,
  failed: 5,
  gotchas: 6,
  open: 5,
};

/** A part's cap for the lines of one layer, or of the whole project. */
function capOf(part: MemoryPart, layer: string | undefined): number {
  return layer ? LAYER_CAPS[part] : MEMORY_CAPS[part];
}

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
    ...(part !== "now" && str(value["layer"]) ? { layer: str(value["layer"])! } : {}),
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

/** A part brought within its caps — the project's lines within the
 *  project's, each layer's within a layer's: pinned lines always stay, the
 *  rest in the order given until their share is full. */
function capped(part: MemoryPart, lines: MemoryLine[]): MemoryLine[] {
  const room = new Map<string, number>();
  const left = (line: MemoryLine) => room.get(line.layer ?? "") ?? capOf(part, line.layer);
  for (const line of lines) if (line.pinned) room.set(line.layer ?? "", left(line) - 1);
  return lines.filter((line) => {
    if (line.pinned) return true;
    const n = left(line);
    room.set(line.layer ?? "", n - 1);
    return n > 0;
  });
}

/** One entry of a part as the model returns it: a line kept by `id` alone,
 *  one of its own reworded (`id` and `text`), or a new one, with the
 *  exchange it came from (`from`, a ref like 7a3637b4#16). `layer` files it
 *  under a layer by slug, or "project" across the project. */
export interface FoldEntry {
  id?: string;
  text?: string;
  why?: string;
  from?: string;
  layer?: string;
}

/** What a fold knows of the stack: the layers' slugs, and the layer an
 *  exchange worked in (from the files it changed) — where a new line the
 *  model filed nowhere goes. */
export interface FoldLayers {
  slugs: Set<string>;
  of?: (source: MemorySource) => string | undefined;
}

/** A line's layer after a fold: the one the model named, "project" for
 *  none, or — named neither — the one it had, or its exchange's. */
function foldedLayer(
  part: MemoryPart,
  entry: FoldEntry,
  had: string | undefined,
  source: MemorySource | undefined,
  layers: FoldLayers | undefined,
): string | undefined {
  if (part === "now" || !layers) return undefined;
  const named = entry.layer?.trim();
  if (named === "project") return undefined;
  if (named && layers.slugs.has(named)) return named;
  if (had && layers.slugs.has(had)) return had;
  return source && !had ? layers.of?.(source) : undefined;
}

/** A line with its layer set, or taken off. */
function filed(line: MemoryLine, layer: string | undefined): MemoryLine {
  const { layer: _was, ...rest } = line;
  return layer ? { ...rest, layer } : rest;
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
  layers?: FoldLayers,
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
        // the user's lines stay where the user put them; the model may file
        // its own and the agents' under the layer they are about
        const mine = kept.by !== "user" && !kept.pinned;
        const line = mine ? filed(kept, foldedLayer(part, entry, kept.layer, undefined, layers)) : kept;
        // only the model's own lines are the model's to reword
        if (text && kept.by === "model" && !kept.pinned) {
          const why = entry.why?.trim() || kept.why;
          const { why: _why, ...rest } = line;
          next[part].push({ ...rest, text, ...(why ? { why } : {}) });
        } else next[part].push(line);
        continue;
      }
      const text = entry.text?.trim();
      if (!text) continue;
      const why = entry.why?.trim();
      const source = entry.from ? resolve(entry.from.trim()) : undefined;
      const layer = foldedLayer(part, entry, undefined, source, layers);
      next[part].push({
        id: newLineId(part, taken),
        text,
        ...(why ? { why } : {}),
        date: today,
        by: "model",
        ...(source ? { source } : {}),
        ...(layer ? { layer } : {}),
      });
    }
  }
  for (const part of MEMORY_PARTS) {
    const missing = current[part].filter((line) => line.pinned && !used.has(line.id));
    next[part] = capped(part, [...missing, ...next[part]]);
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
  const line: MemoryLine = filed(
    { ...input, id: newLineId(part, lineIds(base)) },
    part === "now" ? undefined : input.layer,
  );
  // a line makes room among its own: the project's, or its layer's
  const same = (l: MemoryLine) => (l.layer ?? "") === (line.layer ?? "");
  let lines = [...base[part], line];
  while (lines.filter(same).length > capOf(part, line.layer)) {
    const oldest = (by: MemoryLine["by"]) =>
      lines
        .filter((l) => same(l) && l.by === by && !l.pinned && l !== line)
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

/** The lines that hold across the project (`layer` absent), or those of one
 *  layer — every part, the empty ones included. */
export function linesOf(memory: ProjectMemory | undefined, layer?: string): ProjectMemory {
  const out = emptyMemory();
  if (!memory) return out;
  for (const part of MEMORY_PARTS) out[part] = memory[part].filter((line) => line.layer === layer);
  return out;
}

/** How many lines each layer has of its own, by slug. */
export function layerCounts(memory: ProjectMemory | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!memory) return counts;
  for (const { line } of allLines(memory)) {
    if (line.layer) counts.set(line.layer, (counts.get(line.layer) ?? 0) + 1);
  }
  return counts;
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
