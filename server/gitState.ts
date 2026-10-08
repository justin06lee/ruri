import { execFile, execFileSync } from "node:child_process";
import type { SheetGit } from "../shared/protocol.js";

/**
 * Where a project's repo stands, read from git rather than remembered: the
 * branch, what is uncommitted, which branches are still unmerged, the last
 * commits. A model's memory of "merge feat/x next" goes stale the moment
 * someone merges it; git's answer never does, costs a few milliseconds and
 * no model call. The compaction brief, catch-up.md, the page and `ruri
 * state` all lead with it.
 *
 * Every read is optional-locks-off (GIT_OPTIONAL_LOCKS=0): the agents in
 * the project are running git themselves, and a status that refreshed the
 * index would take the lock out from under one of them.
 */

export interface GitState {
  branch: string;
  head: string;
  upstream?: string;
  ahead: number;
  behind: number;
  /** `git status --short` lines, as git prints them. */
  dirty: string[];
  mainline?: string;
  /** Every local branch, and whether the mainline has it. */
  branches: Array<{ name: string; merged: boolean }>;
  /** Every remote-tracking branch ("origin/codex/profiling"), and whether
   *  the mainline has it. */
  remotes: Array<{ name: string; merged: boolean }>;
  commits: Array<{ sha: string; when: string; subject: string }>;
}

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
const TIMEOUT_MS = 3000;

/** The questions, asked in one go. */
const ASKS = {
  status: ["status", "--porcelain=v1", "--branch", "--untracked-files=normal"],
  head: ["rev-parse", "--short", "HEAD"],
  heads: ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
  remotes: ["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
  log: ["log", "-5", "--format=%h%x09%cr%x09%s"],
} as const;

type Answers = Record<keyof typeof ASKS, string>;

/** Names, one a line, as a set. */
function nameSet(text: string | undefined): Set<string> {
  return new Set(
    (text ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
}

function parse(
  answers: Answers,
  merged: string | undefined,
  mainline: string | undefined,
  mergedRemotes?: string,
): GitState {
  const lines = answers.status.split("\n").filter(Boolean);
  const top = lines[0]?.startsWith("## ") ? lines.shift()!.slice(3) : "";
  // "## master...origin/master [ahead 1, behind 2]", "## HEAD (no branch)",
  // "## No commits yet on master"
  const [names = "", counts = ""] = top.split(" [");
  const [branch = "", upstream] = names.replace(/^No commits yet on /, "").split("...");
  const ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
  const mergedSet = nameSet(merged);
  const mergedRemoteSet = nameSet(mergedRemotes);
  return {
    branch: branch.startsWith("HEAD") ? "" : branch,
    head: answers.head.trim(),
    ...(upstream ? { upstream } : {}),
    ahead,
    behind,
    dirty: lines,
    ...(mainline ? { mainline } : {}),
    branches: answers.heads
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((name) => ({ name, merged: mergedSet.has(name) })),
    remotes: [...nameSet(answers.remotes)]
      // "origin" alone is the remote's HEAD
      .filter((name) => name.includes("/") && !name.endsWith("/HEAD"))
      .map((name) => ({ name, merged: mergedRemoteSet.has(name) })),
    commits: answers.log
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", when = "", ...subject] = line.split("\t");
        return { sha, when, subject: subject.join("\t") };
      }),
  };
}

/** The mainline, of the branches there are: master, else main. */
function mainlineOf(heads: string): string | undefined {
  const names = new Set(heads.split("\n").map((l) => l.trim()));
  return names.has("master") ? "master" : names.has("main") ? "main" : undefined;
}

function runSync(dir: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: ENV,
    timeout: TIMEOUT_MS,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 4 * 1024 * 1024,
  });
}

function run(dir: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: dir, env: ENV, timeout: TIMEOUT_MS, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });
}

/** The repo's state, blocking — for a compaction, which has to hand the
 *  brief over before the next prompt can go. Undefined outside a repo. */
export function gitStateSync(dir: string): GitState | undefined {
  try {
    const answers = Object.fromEntries(
      Object.entries(ASKS).map(([key, args]) => [key, runSync(dir, args)]),
    ) as Answers;
    const mainline = mainlineOf(answers.heads);
    const merged = mainline
      ? runSync(dir, ["branch", "--merged", mainline, "--format=%(refname:short)"])
      : undefined;
    const mergedRemotes = mainline
      ? runSync(dir, ["branch", "-r", "--merged", mainline, "--format=%(refname:short)"])
      : undefined;
    return parse(answers, merged, mainline, mergedRemotes);
  } catch {
    return undefined;
  }
}

/** The repo's state. Undefined outside a repo, or when git won't say. */
export async function gitState(dir: string): Promise<GitState | undefined> {
  try {
    const keys = Object.keys(ASKS) as Array<keyof typeof ASKS>;
    const outs = await Promise.all(keys.map((key) => run(dir, ASKS[key])));
    const answers = Object.fromEntries(keys.map((key, i) => [key, outs[i]!])) as Answers;
    const mainline = mainlineOf(answers.heads);
    const [merged, mergedRemotes] = mainline
      ? await Promise.all([
          run(dir, ["branch", "--merged", mainline, "--format=%(refname:short)"]),
          run(dir, ["branch", "-r", "--merged", mainline, "--format=%(refname:short)"]),
        ])
      : [undefined, undefined];
    return parse(answers, merged, mainline, mergedRemotes);
  } catch {
    return undefined;
  }
}

/** Commits on HEAD since `sha` — undefined when git doesn't know it. */
export async function commitsSince(dir: string, sha: string): Promise<number | undefined> {
  try {
    return Number((await run(dir, ["rev-list", "--count", `${sha}..HEAD`])).trim());
  } catch {
    return undefined;
  }
}

/** The commit HEAD is at, short — undefined outside a repo. */
export async function head(dir: string): Promise<string | undefined> {
  try {
    return (await run(dir, ["rev-parse", "--short", "HEAD"])).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function unmerged(state: GitState): string[] {
  return state.branches.filter((b) => !b.merged && b.name !== state.mainline).map((b) => b.name);
}

/** The state for the page. */
export function sheetGit(state: GitState, sinceRead?: number): SheetGit {
  return {
    branch: state.branch || "detached",
    head: state.head,
    dirty: state.dirty.length,
    unmerged: unmerged(state),
    ...(sinceRead !== undefined ? { sinceRead } : {}),
  };
}

const DIRTY_SHOWN = 12;

/** The state as a model reads it: a few lines of plain fact. */
export function gitLines(state: GitState): string[] {
  const where = state.branch ? `on ${state.branch} (${state.head})` : `detached at ${state.head}`;
  const sync = state.upstream
    ? state.ahead || state.behind
      ? `, ${[state.ahead ? `${state.ahead} ahead of` : "", state.behind ? `${state.behind} behind` : ""]
          .filter(Boolean)
          .join(" and ")} ${state.upstream}`
      : `, level with ${state.upstream}`
    : "";
  const lines = [`Branch: ${where}${sync}`];
  if (state.dirty.length) {
    const shown = state.dirty.slice(0, DIRTY_SHOWN).map((l) => l.trim());
    const more = state.dirty.length - shown.length;
    lines.push(
      `Uncommitted: ${state.dirty.length} file${state.dirty.length === 1 ? "" : "s"} — ${shown.join(", ")}${more > 0 ? `, and ${more} more` : ""}`,
    );
  } else lines.push("Uncommitted: nothing — the tree is clean");
  const open = unmerged(state);
  if (state.mainline) {
    lines.push(
      open.length
        ? `Not merged into ${state.mainline}: ${open.join(", ")}`
        : `Every local branch is merged into ${state.mainline}`,
    );
  }
  if (state.commits.length) {
    lines.push(`Last commits: ${state.commits.map((c) => `${c.sha} ${c.subject} (${c.when})`).join("; ")}`);
  }
  return lines;
}

/** A word that reads as a branch even when git no longer has it: a type
 *  prefix, an agent's own prefix, or a remote's. */
const BRANCH_NAME =
  /(?<![\w./-])(?:(?:origin|upstream)\/)?(?:feat|fix|refactor|chore|docs|experiment|perf|test|build|ci|release|hotfix|codex|claude|cursor|copilot|devin|jules|dependabot|renovate|wip)\/[\w./-]*\w/g;

/** Every branch git knows, by each name a line might give it: a local one
 *  by its name, a remote-tracking one by "origin/x" and, when there's no
 *  local "x", by "x" too. */
export function knownBranches(state: GitState): Map<string, { name: string; merged: boolean }> {
  const known = new Map<string, { name: string; merged: boolean }>();
  for (const branch of state.branches) known.set(branch.name, branch);
  for (const remote of state.remotes ?? []) {
    known.set(remote.name, remote);
    const bare = remote.name.slice(remote.name.indexOf("/") + 1);
    if (!known.has(bare)) known.set(bare, remote);
  }
  return known;
}

/** The branches a text names: every name git knows that it says whole,
 *  and any word shaped like a branch that git doesn't. */
export function namedBranches(text: string, state: GitState): string[] {
  const known = knownBranches(state);
  const out = new Set<string>();
  for (const name of known.keys()) {
    if (!name.includes("/") || name.length < 5) continue;
    const at = text.indexOf(name);
    if (at === -1) continue;
    const before = text[at - 1] ?? " ";
    const after = text[at + name.length] ?? " ";
    if (/[\w./-]/.test(before) && !text.slice(0, at).endsWith("origin/")) continue;
    if (/[\w/-]/.test(after)) continue;
    out.add(name);
  }
  for (const match of text.match(BRANCH_NAME) ?? []) out.add(match);
  // "origin/x" said whole wins over the "x" inside it
  return [...out].filter(
    (name) => ![...out].some((other) => other !== name && other.endsWith(`/${name}`) && text.includes(other)),
  );
}

/**
 * What git says about the branches a line of text names, however they are
 * named — "merge feat/self-update" is still to do only while that branch
 * is unmerged; "origin/codex/profiling is not in master" holds only while
 * it isn't. "" when the line names none.
 */
export function branchFacts(text: string, state: GitState | undefined): string {
  if (!state) return "";
  const named = namedBranches(text, state);
  if (named.length === 0) return "";
  const known = knownBranches(state);
  const facts = named.map((name) => {
    const branch = known.get(name);
    if (!branch) return `${name} isn't a branch here any more`;
    if (name === state.mainline) return "";
    return branch.merged
      ? `${name} is merged into ${state.mainline ?? "the mainline"}`
      : `${name} is not merged yet`;
  });
  const said = facts.filter(Boolean);
  return said.length ? `[git: ${said.join("; ")}]` : "";
}
