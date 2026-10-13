import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { MemoryAnchors, MemoryLine } from "../shared/protocol.js";
import { dayOf } from "./memoryLines.js";
import { gitState, knownBranches, namedBranches, type GitState } from "./gitState.js";

/**
 * A memory line, checked against the code it is about.
 *
 * The memory said "build a skin over unmodified Godot 4.6" for two weeks
 * after the project moved to Bevy, kept "keep env.local on file:../../
 * yagami until v0.12.0" after both package.json files moved to ^0.12.0,
 * and held two values for one icon offset at once. Nothing checked: the
 * only check there was looked at branch names, of one naming. A reader
 * was asked to check a line before leaning on it — `ruri recall show` was
 * run four times in all the chats there were. So ruri checks, not the
 * reader.
 *
 * When a line is written, what it rests on is read off the code and kept
 * with it (its anchors): the files it names and whether they are there,
 * the symbols and whether the code has them, the packages and their
 * versions, the branches — any naming — and whether they are merged, the
 * words the project uses for itself (Godot, Bevy) and whether its README
 * and docs still say them, the values it quotes (LIFT=9) and what the code
 * sets them to, and HEAD. Later checks compare each with what is there
 * now; anything that moved marks the line "may be stale", with what moved,
 * until a check of the line itself (server/memoryCheck.ts) confirms it,
 * corrects it, or retires it.
 *
 * A line from before anchors were kept has nothing to compare with, so it
 * is held up against the code as it stands: a file it names that isn't
 * there, a version it quotes that the package no longer has, a word its
 * project no longer says, a value the code sets differently.
 */

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };

function git(dir: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd: dir, env: ENV, timeout, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

/** ruri's own sheets repeat the memory; nothing is checked against them. */
const NOT_RURI = ":(exclude).ruri";

/* ── the code, as one look at it ───────────────────────────────────── */

export interface PackageDep {
  name: string;
  spec: string;
  file: string;
}

/**
 * One look at a project's code — its files, git, its packages, what it
 * says about itself — with the searches made of it remembered, so checking
 * a whole memory asks git each question once.
 */
export class RepoView {
  readonly fileSet: Set<string>;
  private readonly byBase = new Map<string, string[]>();
  private readonly dirs = new Set<string>();
  private readonly greps = new Map<string, Promise<string[]>>();
  private readonly settings = new Map<string, Promise<Array<{ file: string; value: string }>>>();

  constructor(
    readonly dir: string,
    readonly head: string | undefined,
    readonly files: string[],
    readonly git: GitState | undefined,
    readonly packages: PackageDep[],
    /** What the project says about itself — its README, docs, manifests
     *  and description — lowercased. */
    readonly docs: string,
    readonly at = Date.now(),
  ) {
    this.fileSet = new Set(files);
    for (const file of files) {
      const base = path.posix.basename(file);
      this.byBase.set(base, [...(this.byBase.get(base) ?? []), file]);
      let parent = path.posix.dirname(file);
      while (parent !== "." && !this.dirs.has(parent)) {
        this.dirs.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
  }

  get isRepo(): boolean {
    return this.head !== undefined;
  }

  /** The project's path for a name a line gives — whole, a folder, or a
   *  bare file name that only one file has. */
  resolve(name: string): string | undefined {
    const clean = name.replace(/^\.\//, "").replace(/\/+$/, "");
    if (this.fileSet.has(clean) || this.dirs.has(clean)) return clean;
    if (!clean.includes("/")) {
      const hits = this.byBase.get(clean);
      return hits?.length === 1 ? hits[0] : undefined;
    }
    // a path given from inside a folder of the project ("src/lib/x.ts")
    const tail = this.files.filter((file) => file.endsWith(`/${clean}`));
    return tail.length === 1 ? tail[0] : undefined;
  }

  /** The files (not ruri's) whose text has `word`, whole, any case. */
  grep(word: string): Promise<string[]> {
    let hit = this.greps.get(word);
    if (!hit) {
      hit = this.isRepo
        ? git(this.dir, ["grep", "-I", "-l", "-i", "-w", "-F", "-e", word, "--", ".", NOT_RURI]).then((out) =>
            (out ?? "").split("\n").filter(Boolean),
          )
        : Promise.resolve([]);
      this.greps.set(word, hit);
    }
    return hit;
  }

  /** Where the code sets `name` to a number: `LIFT = 10`, `nudge: 21`. */
  settingsOf(name: string): Promise<Array<{ file: string; value: string }>> {
    let hit = this.settings.get(name);
    if (!hit) {
      const pattern = `(^|[^A-Za-z0-9_])${name}[[:space:]]*[:=][[:space:]]*-?[0-9][0-9.]*`;
      hit = this.isRepo
        ? git(this.dir, ["grep", "-I", "-n", "-E", "-e", pattern, "--", ".", NOT_RURI]).then((out) =>
            (out ?? "")
              .split("\n")
              .filter(Boolean)
              .flatMap((row) => {
                const [file = "", , ...rest] = row.split(":");
                const value = new RegExp(`\\b${name}\\s*[:=]\\s*(-?\\d[\\d.]*)`).exec(rest.join(":"))?.[1];
                return value ? [{ file, value: value.replace(/\.$/, "") }] : [];
              })
              .slice(0, 12),
          )
        : Promise.resolve([]);
      this.settings.set(name, hit);
    }
    return hit;
  }

  /** Whether the project, in what it says of itself, says `term`. */
  says(term: string): boolean {
    return new RegExp(`(^|[^a-z0-9])${escape(term.toLowerCase())}([^a-z0-9]|$)`).test(this.docs);
  }

  /** The files changed since `sha`, of those given — undefined when git
   *  doesn't know the commit. */
  async changedSince(sha: string, paths: string[]): Promise<string[] | undefined> {
    if (!this.isRepo || paths.length === 0) return [];
    const out = await git(this.dir, ["diff", "--name-only", `${sha}..HEAD`, "--", ...paths]);
    return out === undefined ? undefined : out.split("\n").filter(Boolean);
  }

  /** The lines a diff since `sha` added or took out, in these files. */
  async changedLines(sha: string, paths: string[]): Promise<string> {
    if (!this.isRepo || paths.length === 0) return "";
    const out = await git(this.dir, ["diff", "-U0", "--no-color", `${sha}..HEAD`, "--", ...paths]);
    return (out ?? "")
      .split("\n")
      .filter((row) => /^[+-]/.test(row) && !/^(\+\+\+|---)/.test(row))
      .join("\n");
  }
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every dependency a package.json declares, by name. */
function packageJsonDeps(file: string, text: string): PackageDep[] {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((key) => {
      const deps = json[key];
      if (!deps || typeof deps !== "object") return [];
      return Object.entries(deps as Record<string, unknown>).flatMap(([name, spec]) =>
        typeof spec === "string" ? [{ name, spec, file }] : [],
      );
    });
  } catch {
    return [];
  }
}

/** A Cargo.toml's dependencies, the simple forms. */
function cargoDeps(file: string, text: string): PackageDep[] {
  const out: PackageDep[] = [];
  let inDeps = false;
  for (const row of text.split("\n")) {
    const header = /^\s*\[([^\]]+)\]/.exec(row);
    if (header) {
      inDeps = /(^|\.)(dev-|build-)?dependencies$/.test(header[1]!.trim());
      continue;
    }
    if (!inDeps) continue;
    const simple = /^\s*([\w-]+)\s*=\s*"([^"]+)"/.exec(row);
    const table = /^\s*([\w-]+)\s*=\s*\{.*?(?:version\s*=\s*"([^"]+)"|path\s*=\s*"([^"]+)")/.exec(row);
    if (simple) out.push({ name: simple[1]!, spec: simple[2]!, file });
    else if (table) out.push({ name: table[1]!, spec: table[2] ?? `path:${table[3]}`, file });
  }
  return out;
}

/** The files a project describes itself in. */
function selfDescribing(file: string): boolean {
  if (file.includes("/node_modules/")) return false;
  const depth = file.split("/").length;
  if (
    /^(readme|changelog|contributing|agents|claude)(\.[\w-]+)?\.md$/i.test(path.posix.basename(file)) &&
    depth <= 2
  )
    return true;
  if (depth === 1 && /\.(md|txt)$/i.test(file)) return true;
  if (/^docs\/.*\.md$/i.test(file)) return true;
  return /^(Makefile|justfile|package\.json|Cargo\.toml|pyproject\.toml)$/.test(file);
}

/** Read the project as it is now. `about` is what ruri's sheet says it is
 *  (its description, its layers), read as part of what it says of itself. */
export async function lookAt(dir: string, about = ""): Promise<RepoView> {
  const [head, listed, state] = await Promise.all([
    git(dir, ["rev-parse", "--short", "HEAD"]),
    git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]),
    gitState(dir),
  ]);
  const files = (listed ?? "")
    .split("\0")
    .filter((file) => file && !file.startsWith(".ruri/"))
    .slice(0, 200_000);
  const read = (file: string, max = 200_000) => {
    try {
      const text = fs.readFileSync(path.join(dir, file), "utf8");
      return text.length > max ? text.slice(0, max) : text;
    } catch {
      return "";
    }
  };
  const packages = files.flatMap((file) => {
    if (file.includes("node_modules/") || file.split("/").length > 3) return [];
    if (file.endsWith("package.json") && path.posix.basename(file) === "package.json") {
      return packageJsonDeps(file, read(file));
    }
    if (path.posix.basename(file) === "Cargo.toml" && file.split("/").length <= 2)
      return cargoDeps(file, read(file));
    return [];
  });
  let budget = 400_000;
  const docs: string[] = [about];
  for (const file of files.filter(selfDescribing).slice(0, 80)) {
    if (budget <= 0) break;
    const text = read(file, Math.min(budget, 60_000));
    budget -= text.length;
    docs.push(text);
  }
  return new RepoView(dir, head?.trim() || undefined, files, state, packages, docs.join("\n").toLowerCase());
}

/* ── what a line rests on ──────────────────────────────────────────── */

const PATHISH =
  /(?<![\w@~/.:-])((?:\.\/)?[\w@-][\w@.-]*(?:\/[\w@.-]+)+\/?|[\w@-]+\.(?:tsx?|jsx?|mjs|cjs|json|md|css|scss|html|py|rs|go|toml|ya?ml|sh|swift|kt|java|rb|c|h|cpp|hpp|wgsl|lock|plist|xml|sql))(?![\w/@-])/g;

/** Words that start a sentence or a line of memory, or that every project
 *  says — never a sign of what one project is built on. */
const COMMON = new Set(
  (
    "a an the and or but if when while each every all any both no not never always only also then than " +
    "use uses used using keep keeps run runs build builds make makes add adds fix fixes set sets get gets " +
    "user users app apps this that these those it its they them there here what which who why how one two " +
    "three next now later new old done open first last before after with without on in at for from to of by " +
    "do does did don't is are was were be been has have had can could should would will may might must " +
    "mac macos linux windows ios android ubuntu debian arch gnome kde x11 wayland electron chrome chromium " +
    "firefox safari git github gitlab npm bun node nodejs yarn pnpm python rust go typescript javascript " +
    "react vite claude codex opencode gemini goose gpt sonnet opus haiku fable openai anthropic llm ai api " +
    "json yaml toml html css sql http https ssh cli ui ux pr ci cd mcp sdk url id ok todo note see " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july " +
    "august september october november december settings studio desktop server client home dock menu"
  ).split(" "),
);

/** The dictionary, where the machine has one: a capitalised dictionary
 *  word ("Brain", "Nested") is somebody's sentence, not the name of what a
 *  project is built on (Godot, MuJoCo, Janelia). */
let dictionary: Set<string> | null | undefined;
function inDictionary(word: string): boolean {
  if (dictionary === undefined) {
    try {
      dictionary = new Set(fs.readFileSync("/usr/share/dict/words", "utf8").toLowerCase().split("\n"));
    } catch {
      dictionary = null;
    }
  }
  if (!dictionary) return false;
  const lower = word.toLowerCase();
  // the dictionary has "theme", not "themes"; "fold", not "folded"
  const stems = [
    lower,
    lower.replace(/s$/, ""),
    lower.replace(/es$/, ""),
    lower.replace(/ies$/, "y"),
    lower.replace(/ed$/, ""),
    lower.replace(/d$/, ""),
    lower.replace(/ing$/, ""),
    lower.replace(/ing$/, "e"),
  ];
  return stems.some((stem) => stem.length >= 3 && dictionary!.has(stem));
}

/** The words a line names its world by: capitalised past the sentence's
 *  start (Godot, MuJoCo, Janelia), not a common or dictionary word, not an
 *  acronym's plural, not code. The line's words and its reason are read
 *  apart, each starting a sentence. */
function termsOf(...texts: string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(/(?<=^|[^\w./@-])([A-Z][a-zA-Z0-9]*[a-z][a-zA-Z0-9]*)(?![\w./@-])/g)) {
      const word = match[1]!;
      const at = match.index ?? 0;
      const before = text.slice(0, at).trimEnd();
      if (word.length < 4 || /^[A-Z]{2,}s$/.test(word) || COMMON.has(word.toLowerCase())) continue;
      if (/^[A-Z][a-z]+$/.test(word) && inDictionary(word)) continue;
      // the first word of the line or of a sentence is capitalised anyway:
      // with a dictionary to say it isn't a word ("Godot go/no-go") it is
      // kept, without one it can't be told from one
      if (
        (before === "" || /[.!?:;—–(-]$/.test(before)) &&
        (dictionary === null || COMMON.has(word.toLowerCase()))
      ) {
        continue;
      }
      out.add(word);
    }
  }
  return [...out].slice(0, 6);
}

/** Identifiers a line names: in backticks, or shaped like code. */
function symbolsOf(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(/`([^`\s]{3,80})`/g)) {
    const word = match[1]!;
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/.test(word)) out.add(word.replace(/\(\)$/, ""));
  }
  for (const match of text.matchAll(
    /(?<![\w./@`-])([a-z]+[A-Z][\w$]*|[A-Z][a-z0-9]+[A-Z][\w$]*|[A-Za-z][a-z0-9]*_[\w$]+|[A-Z][A-Z0-9]*_[A-Z0-9_]+)(?![\w/@`-])/g,
  )) {
    const word = match[1]!;
    if (word.length >= 5) out.add(word);
  }
  return [...out].slice(0, 6);
}

/** "LIFT=9", "LIFT 10", "NUDGE: 21" — a name and the number a line gives it. */
function valuesOf(text: string): Array<{ name: string; value: string }> {
  const out = new Map<string, string>();
  for (const match of text.matchAll(
    /\b([A-Z][A-Z0-9_]{2,}|[a-z]+[A-Z][\w]*)\s*(?:=|:|\s)\s*(-?\d+(?:\.\d+)?)(?![\d.]*[A-Za-z%])/g,
  )) {
    if (!out.has(match[1]!)) out.set(match[1]!, match[2]!);
  }
  return [...out].map(([name, value]) => ({ name, value })).slice(0, 6);
}

/** Version specs a line quotes: file:../x, ^0.12.0, ~1.2.3 — a range
 *  with its dots, so "~27s" (about 27 seconds) is not one. */
const SPEC =
  /(?<![\w/.-])((?:file|link|workspace|portal):[^\s,;)`'"]+|\^\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?|~\d+\.\d+\.\d+(?:-[\w.]+)?)(?![\w.])/g;

/** The specs a text quotes for one package: a link to it by name
 *  anywhere, a range within a few words of its name. */
function specsFor(text: string, name: string): string[] {
  const bare = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const lower = text.toLowerCase();
  const near: Array<[number, number]> = [];
  for (const word of new Set([name.toLowerCase(), bare])) {
    let at = lower.indexOf(word);
    while (at !== -1) {
      near.push([at - 30, at + word.length + 60]);
      at = lower.indexOf(word, at + word.length);
    }
  }
  const out = new Set<string>();
  for (const match of text.matchAll(SPEC)) {
    const spec = match[1]!;
    const at = match.index ?? 0;
    if (/^[a-z]+:/.test(spec)) {
      if (spec.toLowerCase().includes(bare)) out.add(spec);
    } else if (near.some(([from, to]) => at >= from && at <= to)) out.add(spec);
  }
  return [...out];
}

/** The dependencies a line names, by their full name or their last part. */
function packagesOf(text: string, view: RepoView): PackageDep[] {
  const lower = text.toLowerCase();
  const out = new Map<string, PackageDep>();
  const names = new Set(view.packages.map((dep) => dep.name));
  for (const name of names) {
    const bare = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
    const said =
      lower.includes(name.toLowerCase()) ||
      (bare.length >= 4 && new RegExp(`(^|[^a-z0-9-])${escape(bare)}([^a-z0-9-]|$)`).test(lower));
    if (!said) continue;
    for (const dep of view.packages.filter((d) => d.name === name)) out.set(`${dep.name}@${dep.file}`, dep);
  }
  return [...out.values()].slice(0, 8);
}

/** The paths a line names that are the project's (not ~, /tmp or a URL). */
function pathsOf(text: string, view: RepoView): Array<{ path: string; exists: boolean }> {
  const branches = view.git ? new Set(knownBranches(view.git).keys()) : new Set<string>();
  const out = new Map<string, boolean>();
  for (const match of text.matchAll(PATHISH)) {
    const raw = match[1]!.replace(/[.,;:]+$/, "");
    if (raw.includes("://") || raw.startsWith("..") || branches.has(raw) || /^(and|or|w)\//i.test(raw))
      continue;
    if (/^[~/]/.test(raw)) continue;
    const found = view.resolve(raw);
    if (found) out.set(found, true);
    // one that isn't there counts only when it reads like a path into the
    // project — a folder of its, or a file's name at the end. A bare file
    // name ("settings.json") is as likely a file somewhere else, and
    // "light/dark/ember" is a list
    else if (raw.includes("/") && (/\.[a-z]{1,5}$/i.test(raw) || view.resolve(raw.split("/")[0]!))) {
      out.set(raw, false);
    }
  }
  return [...out].map(([p, exists]) => ({ path: p, exists })).slice(0, 8);
}

/** Everything a line rests on, as the code has it now. */
export async function anchorsOf(text: string, view: RepoView): Promise<MemoryAnchors> {
  const symbols = symbolsOf(text);
  const values = valuesOf(text);
  const paths = pathsOf(text, view);
  const pathNames = new Set(paths.map((p) => path.posix.basename(p.path)));
  const terms = termsOf(...text.split("\u0000")).filter((t) => !symbols.includes(t) && !pathNames.has(t));
  const found = await Promise.all(
    symbols.map(async (name) => ({ name, found: (await view.grep(name)).length > 0 })),
  );
  const set = await Promise.all(
    values.map(async ({ name, value }) => {
      const where = await view.settingsOf(name);
      // the code's value where it sets one, else the line's own
      return where.length ? { name, value: where[0]!.value, file: where[0]!.file } : { name, value };
    }),
  );
  const branches = view.git
    ? namedBranches(text, view.git).map((name) => {
        const branch = knownBranches(view.git!).get(name);
        const state: "unmerged" | "merged" | "gone" | "mainline" = !branch
          ? "gone"
          : name === view.git!.mainline
            ? "mainline"
            : branch.merged
              ? "merged"
              : "unmerged";
        return { name, state };
      })
    : [];
  const packages = packagesOf(text, view).map(({ name, spec, file }) => ({ name, spec, file }));
  return {
    ...(view.head ? { sha: view.head } : {}),
    at: view.at,
    ...(paths.length ? { paths } : {}),
    ...(found.length ? { symbols: found } : {}),
    ...(packages.length ? { packages } : {}),
    ...(branches.length ? { branches } : {}),
    ...(terms.length ? { terms: terms.map((term) => ({ term, present: view.says(term) })) } : {}),
    ...(set.length ? { values: set } : {}),
  };
}

/** Whether anchors name anything the code can confirm. */
export function anchored(anchors: MemoryAnchors | undefined): boolean {
  return !!(
    anchors &&
    (anchors.paths?.length ||
      anchors.symbols?.length ||
      anchors.packages?.length ||
      anchors.branches?.length ||
      anchors.terms?.length ||
      anchors.values?.length)
  );
}

/* ── checking ──────────────────────────────────────────────────────── */

/**
 * What a check found, and its anchors as the code has them now. `strong`:
 * something the line rests on moved — a file or symbol gone, a version, a
 * value, a branch — and the line says "may be stale" wherever it is read
 * until it is checked. `weak`: something the line names isn't where the
 * code is (a word its docs don't say, a path or an API the repo never had)
 * — which a line about the machine or another program can be and still
 * hold, so it is put to the check without being shown as stale.
 * `unchecked`: a line from before anchors that names git or a package,
 * never held up against them — checked once.
 */
export interface Finding {
  strong: string[];
  weak: string[];
  unchecked: boolean;
  now: MemoryAnchors;
}

/** A line's words and its reason, apart (anchorsOf reads each as starting
 *  a sentence). */
const textOf = (line: MemoryLine) => (line.why ? `${line.text}\u0000${line.why}` : line.text);

/** "x and y", "x, y and z". */
function listed(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Specs a dependency has now, across the files that declare it. */
function specsNow(view: RepoView, name: string): PackageDep[] {
  return view.packages.filter((dep) => dep.name === name);
}

/**
 * A line held up against the code. With anchors from when it was written
 * or last checked, each one is compared with what is there now: a file
 * gone, a file changed where it touches what the line names, a symbol
 * gone, a version, a branch, a word, a value moved. Without them — a line
 * from before anchors — the line's own words are held up against the code
 * as it stands.
 */
export async function checkLine(line: MemoryLine, view: RepoView): Promise<Finding> {
  const now = await anchorsOf(textOf(line), view);
  const then = line.anchors;
  const strong: string[] = [];
  const weak: string[] = [];
  /** A change since the anchors is strong; with no anchors to compare,
   *  only what the line says against what is there. */
  const moved = (was: unknown) => (was ? strong : weak);
  const since = then?.at ? ` since ${dayOf(then.at)}` : "";

  // files
  for (const p of now.paths ?? []) {
    const before = then?.paths?.find((q) => q.path === p.path);
    if (!p.exists && (before ? before.exists : true)) {
      moved(before).push(`${p.path} isn't in the project${before ? " any more" : ""}`);
    }
  }
  // a file it rests on changed where it touches what the line names
  if (then?.sha && view.head && then.sha !== view.head) {
    // a file that is gone is said once, above
    const files = (then.paths ?? []).filter((p) => p.exists && view.fileSet.has(p.path)).map((p) => p.path);
    const changed = files.length ? await view.changedSince(then.sha, files) : [];
    if (changed?.length) {
      const words = [
        ...(then.symbols ?? []).map((s) => s.name),
        ...(then.values ?? []).map((v) => v.name),
        ...(then.terms ?? []).map((t) => t.term),
      ];
      const lines = words.length ? await view.changedLines(then.sha, changed) : "";
      const touched = words.filter((word) => new RegExp(`\\b${escape(word)}\\b`, "i").test(lines));
      if (touched.length) strong.push(`${listed(changed)} changed${since} where it has ${listed(touched)}`);
    }
  }
  // symbols
  for (const s of now.symbols ?? []) {
    const before = then?.symbols?.find((x) => x.name === s.name);
    if (!s.found && (before ? before.found : true)) {
      moved(before).push(`${s.name} doesn't appear in the code${before ? " any more" : ""}`);
    }
  }
  // packages: a version moved, or a version the line quotes isn't the one there
  for (const name of new Set((now.packages ?? []).map((p) => p.name))) {
    const current = specsNow(view, name);
    const specs = [...new Set(current.map((d) => d.spec))];
    const before = then?.packages?.filter((p) => p.name === name) ?? [];
    if (before.length) {
      const was = [...new Set(before.map((p) => p.spec).filter(Boolean))];
      if (was.length && was.join() !== specs.join()) {
        strong.push(`${name} is ${listed(specs)} now (was ${listed(was as string[])})`);
      }
      continue;
    }
    const stale = specsFor(textOf(line), name).filter((spec) => !specs.includes(spec));
    if (stale.length) {
      const where = listed([...new Set(current.map((d) => d.file))]);
      strong.push(`${name} is ${listed(specs)} in ${where}, not ${listed(stale)}`);
    }
  }
  // branches
  for (const b of now.branches ?? []) {
    const before = then?.branches?.find((x) => x.name === b.name);
    if (before && before.state === b.state) continue;
    if (b.state === "gone") {
      // a branch-shaped word git never had may be an example ("fix/x") or
      // one deleted once merged: only a branch the line was anchored to is
      // known to have gone
      if (before) strong.push(`${b.name} isn't a branch here any more`);
      else if (
        /\b(not (?:yet )?(?:merged|in)|unmerged|merge (?:it|next|later|into)|waits? to merge)\b/i.test(
          line.text,
        )
      ) {
        weak.push(`${b.name} isn't a branch here`);
      }
    } else if (
      b.state === "merged" &&
      (before?.state === "unmerged" ||
        (!before && /\b(not (?:yet )?(?:merged|in)|unmerged|merge (?:it|next|later))\b/i.test(line.text)))
    ) {
      strong.push(`${b.name} is merged into ${view.git?.mainline ?? "the mainline"} now`);
    }
  }
  // the words the project says of itself
  for (const t of now.terms ?? []) {
    const before = then?.terms?.find((x) => x.term === t.term);
    if (t.present || (before && !before.present)) continue;
    moved(before).push(
      `${t.term} isn't in the project's README, docs or description${before ? " any more" : ""}`,
    );
  }
  // values
  for (const v of valuesOf(textOf(line))) {
    const before = then?.values?.find((x) => x.name === v.name);
    const set = await view.settingsOf(v.name);
    if (!set.length) continue;
    const values = [...new Set(set.map((s) => s.value))];
    if (values.includes(before?.value ?? v.value)) continue;
    const said = before ? `was ${before.value}` : `the line says ${v.value}`;
    strong.push(`${set[0]!.file} has ${v.name} = ${listed(values)} (${said})`);
  }
  const unchecked = !then && !strong.length && !!(now.branches?.length || now.packages?.length);
  return { strong, weak, unchecked, now };
}

/** A line's anchors from its words and its reason — what a writer keeps
 *  with a new line. */
export function lineAnchors(text: string, why: string | undefined, view: RepoView): Promise<MemoryAnchors> {
  return anchorsOf(why ? `${text}\u0000${why}` : text, view);
}
