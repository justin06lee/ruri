import type { ModelChoice } from "./protocol.js";

/**
 * Which line of models one belongs to, and where in it.
 *
 * ruri names no model of its own: what is new, what is the default and
 * which is the newest of its kind are all read off the catalog the
 * harnesses report. "claude-fable-5-2" is the fable line at 5.2; the alias
 * "opus", named "Opus 5.5" by the catalog, is the opus line at 5.5;
 * "codex:gpt-5.6-luna" is Codex's gpt-luna line at 5.6. So when a newer one
 * is listed — the same line, a higher number — a star, a role or a default
 * that stood on the line's newest can follow it there, and nobody has to
 * come back and retype a version.
 */
export interface ModelLine {
  /** The harness and the family, without the version: "fable",
   *  "codex:gpt-luna". A million-token variant is a line of its own. */
  line: string;
  /** The version, most significant first: [5, 2]. Empty when neither the
   *  id nor the name carries one. */
  version: number[];
}

type Named = Pick<ModelChoice, "value" | "displayName">;

/** A part of an id that is a version number: "5", "5.6" — never a build
 *  date ("20251001"), which is eight digits of something else. */
const NUMBER = /^\d{1,7}(?:\.\d{1,7})*$/;

export function modelLine(model: Named): ModelLine {
  const colon = model.value.indexOf(":");
  const harness = colon > 0 ? model.value.slice(0, colon + 1) : "";
  const id = colon > 0 ? model.value.slice(colon + 1) : model.value;
  const big = /\[1m\]$/i.test(id);
  const parts = id
    .replace(/\[1m\]$/i, "")
    .replace(/^claude-/, "")
    .split(/[-_\s]+/)
    .filter(Boolean);
  const words: string[] = [];
  let version: number[] = [];
  let closed = false;
  for (const part of parts) {
    if (/^\d{8,}$/.test(part)) continue;
    if (NUMBER.test(part) && !closed) {
      version.push(...part.split(".").map(Number));
      continue;
    }
    // the version is one run of numbers; a word after it ends the run
    if (version.length > 0) closed = true;
    words.push(part.toLowerCase());
  }
  // an alias says nothing of which one it is; the catalog's name does
  if (version.length === 0) {
    const named = /\d+(?:\.\d+)*/.exec(model.displayName ?? "")?.[0];
    if (named && named.length < 8) version = named.split(".").map(Number);
  }
  return { line: `${harness}${words.join("-")}${big ? "[1m]" : ""}`, version };
}

/** Which version is the later: positive when `a` is. A longer one is later
 *  than the one it begins with (5.1 after 5). */
export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const d = (a[i] ?? -1) - (b[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** A model's place, by the catalog's name for it when it is listed. */
function lineOf(catalog: readonly Named[], id: string): ModelLine {
  return modelLine(catalog.find((m) => m.value === id) ?? { value: id, displayName: "" });
}

/**
 * The newest model the catalog lists in `id`'s line — `id` itself when it
 * is the newest, stands alone, or says nothing of its version. Of two at
 * one version (an alias and the id it stands for), the one listed first.
 */
export function newestInLine(catalog: readonly Named[], id: string): string {
  const mine = lineOf(catalog, id);
  if (mine.version.length === 0) return id;
  let best = { id, version: mine.version, listed: catalog.some((m) => m.value === id) };
  for (const model of catalog) {
    if (model.value === id) continue;
    const other = modelLine(model);
    if (other.line !== mine.line || other.version.length === 0) continue;
    const later = compareVersions(other.version, best.version);
    if (later > 0 || (later === 0 && !best.listed))
      best = { id: model.value, version: other.version, listed: true };
  }
  return best.id;
}

/**
 * Among ids the catalog used to hold, the one that was the newest of
 * `arrival`'s line before it came — what a star or a role on that line was
 * standing on. Undefined when `arrival` is not the newest of its line, or
 * is the first of it.
 */
export function supersededBy(
  catalog: readonly Named[],
  known: readonly string[],
  arrival: string,
): string | undefined {
  if (newestInLine(catalog, arrival) !== arrival) return undefined;
  const mine = lineOf(catalog, arrival);
  if (mine.version.length === 0) return undefined;
  let before: { id: string; version: number[] } | undefined;
  for (const id of known) {
    if (id === arrival) continue;
    const other = lineOf(catalog, id);
    if (other.line !== mine.line || other.version.length === 0) continue;
    if (compareVersions(other.version, mine.version) >= 0) continue;
    if (!before || compareVersions(other.version, before.version) > 0)
      before = { id, version: other.version };
  }
  return before?.id;
}

/**
 * The id the catalog now lists a model under, when it no longer lists
 * `id`: the first of the same line at the very same version. A harness
 * renames what it lists ("claude-fable-5-2" one day, the alias "fable"
 * named "Fable 5.2" the next), and a star or a default left on the old id
 * would stand on a model nobody is offered. Undefined when `id` is still
 * listed, says nothing of its version, or has no such twin.
 */
export function relisted(catalog: readonly Named[], id: string): string | undefined {
  if (catalog.some((m) => m.value === id)) return undefined;
  const mine = modelLine({ value: id, displayName: "" });
  if (mine.version.length === 0) return undefined;
  return catalog.find((model) => {
    const other = modelLine(model);
    return other.line === mine.line && compareVersions(other.version, mine.version) === 0;
  })?.value;
}

/**
 * The model the catalog itself would start a chat on: the one Claude Code
 * marks as its default, else the first it lists — and with no Claude on the
 * machine, the same of whatever harness is. Undefined for an empty catalog.
 */
export function catalogDefault(catalog: readonly ModelChoice[]): string | undefined {
  const claude = catalog.filter((m) => !m.provider);
  return (
    claude.find((m) => m.providerDefault) ??
    claude[0] ??
    catalog.find((m) => m.providerDefault) ??
    catalog[0]
  )?.value;
}
