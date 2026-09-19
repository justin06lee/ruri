/** Fuzzy matching for the switcher (components/Switcher.tsx). */

/**
 * How well `text` answers `query`, or null for not at all. A name that
 * starts with the query beats one with a word that does, which beats one
 * containing it, which beats the letters merely appearing in order — and
 * shorter names win ties, since they are the closer match.
 */
export function score(query: string, text: string): number | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.startsWith(q)) return 1000 - t.length;
  const words = t.split(/[\s/_.-]+/);
  if (words.some((word) => word.startsWith(q))) return 800 - t.length;
  const at = t.indexOf(q);
  if (at >= 0) return 600 - at - t.length;
  // in order, with gaps: each gap costs, so "fui" finds "Frontend UI"
  // ahead of some longer thing the letters happen to be scattered through
  let i = 0;
  let gaps = 0;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j += 1) {
    if (t[j] !== q[i]) continue;
    if (last >= 0 && j !== last + 1) gaps += 1;
    last = j;
    i += 1;
  }
  if (i < q.length) return null;
  return 300 - gaps * 20 - t.length;
}
