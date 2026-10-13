import { terms } from "./recall.js";

/**
 * How alike two short lines of text are, 0 to 1, without a model: the
 * words they share that mean something (stemmed, stop words out — the same
 * terms `ruri recall` searches by) and the character trigrams they share,
 * which catch what the words miss — "LIFT=9" against "LIFT 10", a plural,
 * a name run together. It is what finds a memory line saying again what
 * another already says (a fold's new line, an agent's `ruri note`), and
 * the pairs worth asking whether they disagree.
 */

function trigrams(text: string): Map<string, number> {
  const flat = ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()} `;
  const grams = new Map<string, number>();
  for (let i = 0; i + 3 <= flat.length; i++) {
    const gram = flat.slice(i, i + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [key, value] of a) {
    na += value * value;
    const other = b.get(key);
    if (other) dot += value * other;
  }
  for (const value of b.values()) nb += value * value;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The meaningful words of a text, as a set. */
export function wordSet(text: string): Set<string> {
  return new Set(terms(text).filter((term) => !/[./-]/.test(term) || term.length > 3));
}

/** Of the smaller set, how much the other shares: a short line wholly
 *  inside a longer one says the same thing — but two words in common are
 *  not a line's worth ("Windows guest" is in a lot of lines), so a set
 *  counts as at least four words long. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.max(4, Math.min(a.size, b.size));
}

/** How alike two texts' character trigrams are, 0 to 1. */
export function trigramCosine(a: string, b: string): number {
  return cosine(trigrams(a), trigrams(b));
}

/** How alike, 0 to 1 — the mean of the words' overlap and the trigrams'
 *  cosine. */
export function similarity(a: string, b: string): number {
  return (overlap(wordSet(a), wordSet(b)) + cosine(trigrams(a), trigrams(b))) / 2;
}

/** Things ranked by how alike their text is to `text`, most first, down to
 *  `floor`. */
export function mostAlike<T>(
  text: string,
  items: T[],
  textOf: (item: T) => string,
  options: { limit?: number; floor?: number } = {},
): Array<{ item: T; score: number }> {
  const words = wordSet(text);
  const grams = trigrams(text);
  return items
    .map((item) => {
      const other = textOf(item);
      return { item, score: (overlap(words, wordSet(other)) + cosine(grams, trigrams(other))) / 2 };
    })
    .filter((hit) => hit.score >= (options.floor ?? 0))
    .sort((x, y) => y.score - x.score)
    .slice(0, options.limit ?? 5);
}
