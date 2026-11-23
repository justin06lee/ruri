/**
 * The prompt box as text and a caret, and every way a key changes them.
 * Pure: the composer keeps one of these and draws `layout` of it. Columns
 * are display columns, so a CJK character is two wide and the caret lands
 * where the terminal draws it.
 */
import stringWidth from "string-width";

export interface Edit {
  text: string;
  /** Where the next character goes: an index into `text`. */
  caret: number;
}

export const EMPTY: Edit = { text: "", caret: 0 };

export const at = (text: string): Edit => ({ text, caret: text.length });

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The index one whole character before `i`: an emoji or a composed
 *  syllable goes in one step. */
function back(text: string, i: number): number {
  if (i <= 0) return 0;
  if (text[i - 1] === "\n") return i - 1;
  let last = 0;
  // only the line the caret is on: a long prompt is not walked from its start
  const from = text.lastIndexOf("\n", i - 1) + 1;
  for (const part of segmenter.segment(text.slice(from, i))) last = part.index;
  return from + last;
}

function forward(text: string, i: number): number {
  if (i >= text.length) return text.length;
  // the first whole character from here: a few code units are enough to find it
  for (const part of segmenter.segment(text.slice(i, i + 32))) return i + part.segment.length;
  return i + 1;
}

export function insert(e: Edit, typed: string): Edit {
  const clean = typed.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  return { text: e.text.slice(0, e.caret) + clean + e.text.slice(e.caret), caret: e.caret + clean.length };
}

export function backspace(e: Edit): Edit {
  const from = back(e.text, e.caret);
  return { text: e.text.slice(0, from) + e.text.slice(e.caret), caret: from };
}

export function del(e: Edit): Edit {
  return { text: e.text.slice(0, e.caret) + e.text.slice(forward(e.text, e.caret)), caret: e.caret };
}

export const left = (e: Edit): Edit => ({ ...e, caret: back(e.text, e.caret) });
export const right = (e: Edit): Edit => ({ ...e, caret: forward(e.text, e.caret) });

function wordStart(text: string, i: number): number {
  let at = i;
  while (at > 0 && /\s/.test(text[at - 1]!)) at -= 1;
  while (at > 0 && !/\s/.test(text[at - 1]!)) at -= 1;
  return at;
}

function wordEnd(text: string, i: number): number {
  let at = i;
  while (at < text.length && /\s/.test(text[at]!)) at += 1;
  while (at < text.length && !/\s/.test(text[at]!)) at += 1;
  return at;
}

export const wordLeft = (e: Edit): Edit => ({ ...e, caret: wordStart(e.text, e.caret) });
export const wordRight = (e: Edit): Edit => ({ ...e, caret: wordEnd(e.text, e.caret) });

export function deleteWord(e: Edit): Edit {
  const from = wordStart(e.text, e.caret);
  return { text: e.text.slice(0, from) + e.text.slice(e.caret), caret: from };
}

const lineStart = (text: string, i: number) => text.lastIndexOf("\n", i - 1) + 1;
const lineEnd = (text: string, i: number) => {
  const end = text.indexOf("\n", i);
  return end === -1 ? text.length : end;
};

export const home = (e: Edit): Edit => ({ ...e, caret: lineStart(e.text, e.caret) });
export const end = (e: Edit): Edit => ({ ...e, caret: lineEnd(e.text, e.caret) });

/** Everything before the caret on its line, gone (Ctrl+U). */
export function killToStart(e: Edit): Edit {
  const from = lineStart(e.text, e.caret);
  return { text: e.text.slice(0, from) + e.text.slice(e.caret), caret: from };
}

/** One line of the box as drawn: a stretch of the text. */
interface Row {
  start: number;
  end: number;
}

/** The text cut into the rows a box `width` columns wide draws: a new row
 *  at every newline, and wherever a line runs out of room. */
function rowsOf(text: string, width: number): Row[] {
  const rows: Row[] = [];
  let start = 0;
  for (;;) {
    const stop = lineEnd(text, start);
    let from = start;
    let used = 0;
    let i = start;
    for (const part of segmenter.segment(text.slice(start, stop))) {
      const w = stringWidth(part.segment);
      if (used + w > width && i > from) {
        rows.push({ start: from, end: i });
        from = i;
        used = 0;
      }
      used += w;
      i += part.segment.length;
    }
    rows.push({ start: from, end: stop });
    if (stop >= text.length) break;
    start = stop + 1;
  }
  return rows;
}

/** Which row the caret is on: at a soft wrap it stands at the start of the
 *  next row, not after the end of the one before. */
function rowAt(rows: Row[], caret: number): number {
  for (let r = rows.length - 1; r >= 0; r -= 1) if (caret >= rows[r]!.start) return r;
  return 0;
}

export interface Layout {
  lines: string[];
  /** The caret: which line, and how many columns in. */
  row: number;
  col: number;
}

export function layout(e: Edit, width: number): Layout {
  const rows = rowsOf(e.text, Math.max(1, width));
  const row = rowAt(rows, e.caret);
  return {
    lines: rows.map((r) => e.text.slice(r.start, r.end)),
    row,
    col: stringWidth(e.text.slice(rows[row]!.start, e.caret)),
  };
}

/** The caret one drawn row up or down, as near the same column as that row
 *  has. Undefined when there is no such row: the caller's to act on (the
 *  queue above, the pickers below). */
export function vertical(e: Edit, width: number, by: -1 | 1): Edit | undefined {
  const rows = rowsOf(e.text, Math.max(1, width));
  const row = rowAt(rows, e.caret);
  const target = rows[row + by];
  if (!target) return undefined;
  const col = stringWidth(e.text.slice(rows[row]!.start, e.caret));
  let caret = target.start;
  let used = 0;
  for (const part of segmenter.segment(e.text.slice(target.start, target.end))) {
    const w = stringWidth(part.segment);
    if (used + w > col) break;
    used += w;
    caret += part.segment.length;
  }
  return { ...e, caret };
}
