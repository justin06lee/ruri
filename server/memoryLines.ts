import type {
  MemoryAnchors,
  MemoryCheck,
  MemoryLine,
  MemoryPart,
  MemorySource,
  ProjectMemory,
} from "../shared/protocol.js";

/**
 * The working memory as lines that each know when they were learned, where
 * (the exchange — so a reader can check one before leaning on it), and who
 * wrote them: the parts, their caps, ids, and reading a memory stored by
 * any ruri there has been. What may change a line, and how, is the log's
 * to decide (server/memoryLog.ts).
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

/** Every line, with the part it is in. */
export function allLines(memory: ProjectMemory): Array<{ part: MemoryPart; line: MemoryLine }> {
  return MEMORY_PARTS.flatMap((part) => memory[part].map((line) => ({ part, line })));
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The day an older line carried on its end in brackets — "… (2026-09-22)",
 *  and as often "… (2026-09-22)." with the sentence's full stop after it,
 *  which the first reader of these missed, leaving 38 lines undated with
 *  the date still in their words. */
const TRAILING_DAY = /\s*\((\d{4}-\d{2}-\d{2})\)[.;,]?\s*$/;

/** A line's words with a trailing day taken off, and the day. */
export function splitDay(raw: string): { text: string; date?: string } {
  const dated = TRAILING_DAY.exec(raw);
  return dated ? { text: raw.slice(0, dated.index).trim(), date: dated[1]! } : { text: raw.trim() };
}

/** A line from an older ruri, which kept each as a string with the date on
 *  the end in brackets. */
function fromString(part: MemoryPart, raw: string, taken: Set<string>): MemoryLine {
  const { text, date } = splitDay(raw);
  return { id: newLineId(part, taken), text, ...(date ? { date } : {}), by: "model" };
}

function fromObject(
  part: MemoryPart,
  value: Record<string, unknown>,
  taken: Set<string>,
): MemoryLine | undefined {
  const raw = str(value["text"]);
  if (!raw) return undefined;
  // a line brought over from the strings kept its day in its words
  const split = str(value["date"]) ? { text: raw } : splitDay(raw);
  const text = split.text || raw;
  const by = value["by"] === "agent" || value["by"] === "user" ? value["by"] : "model";
  const wanted = str(value["id"]);
  const id = wanted && !taken.has(wanted) ? (taken.add(wanted), wanted) : newLineId(part, taken);
  const source = value["source"] as Partial<MemorySource> | undefined;
  const why = str(value["why"]);
  const date = str(value["date"]) ?? split.date;
  const check = value["check"] as Partial<MemoryCheck> | undefined;
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
    ...(typeof value["validFrom"] === "number" ? { validFrom: value["validFrom"] } : {}),
    ...(value["anchors"] && typeof value["anchors"] === "object"
      ? { anchors: value["anchors"] as MemoryAnchors }
      : {}),
    ...(check && typeof check.reason === "string" && typeof check.since === "number"
      ? { check: { reason: check.reason, since: check.since } }
      : {}),
    ...(value["quarantined"] === true ? { quarantined: true } : {}),
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

/** What a fold knows of the stack: the layers' slugs, and the layer an
 *  exchange worked in (from the files it changed) — where a new line the
 *  model filed nowhere goes. */
export interface FoldLayers {
  slugs: Set<string>;
  of?: (source: MemorySource) => string | undefined;
}

/** The stack as the memory's fold is told it: a line a layer, by slug —
 *  and what lets a new line find its layer. */
export interface MemoryStack {
  text: string;
  fold: FoldLayers;
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
