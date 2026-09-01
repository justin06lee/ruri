import * as fs from "node:fs";
import * as path from "node:path";
import type { Project } from "../shared/protocol.js";
import { catchupBrief, type FullBrief } from "./smallmodel.js";
import { describeFile, sweepCandidates } from "./sweep.js";

/**
 * The catch-up brief, written whole.
 *
 * The brief usually writes itself a turn at a time (see brief.ts): each
 * finished exchange is folded in, and after a while it says what the
 * project is. That is no help to a project that arrives in ruri with a
 * year of work already in it — nothing has happened here yet, so the brief
 * is empty, and the first session in it starts from nothing.
 *
 * This is the other door: read the repo the way a person joining it would
 * — the README, the manifest, the Makefile, the agent instructions, the
 * shape of the tree, the top of the files that matter — and have the small
 * model write the brief in one go: what it is, what's in it, the stack,
 * how to run it, where things are, and the rules it lives by. It runs when
 * a project is opened without a brief, and whenever the user asks for it
 * again.
 */

/** How much of each file rides along. */
const README_CHARS = 7000;
const MANIFEST_CHARS = 2500;
const RULES_CHARS = 3500;
const HEAD_CHARS = 900;
/** How many source files' openings the model sees. */
const SOURCE_FILES = 26;

/** Folders that are nobody's layout. */
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "dist-web", "dist-app", "dist-electron", "build", "out", "target",
  "vendor", "coverage", ".next", ".nuxt", ".svelte-kit", "__pycache__", ".venv", "venv", ".cache",
]);

function readHead(file: string, chars: number): string | undefined {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.length > chars ? `${raw.slice(0, chars)}\n…` : raw;
  } catch {
    return undefined;
  }
}

/** The tree two levels down, one line per entry, with file counts inside. */
function tree(dir: string): string {
  const lines: string[] = [];
  const list = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith("."));
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith("."));
    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      const child = rel ? `${rel}/${d.name}` : d.name;
      let count = 0;
      try {
        count = fs.readdirSync(path.join(dir, child)).length;
      } catch {
        // unreadable
      }
      lines.push(`${"  ".repeat(depth)}${d.name}/ (${count})`);
      if (depth < 1) list(child, depth + 1);
      if (lines.length > 120) return;
    }
    if (depth === 0) {
      for (const f of files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 40)) lines.push(f.name);
    }
  };
  list("", 0);
  return lines.join("\n");
}

/** The manifest, trimmed to what says something: scripts and dependencies. */
function manifest(dir: string): string | undefined {
  const pkg = readHead(path.join(dir, "package.json"), 20_000);
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg) as Record<string, unknown>;
      const keep: Record<string, unknown> = {};
      for (const key of ["name", "description", "scripts", "dependencies", "devDependencies", "engines", "main", "bin"]) {
        if (parsed[key] !== undefined) keep[key] = parsed[key];
      }
      return `package.json:\n${JSON.stringify(keep, null, 1).slice(0, MANIFEST_CHARS)}`;
    } catch {
      return `package.json:\n${pkg.slice(0, MANIFEST_CHARS)}`;
    }
  }
  for (const name of ["pyproject.toml", "Cargo.toml", "go.mod", "Package.swift", "build.gradle", "pom.xml", "Gemfile", "composer.json", "mix.exs", "deno.json"]) {
    const text = readHead(path.join(dir, name), MANIFEST_CHARS);
    if (text) return `${name}:\n${text}`;
  }
  return undefined;
}

/** Everything the model reads, as one document with headed sections. */
export function catchupMaterial(project: Project): string {
  const dir = project.path;
  const parts: string[] = [`PROJECT: ${project.name}\nPATH: ${dir}`];
  const readme = ["README.md", "readme.md", "README", "README.rst", "README.txt"]
    .map((name) => readHead(path.join(dir, name), README_CHARS))
    .find(Boolean);
  if (readme) parts.push(`=== README ===\n${readme}`);
  const man = manifest(dir);
  if (man) parts.push(`=== MANIFEST ===\n${man}`);
  const make = readHead(path.join(dir, "Makefile"), MANIFEST_CHARS);
  if (make) parts.push(`=== Makefile ===\n${make}`);
  for (const name of ["CLAUDE.md", "AGENTS.md", ".ruri/components.md"]) {
    const text = readHead(path.join(dir, name), RULES_CHARS);
    if (text) parts.push(`=== ${name} ===\n${text}`);
  }
  parts.push(`=== TREE (two levels) ===\n${tree(dir)}`);
  const heads = sweepCandidates(dir)
    .slice(0, SOURCE_FILES)
    .flatMap((rel) => {
      const d = describeFile(dir, rel, HEAD_CHARS);
      return d ? [`--- ${d.path} ---\n${d.head}`] : [];
    });
  if (heads.length) parts.push(`=== SOURCE FILES (openings) ===\n${heads.join("\n\n")}`);
  return parts.join("\n\n");
}

/** Read the repo and write the whole brief. Null when the model gave
 *  nothing usable (the brief then stays as it was). */
export async function buildCatchup(project: Project, current: Partial<FullBrief>): Promise<FullBrief | null> {
  return catchupBrief(project.name, catchupMaterial(project), current);
}
