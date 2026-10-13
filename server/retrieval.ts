import { cosine } from "./embeddings.js";
import { rank, terms } from "./recall.js";
import { trigramCosine } from "./similarity.js";

/**
 * Finding what bears on a question among a project's exchanges and memory
 * lines, three ways at once, fused: BM25 over the words (rare words that
 * match count most), the character trigrams (a plural, a name run
 * together, "LIFT=9" against "LIFT 10"), and — where a local embedding
 * model is there and has seen the texts (server/embeddings.ts) — meaning.
 * Each ranks the candidates; reciprocal rank fusion (RRF) adds 1/(60 +
 * rank) across the rankings, so a candidate near the top of two beats one
 * at the top of only one.
 *
 * And a floor: the old pick took the best two of a chat whatever their
 * score, and a prompt about the work in hand shares a word with half the
 * conversation, so the brief carried distractors — which cost a model more
 * than they help (Chroma's "context rot"). A candidate is kept only when
 * its words cover enough of the question, or its meaning is close enough.
 */

export interface Candidate<T> {
  item: T;
  /** Unique among the candidates. */
  key: string;
  /** The text its meaning and trigrams are read from. */
  text: string;
  /** What BM25 reads, each part with its weight. */
  fields: Array<[string, number]>;
}

export interface Hit<T> {
  item: T;
  /** The fused score. */
  score: number;
  /** Share of the question's words it has, 0 to 1. */
  matched: number;
  bm25: number;
  trigram: number;
  /** Its meaning's closeness, when both sides were embedded. */
  meaning?: number;
}

/** The meaning side of a search: the question's embedding, and each
 *  candidate's where there is one. */
export interface Meaning<T> {
  query: Float32Array;
  of: (candidate: Candidate<T>) => Float32Array | undefined;
}

export interface Floor {
  /** Share of the question's words, and BM25, both at least this — */
  matched: number;
  bm25: number;
  /** — or a meaning at least this close. */
  meaning: number;
  /** — or trigrams this alike, for a short question. */
  trigram: number;
}

/** The floor the brief's pick holds to, measured on a hand-labelled set of
 *  real queries (scripts/memory-eval.ts): relevant exchanges sat at a cosine
 *  of about 0.75 with nomic-embed-text, the rest at 0.53 with a long tail —
 *  at 0.62 meaning let in four irrelevant for every relevant one; at 0.75 it
 *  adds no noise to what the words find. */
export const BRIEF_FLOOR: Floor = { matched: 0.5, bm25: 3, meaning: 0.75, trigram: 0.5 };
/** `ruri recall` asks to see more, and is read by the one who asked. */
export const RECALL_FLOOR: Floor = { matched: 0.34, bm25: 1.2, meaning: 0.68, trigram: 0.42 };

const K = 60;

/** Rank candidates for `query`, fused, down to the floor. */
export function hybrid<T>(
  candidates: Candidate<T>[],
  query: string,
  options: {
    limit?: number;
    floor?: Floor;
    /** The question's embedding and each candidate's, when there are. */
    meaning?: Meaning<T>;
  } = {},
): Array<Hit<T>> {
  const wanted = [...new Set(terms(query))];
  if (!query.trim() || candidates.length === 0) return [];
  const floor = options.floor ?? BRIEF_FLOOR;
  const lexical = wanted.length
    ? rank(candidates, query, (c) => c.fields, { limit: candidates.length, min: 1 })
    : [];
  const stats = new Map<string, Hit<T>>();
  const stat = (c: Candidate<T>): Hit<T> => {
    let hit = stats.get(c.key);
    if (!hit) {
      hit = { item: c.item, score: 0, matched: 0, bm25: 0, trigram: 0 };
      stats.set(c.key, hit);
    }
    return hit;
  };
  lexical.forEach((hit, i) => {
    const s = stat(hit.item);
    s.bm25 = hit.score;
    s.matched = hit.matched.length / wanted.length;
    s.score += 1 / (K + i + 1);
  });
  const tri = candidates
    .map((c) => ({ c, t: trigramCosine(query, c.text) }))
    .filter((x) => x.t > 0.15)
    .sort((a, b) => b.t - a.t);
  tri.forEach(({ c, t }, i) => {
    const s = stat(c);
    s.trigram = t;
    s.score += 1 / (K + i + 1);
  });
  if (options.meaning) {
    const { query: q, of } = options.meaning;
    const near = candidates
      .flatMap((c) => {
        const v = of(c);
        return v ? [{ c, m: cosine(q, v) }] : [];
      })
      .sort((a, b) => b.m - a.m);
    near.forEach(({ c, m }, i) => {
      const s = stat(c);
      s.meaning = m;
      s.score += 1 / (K + i + 1);
    });
  }
  return [...stats.values()]
    .filter(
      (h) =>
        (h.matched >= floor.matched && h.bm25 >= floor.bm25) ||
        (h.meaning !== undefined && h.meaning >= floor.meaning) ||
        (wanted.length <= 2 && h.trigram >= floor.trigram),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10);
}
