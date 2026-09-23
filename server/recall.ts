import type { TranscriptEvent } from "../shared/protocol.js";
import type { TurnSummary } from "./archive.js";

/**
 * Finding the exchanges that bear on something — `ruri recall <words>`
 * across every chat in a project, and the brief's pick of what bears on
 * the prompt it rides in with (server/compaction.ts).
 *
 * No model and no index: an exchange is its notes, the user's words, the
 * reply's opening and close, and the files it changed, and a query is
 * scored against them the way a search engine's first cut does (BM25) —
 * rare words that match count for more than common ones. It is a few
 * milliseconds over a long project, and it is only ever run when asked.
 */

/** One exchange, whole. */
export interface Exchange {
  chat: string;
  n: number;
  turnId: string;
  ts: number;
  user: string;
  assistant: string;
  tools: string[];
  files: string[];
  note?: TurnSummary;
}

/**
 * A changed file as the project names it. The transcript's diffs show a
 * path inside the project as "<project name>/<path>" (the shortening tool
 * chips use); everything that sends a session to a file wants it relative
 * to the project, where the session's shell stands.
 */
export function projectRelative(file: string, projectName?: string): string {
  return projectName && file.startsWith(`${projectName}/`) ? file.slice(projectName.length + 1) : file;
}

/** A chat's exchanges, numbered as its history numbers them. */
export function exchangesOf(
  chat: string,
  events: TranscriptEvent[],
  summaries: Record<string, TurnSummary>,
  projectName?: string,
): Exchange[] {
  const out: Exchange[] = [];
  let open: Exchange | null = null;
  for (const event of events) {
    if (event.kind === "user") {
      open = {
        chat,
        n: out.length + 1,
        turnId: event.id,
        ts: event.ts,
        user: event.text,
        assistant: "",
        tools: [],
        files: [],
        ...(summaries[event.id] ? { note: summaries[event.id] } : {}),
      };
      out.push(open);
    } else if (!open) {
      continue;
    } else if (event.kind === "assistant") {
      open.assistant += (open.assistant ? "\n\n" : "") + event.text;
    } else if (event.kind === "tool") {
      open.tools.push(`${event.name} — ${event.summary}`);
      const file = event.diff?.path && projectRelative(event.diff.path, projectName);
      if (file && !open.files.includes(file)) open.files.push(file);
    } else if (event.kind === "compaction") {
      open = null;
    }
  }
  return out;
}

const STOP = new Set(
  (
    "the and for are but not you your yours with this that these those from have has had was were " +
    "will would can could should shall may might must into onto over under then than them they their " +
    "there here what when where which who whom why how all any each few more most other some such only " +
    "own same too very just also again about above after before below between both during through until " +
    "while its it's i'm i've i'd i'll we're we've let's don't doesn't didn't isn't aren't wasn't can't " +
    "won't make made like want need get got one two out off yes yeah okay ok please thanks thank now new " +
    "use using used able still even really thing things stuff way lot much many good fine sure maybe " +
    "change work works general best think look fix add try know going gonna idk kinda something " +
    "anything everything right let see say tell show put take give keep done doing does did want wanna " +
    "actually basically literally probably pretty kind sort bit"
  ).split(" "),
);

/** A word brought to a common form: lowercase, a plural's or tense's end
 *  taken off, so "rewinds" meets "rewind" and "compacted" meets "compact". */
function stem(word: string): string {
  if (word.length > 5 && word.endsWith("ing")) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith("ed")) return word.slice(0, -2);
  if (word.length > 4 && word.endsWith("es")) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The words of a text that could mean something to a search. A path
 *  counts whole and by its parts: "server/compaction.ts" is that, and
 *  "compaction". */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9_./#-]+/)) {
    const word = raw.replace(/^[./#-]+|[./#-]+$/g, "");
    if (!word) continue;
    // a path or a hyphenated name counts whole, as written, and by its parts
    const whole = /[./-]/.test(word) ? word : undefined;
    if (whole) out.push(whole);
    for (const part of word.split(/[./_-]+/)) {
      if (part === whole || part.length < 3 || STOP.has(part) || /^\d+$/.test(part)) continue;
      out.push(stem(part));
    }
  }
  return out;
}

/** What of an exchange a search reads, and how much each part counts. */
function fields(ex: Exchange): Array<[string, number]> {
  const reply =
    ex.assistant.length > 6000 ? `${ex.assistant.slice(0, 4000)} ${ex.assistant.slice(-2000)}` : ex.assistant;
  return [
    [`${ex.note?.user ?? ""} ${ex.note?.reply ?? ""}`, 2],
    [ex.user.slice(0, 4000), 1.5],
    [reply, 1],
    [ex.files.join(" "), 2],
  ];
}

interface Doc<T> {
  item: T;
  tf: Map<string, number>;
  length: number;
}

function docOf<T>(item: T, parts: Array<[string, number]>): Doc<T> {
  const tf = new Map<string, number>();
  let length = 0;
  for (const [text, weight] of parts) {
    for (const term of terms(text)) {
      tf.set(term, (tf.get(term) ?? 0) + weight);
      length += weight;
    }
  }
  return { item, tf, length };
}

/**
 * Things ranked by how well they match a query, best first — BM25 over
 * whatever text `parts` gives each. `min` is how many of the query's words
 * a hit must share, so one common word in a long reply is not a match.
 */
export function rank<T>(
  items: T[],
  query: string,
  parts: (item: T) => Array<[string, number]>,
  options: { limit?: number; min?: number } = {},
): Array<{ item: T; score: number; matched: string[] }> {
  const wanted = [...new Set(terms(query))];
  if (wanted.length === 0 || items.length === 0) return [];
  const docs = items.map((item) => docOf(item, parts(item)));
  const avg = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const df = new Map(wanted.map((t) => [t, docs.filter((d) => d.tf.has(t)).length]));
  const k1 = 1.2;
  const b = 0.75;
  const min = options.min ?? Math.min(2, wanted.length);
  return docs
    .map((doc) => {
      let score = 0;
      const matched: string[] = [];
      for (const term of wanted) {
        const f = doc.tf.get(term);
        if (!f) continue;
        matched.push(term);
        const n = df.get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * doc.length) / avg)));
      }
      return { item: doc.item, score, matched };
    })
    .filter((hit) => hit.matched.length >= min && hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 10);
}

export function rankExchanges(
  exchanges: Exchange[],
  query: string,
  options: { limit?: number; min?: number } = {},
): Array<{ item: Exchange; score: number; matched: string[] }> {
  return rank(exchanges, query, fields, options);
}

const flat = (text: string, max: number) => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** An exchange in one line, as a search lists it. */
export function exchangeLine(ex: Exchange): string {
  return `user: ${flat(ex.note?.user || ex.user, 140)} / agent: ${flat(ex.note?.reply || ex.assistant, 200)}`;
}

/** An exchange whole, as `ruri recall show` prints it. */
export function exchangeText(ex: Exchange, heading: string, budget = 40_000): string {
  const parts = [heading, "", "## The user", "", ex.user.trim()];
  if (ex.files.length) parts.push("", "## Files it changed", "", ...ex.files.map((f) => `- ${f}`));
  if (ex.tools.length) {
    const shown = ex.tools.slice(0, 80);
    parts.push("", "## Tools", "", ...shown.map((t) => `- ${flat(t, 200)}`));
    if (ex.tools.length > shown.length) parts.push(`- … and ${ex.tools.length - shown.length} more`);
  }
  parts.push("", "## The agent", "", ex.assistant.trim() || "(no reply)");
  const text = parts.join("\n");
  if (text.length <= budget) return text;
  // the close of a reply says what it did and what it would do next
  return `${text.slice(0, Math.floor(budget * 0.4))}\n\n[… ${text.length - budget} characters cut …]\n\n${text.slice(-Math.floor(budget * 0.6))}`;
}
