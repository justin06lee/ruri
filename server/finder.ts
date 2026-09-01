import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Finding a project by the name a person uses for it.
 *
 * "Open hifz" is a request to open a folder called something like hifz,
 * somewhere under the workspace — which is nested (github.com/<user>/<repo>)
 * and holds more than the eye can list. The Home agent used to guess at the
 * path or read directory listings one level at a time; this walks the tree
 * for it, scores every folder name against what was said, and hands back
 * the best few with their paths, so opening a project is a lookup rather
 * than an expedition.
 */

/** Folders nobody means when they name a project. */
const SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", "target", "vendor",
  "coverage", "__pycache__", ".venv", "venv", ".next", ".nuxt", ".cache", "Library",
  "Applications", "Pictures", "Music", "Movies", "Downloads", ".Trash", "tmp",
]);

/** What makes a folder look like a project rather than a folder of them. */
const PROJECT_MARKS = [
  ".git", "package.json", "Cargo.toml", "pyproject.toml", "go.mod", "Makefile",
  "pom.xml", "build.gradle", "Package.swift", "Gemfile", "composer.json", "mix.exs",
  "deno.json", "CMakeLists.txt", "README.md",
];

export interface FoundProject {
  path: string;
  name: string;
  /** Higher is a better match; 100 is the name exactly. */
  score: number;
  /** The folder looks like a project (has a repo, a manifest, a README). */
  project: boolean;
}

/** Words the query is made of, lowercased, punctuation stripped. */
function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/** Every character of `needle` appears in `hay`, in order. */
function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const c of hay) if (c === needle[i]) i += 1;
  return i === needle.length;
}

/** How well a folder name answers to the query, 0 when it doesn't. */
export function scoreName(name: string, query: string): number {
  const n = name.toLowerCase();
  const flat = n.replace(/[^a-z0-9]/g, "");
  const q = query.toLowerCase().trim();
  const qflat = q.replace(/[^a-z0-9]/g, "");
  if (!qflat) return 0;
  if (n === q || flat === qflat) return 100;
  if (n.startsWith(q) || flat.startsWith(qflat)) return 80;
  const words = tokens(name);
  const wanted = tokens(query);
  if (wanted.length > 0 && wanted.every((w) => words.some((x) => x === w))) return 75;
  if (n.includes(q) || flat.includes(qflat)) return 60;
  if (wanted.length > 0 && wanted.every((w) => flat.includes(w))) return 50;
  if (qflat.length >= 3 && subsequence(qflat, flat)) return 25;
  return 0;
}

/** The roots worth looking under: the workspace, and the usual suspects. */
export function searchRoots(workspaceDir: string): string[] {
  const home = os.homedir();
  const roots = [workspaceDir];
  for (const name of ["Workspace", "workspace", "Projects", "projects", "Developer", "dev", "Code", "code", "src", "repos"]) {
    const dir = path.join(home, name);
    if (!roots.includes(dir) && fs.existsSync(dir)) roots.push(dir);
  }
  return roots;
}

const MAX_DEPTH = 6;
const MAX_DIRS = 40_000;
const TIME_BUDGET_MS = 4_000;

/**
 * Walk the roots and return the folders whose names answer to the query,
 * best first. A folder that looks like a project outranks one that merely
 * contains projects; the walk does not descend into a project it matched,
 * since what is inside a repo is not another project.
 */
export function findProjects(roots: string[], query: string, limit = 12): FoundProject[] {
  const found: FoundProject[] = [];
  const seen = new Set<string>();
  const started = Date.now();
  let visited = 0;

  const isProject = (dir: string): boolean =>
    PROJECT_MARKS.some((mark) => fs.existsSync(path.join(dir, mark)));

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || visited > MAX_DIRS || Date.now() - started > TIME_BUDGET_MS) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    visited += 1;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (SKIP.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".ruri")) continue;
      const full = path.join(dir, entry.name);
      let real = full;
      try {
        real = fs.realpathSync(full);
        if (!fs.statSync(real).isDirectory()) continue;
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const score = scoreName(entry.name, query);
      const project = isProject(full);
      if (score > 0) found.push({ path: full, name: entry.name, score, project });
      // inside a matched project is not where the next project is
      if (!(score > 0 && project)) walk(full, depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  found.sort((a, b) => b.score - a.score || Number(b.project) - Number(a.project) || a.path.length - b.path.length);
  return found.slice(0, limit);
}
