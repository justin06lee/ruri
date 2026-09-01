import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { NamedComponent } from "../shared/protocol.js";
import { nameProjectParts, type SweptComponent } from "./smallmodel.js";

/**
 * The repo sweep: name everything in a project that nobody has named yet.
 *
 * The component index fills itself from the moment a session builds
 * something and says so — which is the right moment, and which is no help
 * at all to a project that existed before any of this. Everything built
 * last year is unnamed, and stays unnamed, because nothing is ever going to
 * announce it. This is the other door in: read the repo, name the parts,
 * and let the user correct whatever it got wrong.
 *
 * It reads like a person skimming an unfamiliar codebase rather than like a
 * compiler. Per file it takes the top of it (where this codebase, and most,
 * keep the paragraph saying what the file is for), the names it exports,
 * and every CSS class it sets — that last one is not for reading, it is the
 * selector the screenshot pass needs, and it has to come from the source
 * rather than from a model's imagination. Then the small model names them
 * in batches, so this costs about what a handful of turn summaries costs
 * and runs on whatever harness the user is signed into.
 *
 * What comes out is a guess. It is marked as one (`found: true`), it wears
 * a star until it's looked at, and every field of it is editable on the
 * Components page — the sweep's job is to make the page non-empty, not to
 * be right.
 */

/** Files that are a user interface wherever they sit in the tree. */
const VIEW_EXT = new Set([".tsx", ".jsx", ".vue", ".svelte", ".astro", ".html", ".swift"]);

/** Files that count only when they sit somewhere interface-shaped — or when
 *  the project has no views at all, and its parts are what get named. */
const CODE_EXT = new Set([".ts", ".js", ".mjs", ".py", ".go", ".rs", ".rb", ".kt", ".dart", ".java"]);

/** Directory names that mean "a person can see this". */
const UI_DIRS =
  /(^|\/)(components?|views?|pages?|screens?|widgets?|panels?|ui|app|web|client|frontend|src)(\/|$)/i;

/** Nothing in here is anybody's component. */
const SKIP_DIRS =
  /(^|\/)(node_modules|dist|dist-web|dist-app|dist-electron|build|out|target|vendor|coverage|\.git|\.next|\.nuxt|\.svelte-kit|__pycache__|\.venv|venv|migrations|fixtures?|__snapshots__)(\/|$)/;

const SKIP_FILE =
  /(\.d\.ts|\.min\.js|\.test\.[jt]sx?|\.spec\.[jt]sx?|\.stories\.[jt]sx?|-lock\.json|\.lock)$/i;

/** How many files reach the model at all. Past this it is paying to read
 *  the long tail of a repo, which is where the un-nameable things live. */
const MAX_FILES = 140;
/** Characters of each file's opening that ride along. */
const HEAD_CHARS = 1500;
/** Files per model call, and how many calls run at once. A call costs about
 *  half a minute whatever is in it, so the width is what decides whether the
 *  sweep finishes while the user is still on the page. */
const BATCH_FILES = 7;
const BATCH_CONCURRENCY = 5;

/** Every file in the project git will admit to, tracked or merely present. */
function repoFiles(dir: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
    });
    const listed = out.split("\n").filter(Boolean);
    if (listed.length) return listed;
  } catch {
    // not a git repo, or git isn't there — walk it by hand
  }
  const found: string[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > 6 || found.length > 6000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".ruri") continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (SKIP_DIRS.test(child)) continue;
      if (entry.isDirectory()) walk(child, depth + 1);
      else found.push(child);
    }
  };
  walk("", 0);
  return found;
}

/** The classes a file actually sets — where a real selector comes from. */
function classNames(source: string): string[] {
  const seen = new Set<string>();
  for (const match of source.matchAll(/\b(?:className|class)\s*=\s*["'`]([^"'`]{1,160})["'`]/g)) {
    for (const name of (match[1] ?? "").split(/\s+/)) {
      // template holes and conditional fragments are not class names
      if (!/^[a-z][a-z0-9_-]*$/i.test(name)) continue;
      seen.add(name);
      if (seen.size >= 40) return [...seen];
    }
  }
  return [...seen];
}

/** What the file offers the rest of the project by name. */
function exportNames(source: string): string[] {
  const seen = new Set<string>();
  for (const match of source.matchAll(
    /export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type)\s+([A-Za-z_$][\w$]*)/g,
  )) {
    if (match[1]) seen.add(match[1]);
    if (seen.size >= 24) break;
  }
  return [...seen];
}

/** Higher wins a place in the sweep: views first, then interface-shaped
 *  directories, then whatever is left that is still source. */
function score(rel: string): number {
  const ext = path.extname(rel).toLowerCase();
  let value = VIEW_EXT.has(ext) ? 100 : 0;
  if (UI_DIRS.test(path.dirname(rel))) value += 30;
  if (/(^|\/)(index|main)\.[jt]sx?$/i.test(rel)) value += 5;
  // deep in the tree usually means a leaf detail, not a thing with a name
  value -= path.dirname(rel).split("/").length * 2;
  return value;
}

/** One file as the model reads it: what it says it is, what it exports, and
 *  the classes that will find it on screen. */
function describe(dir: string, rel: string): { path: string; head: string } | undefined {
  let source: string;
  try {
    const full = path.join(dir, rel);
    if (fs.statSync(full).size > 400_000) return undefined;
    source = fs.readFileSync(full, "utf8");
  } catch {
    return undefined;
  }
  if (!source.trim()) return undefined;
  const lines = source.split("\n").length;
  const classes = classNames(source);
  const exports = exportNames(source);
  const head = [
    source.slice(0, HEAD_CHARS),
    exports.length ? `\n[exports: ${exports.join(", ")}]` : "",
    classes.length ? `\n[css classes it sets: ${classes.join(", ")}]` : "",
    `\n[${lines} lines]`,
  ].join("");
  return { path: rel, head };
}

/** Files older than the last sweep have already been read once, and cost a
 *  model call each to read again. */
function touchedSince(dir: string, rel: string, since: number): boolean {
  if (!since) return true;
  try {
    return fs.statSync(path.join(dir, rel)).mtimeMs > since;
  } catch {
    return true;
  }
}

/** The files worth spending a model call on, best first. */
export function sweepCandidates(dir: string): string[] {
  const all = repoFiles(dir).filter((rel) => !SKIP_DIRS.test(rel) && !SKIP_FILE.test(rel));
  const views = all.filter((rel) => VIEW_EXT.has(path.extname(rel).toLowerCase()));
  // A project with no views is not disqualified — its parts get named the
  // same way. It just has to look wider to find them.
  const pool = views.length
    ? all.filter((rel) => {
        const ext = path.extname(rel).toLowerCase();
        if (VIEW_EXT.has(ext)) return true;
        if (!CODE_EXT.has(ext)) return false;
        // interface-shaped directories, and the top of the tree — half of
        // what a user points at has a server side, and "the terminal tabs"
        // is as much server/terminal.ts as it is the row of tabs
        return UI_DIRS.test(path.dirname(rel)) || path.dirname(rel).split("/").length <= 2;
      })
    : all.filter((rel) => CODE_EXT.has(path.extname(rel).toLowerCase()));
  return pool.sort((a, b) => score(b) - score(a) || a.localeCompare(b)).slice(0, MAX_FILES);
}

/** Files that already belong to something with a name. */
function claimed(existing: NamedComponent[]): Set<string> {
  const set = new Set<string>();
  for (const item of existing) {
    for (const file of item.files) set.add(file.split(":")[0]!.trim());
  }
  return set;
}

export interface SweepResult {
  /** What to add, already filtered against what exists. */
  found: SweptComponent[];
  /** How many files were read to get there. */
  read: number;
}

/**
 * Read the project and come back with the parts of it nobody has named.
 * `onNote` is the line under the button while this runs.
 */
export async function sweepProject(
  project: { name: string; path: string },
  existing: NamedComponent[],
  onNote: (note: string) => void,
  /** Skip files untouched since this — what a previous sweep already read. */
  since = 0,
): Promise<SweepResult> {
  const already = claimed(existing);
  const candidates = sweepCandidates(project.path)
    // a file that is already somebody's component doesn't need naming twice,
    // and one that hasn't changed since the last sweep was already read
    .filter((rel) => !already.has(rel) && touchedSince(project.path, rel, since));
  onNote(candidates.length ? `reading ${candidates.length} files…` : "nothing new to read");

  const files = candidates.flatMap((rel) => {
    const described = describe(project.path, rel);
    return described ? [described] : [];
  });
  if (files.length === 0) return { found: [], read: 0 };

  const batches: Array<Array<{ path: string; head: string }>> = [];
  for (let at = 0; at < files.length; at += BATCH_FILES) {
    batches.push(files.slice(at, at + BATCH_FILES));
  }

  const names = existing.flatMap((item) => [item.name, ...item.aliases]);
  const found: SweptComponent[] = [];
  const takenNames = new Set(names.map((n) => n.toLowerCase()));
  const takenFiles = new Set(already);
  let done = 0;

  // Batches run a few at a time: the whole point is that this finishes while
  // the user is still looking at the page, and one call per seven files is
  // already the cheap end of it.
  let next = 0;
  const workers = Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, async () => {
    for (;;) {
      const index = next++;
      const batch = batches[index];
      if (!batch) return;
      const parts = await nameProjectParts(project.name, batch, names);
      done += 1;
      onNote(`naming — ${done} of ${batches.length} batches, ${found.length} found`);
      for (const part of parts) {
        const key = part.name.toLowerCase();
        if (takenNames.has(key)) continue;
        // the same thing named twice from two batches, or a thing whose
        // first file already belongs to something else
        const primary = part.files[0]?.split(":")[0]?.trim();
        if (primary && takenFiles.has(primary)) continue;
        takenNames.add(key);
        if (primary) takenFiles.add(primary);
        found.push(part);
      }
    }
  });
  await Promise.all(workers);
  return { found, read: files.length };
}
