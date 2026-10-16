import type { NamedComponent } from "./protocol.js";

/**
 * Finding a component by what someone means, not by what it is filed as.
 *
 * One search for the `ruri search` command and the Components page, so an
 * agent and the user find the same things. People ask for "the confirmation
 * dialog", "price cards", "the nav" — and the entry says "confirm-dialog",
 * "pricing card", "the top bar". Every word having to appear verbatim found
 * none of those. So the words are cut down to their stems ("prices",
 * "pricing" → "pric"), a short word finds the longer ones it starts
 * ("nav" → "navbar"), the usual interface synonyms count (a modal is a
 * dialog), a typo of one letter in a longer word still lands, and a query
 * that matches only some of its words is ranked below one that matches all
 * of them rather than thrown away.
 */

/** Words that say nothing about which component is meant. */
const STOP = new Set([
  "the",
  "a",
  "an",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "with",
  "and",
  "or",
  "that",
  "which",
  "this",
  "is",
  "it",
  "its",
  "my",
  "our",
  "your",
  "thing",
  "component",
  "components",
  "ui",
]);

/** A word cut down to what its forms share: "prices", "pricing" and
 *  "price" all come to "pric"; "confirmation" to "confirm". */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/'s$/, "");
  if (w.length <= 3) return w;
  // the first ending that fits comes off, and only that one
  const endings: Array<[string, string]> = [
    ["ies", "y"],
    ["ations", ""],
    ["ation", ""],
    ["ings", ""],
    ["ing", ""],
    ["ers", ""],
    ["er", ""],
    ["ses", "s"],
    ["es", ""],
  ];
  const ending = endings.find(([suffix]) => w.endsWith(suffix) && w.length - suffix.length >= 3);
  if (ending) w = w.slice(0, w.length - ending[0].length) + ending[1];
  else if (w.endsWith("s") && !w.endsWith("ss") && w.length - 1 >= 3) w = w.slice(0, -1);
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/** The words in some text: camelCase and kebab-case taken apart, lower case. */
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Interface words that mean the same thing. */
const SYNONYMS: string[][] = [
  ["modal", "dialog", "popup", "popover", "overlay", "lightbox"],
  ["nav", "navigation", "navbar", "menubar", "topbar"],
  ["toast", "notification", "snackbar"],
  ["button", "btn"],
  ["card", "tile"],
  ["sidebar", "drawer", "sidenav"],
  ["dropdown", "select", "picker", "combobox"],
  ["tooltip", "hint"],
  ["settings", "preferences", "options"],
  ["icon", "glyph"],
  ["spinner", "loader", "loading"],
  ["input", "field", "textbox"],
  ["badge", "chip", "pill"],
  ["hero", "banner", "splash"],
  ["screen", "page", "view"],
  ["chart", "graph", "plot"],
  ["header", "titlebar"],
  ["delete", "remove"],
  ["avatar", "profile"],
];
const SYNONYM_OF = new Map<string, Set<string>>();
for (const group of SYNONYMS) {
  const stems = new Set(group.map(stem));
  for (const s of stems) SYNONYM_OF.set(s, new Set([...(SYNONYM_OF.get(s) ?? []), ...stems]));
}

/** Whether two words are one edit apart — a typo — for words long enough
 *  that one letter doesn't make them another word. */
function oneEdit(a: string, b: string): boolean {
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** How well one query word lands on one word of an entry: 1 the same,
 *  less for a prefix, a synonym, or a typo; 0 not at all. */
function match(query: string, word: string): number {
  if (query === word) return 1;
  if (query.length >= 3 && word.startsWith(query)) return 0.8;
  if (word.length >= 4 && query.startsWith(word)) return 0.7;
  if (SYNONYM_OF.get(query)?.has(word)) return 0.75;
  if (oneEdit(query, word)) return 0.6;
  return 0;
}

/** An entry's fields as stems, with what a word found in each is worth. */
interface Field {
  weight: number;
  stems: string[];
}

function fields(item: NamedComponent, extra = ""): Field[] {
  const base = (file: string) => file.split(":")[0]!.split("/").pop() ?? file;
  const of = (weight: number, text: string): Field => ({
    weight,
    stems: [...new Set(words(text).map(stem))],
  });
  return [
    of(5, [item.name, item.slug, ...item.aliases].join(" ")),
    of(4, (item.tags ?? []).join(" ")),
    of(2, item.note),
    of(2, item.files.map(base).join(" ")),
    of(1, extra),
    of(0.5, (item.uses ?? []).map(base).join(" ")),
  ];
}

/** The query's words that count, stemmed. */
function terms(query: string): string[] {
  const all = words(query);
  const kept = all.filter((w) => !STOP.has(w));
  return [...new Set((kept.length ? kept : all).map(stem))];
}

/**
 * How well an entry answers a query — 0 for not at all. Each query word
 * scores the best it does in any field (a word in the name is worth more
 * than one in a file path); a query matching only some of its words scores
 * by how much of it matched, and one matching under half of it not at all.
 * `extra` is more text to find it by, worth little: the top of its code.
 */
export function scoreComponent(item: NamedComponent, query: string, extra = ""): number {
  const wanted = terms(query);
  if (wanted.length === 0) return 0;
  const parts = fields(item, extra);
  let total = 0;
  let matched = 0;
  for (const term of wanted) {
    let best = 0;
    for (const field of parts) {
      for (const word of field.stems) best = Math.max(best, field.weight * match(term, word));
    }
    if (best > 0) matched += 1;
    total += best;
  }
  const coverage = matched / wanted.length;
  if (matched === 0 || coverage < 0.5) return 0;
  // the whole query is the name (or one of its others): that is the one
  const phrase = wanted.join(" ");
  const whole = [item.name, item.slug, ...item.aliases].some((name) => terms(name).join(" ") === phrase);
  return total * coverage * coverage + (whole ? 10 : 0);
}

/** The entries a query finds, best first. */
export function searchComponents(
  items: NamedComponent[],
  query: string,
  extra?: (item: NamedComponent) => string,
): NamedComponent[] {
  return items
    .map((item) => ({ item, score: scoreComponent(item, query, extra?.(item) ?? "") }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.item.slug.localeCompare(b.item.slug))
    .map((hit) => hit.item);
}
