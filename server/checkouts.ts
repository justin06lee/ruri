import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isMissing, warn } from "./log.js";

/**
 * Which copy of a project a session is working in, and what a component's
 * code says right now.
 *
 * A project's agents mostly don't work in the project's folder. Each takes
 * a git worktree of its own (`../ruri-wt/feature`), builds there, and the
 * lead merges. The library knew only the project's folder: `ruri add` run
 * in a worktree copied files into the main checkout behind the agent's
 * back, and `ruri register` couldn't find the files it had just written.
 * So every path a session gives is read against the checkout its shell is
 * in — the project's folder, or a worktree of the same repository.
 */

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (!isMissing(err)) warn("checkouts", err, "realpath");
    return path.resolve(p);
  }
}

/** The repository a checkout belongs to: its own `.git` folder, or — for a
 *  worktree, whose `.git` is a file pointing into the main one — that. */
function commonGitDir(root: string): string | undefined {
  const dotGit = path.join(root, ".git");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch (err) {
    if (!isMissing(err)) warn("checkouts", err, "commonGitDir");
    return undefined;
  }
  if (stat.isDirectory()) return realpath(dotGit);
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
    if (!pointer) return undefined;
    const gitdir = path.resolve(root, pointer);
    // <main>/.git/worktrees/<name> — the repository is two up
    const common = fs.existsSync(path.join(gitdir, "commondir"))
      ? path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim())
      : path.dirname(path.dirname(gitdir));
    return realpath(common);
  } catch (err) {
    if (!isMissing(err)) warn("checkouts", err, "commonGitDir");
    return undefined;
  }
}

/** The top of the checkout a folder is in: the nearest folder up with a
 *  `.git` in it. */
function checkoutRoot(dir: string): string | undefined {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, ".git"))) return at;
    const up = path.dirname(at);
    if (up === at) return undefined;
    at = up;
  }
}

/** Where the project sits in its repository, for a project that is a
 *  folder inside one: the repository's root and the way down from it. */
function inRepo(projectDir: string): { root: string; sub: string; common: string } | undefined {
  const root = checkoutRoot(realpath(projectDir));
  const common = root ? commonGitDir(root) : undefined;
  if (!root || !common) return undefined;
  return { root, sub: path.relative(root, realpath(projectDir)), common };
}

/**
 * The checkout a session's shell stands in, as the project's folder there:
 * in a worktree of the project's own repository when `cwd` is inside one,
 * and the project's folder otherwise (inside it, outside any repository, or
 * in some other repository). Worktrees kept inside the project's folder
 * (`.claude/worktrees/…`) count as worktrees, not as the project.
 */
export function checkoutFor(projectDir: string, cwd: string | undefined): string {
  if (!cwd) return projectDir;
  const repo = inRepo(projectDir);
  const root = checkoutRoot(realpath(cwd));
  if (!repo || !root || root === repo.root) return projectDir;
  return commonGitDir(root) === repo.common ? path.join(root, repo.sub) : projectDir;
}

/** The project's folder in every worktree of its repository but its own,
 *  from git's own list of them (`.git/worktrees/<name>/gitdir`). */
export function worktreesOf(projectDir: string): string[] {
  const repo = inRepo(projectDir);
  if (!repo) return [];
  const list = path.join(repo.common, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(list);
  } catch (err) {
    if (!isMissing(err)) warn("checkouts", err, "worktreesOf");
    return [];
  }
  const out: string[] = [];
  for (const name of names) {
    try {
      const gitFile = fs.readFileSync(path.join(list, name, "gitdir"), "utf8").trim();
      const root = path.dirname(gitFile);
      if (fs.existsSync(root) && realpath(root) !== repo.root) out.push(path.join(root, repo.sub));
    } catch (err) {
      if (!isMissing(err)) warn("checkouts", err, "worktreesOf");
    }
  }
  return out;
}

/* ── what a component's code says ─────────────────────────────────── */

/** A file's hash, kept while its size and time stay as they were — most
 *  checks find nothing changed and read nothing. */
const hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();

function fileHash(full: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(full);
  } catch (err) {
    if (!isMissing(err)) warn("checkouts", err, "fileHash");
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const known = hashes.get(full);
  if (known && known.mtimeMs === stat.mtimeMs && known.size === stat.size) return known.hash;
  try {
    const hash = createHash("sha1").update(fs.readFileSync(full)).digest("hex");
    hashes.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, hash });
    if (hashes.size > 5000) hashes.delete(hashes.keys().next().value!);
    return hash;
  } catch (err) {
    if (!isMissing(err)) warn("checkouts", err, "fileHash");
    return undefined;
  }
}

/**
 * What a component's own code says, as one short string: the same exactly
 * when every one of its files holds what it held. Read from the contents
 * only, in the order given — a file moved with nothing changed in it is
 * still the same code, and the same code in a worktree as in the project
 * once it is merged. Undefined when there is nothing to read.
 */
export function codeSig(root: string, files: string[]): string | undefined {
  if (files.length === 0) return undefined;
  const sum = createHash("sha1");
  let any = false;
  for (const ref of files) {
    const rel = ref.split(":")[0]!.trim();
    const hash = fileHash(path.join(root, rel));
    if (hash) any = true;
    sum.update(`${hash ?? "-"}\n`);
  }
  return any ? sum.digest("hex").slice(0, 16) : undefined;
}
