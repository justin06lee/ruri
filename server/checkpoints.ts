/**
 * A checkpoint of the project's files, per prompt, on every harness — and
 * the rewind that undoes what a chat's turns did with them.
 *
 * Claude's CLI takes its own file checkpoints, but only of the files its
 * Edit and Write tools touch: whatever a turn did through the shell (a
 * package installed, a file moved, a generator run, a commit) it never saw.
 * No other harness takes any. So ruri takes its own, and they belong to
 * ruri rather than to any harness: the project's whole working tree is
 * written into git as a commit nobody can see, under a ref named for the
 * prompt — once as the prompt goes out, and once more as its turn ends.
 *
 * What makes this cheap enough to do twice a turn:
 *
 * - It never touches the repository the user is working in. The commit is
 *   built through a private index file, so `git status`, the staging area,
 *   and the branch are exactly as they were; the object lands in the object
 *   database and a ref under `refs/ruri/` points at it. Nothing is on any
 *   branch, nothing is pushed, and `git log` is unchanged.
 * - That index file is kept per channel rather than made fresh, so git's
 *   stat cache survives between captures: the first in a session hashes the
 *   tree, and the ones after it hash what changed.
 * - Ignored files are ignored — `git add -A` obeys .gitignore, so
 *   node_modules and .env are neither captured nor, on the way back,
 *   deleted.
 *
 * Each capture also writes down where the branches and tags pointed and
 * what HEAD was, in the commit's message: a turn that committed, branched,
 * merged or tagged changed those as much as it changed any file.
 *
 * A rewind undoes the discarded turns and nothing else. Each turn's own
 * change is the difference between its two captures, and those changes
 * are taken back out of the tree as it stands now, newest first — so what
 * happened between turns (an edit of the user's own, another chat working
 * in the same repository) is still there afterwards. When the two
 * overlap in a file, the lines are merged; where they cannot be, the file
 * goes back to how it was before the prompt and the rewind says which. A
 * branch or tag a turn moved goes back too — unless its new commits are
 * already on a remote, or it has moved again since, or another worktree
 * has it checked out. Whatever the tree and the refs held before the
 * rewind is kept under an undo ref, so nothing it takes away is lost.
 *
 * A project that is not a git repository has no checkpoints, and every
 * caller here is written to say so rather than to pretend otherwise.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { configPath } from "./configDir.js";

/** Where the per-channel index files live — under the config dir, so a
 *  test run never writes into the real one. */
function indexDir(): string {
  return configPath("checkpoints");
}

/** A capture that takes longer than this has met a repository ruri has no
 *  business holding up a prompt for. */
const TIMEOUT_MS = 20_000;

/** Refs kept per channel — two a prompt, one as it goes out and one as its
 *  turn ends; the oldest are dropped as new ones land. */
const KEEP = 400;

/** Where the tree stood before a restore put it back — the one thing a
 *  rewind would otherwise destroy without a copy. */
const UNDO = "undo";

/** git's name for "no object": an absent side of a diff. */
const NULL_SHA = /^0+$/;

type GitResult = { ok: true; out: string } | { ok: false; error: string; code: number };

function git(
  args: string[],
  cwd: string,
  opts: { index?: string; input?: string | Buffer } = {},
): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: opts.index ? { ...process.env, GIT_INDEX_FILE: opts.index } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === "number" ? err.code : -1;
          resolve({ ok: false, code, error: (stderr || err.message).trim().split("\n")[0] ?? "git failed" });
        } else resolve({ ok: true, out: stdout.trim() });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** The same, for output that must not be trimmed or decoded (a merged
 *  file's bytes). */
function gitRaw(args: string[], cwd: string): Promise<{ code: number; out: Buffer }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (err, stdout) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ code, out: stdout });
      },
    );
  });
}

/** A ref name for one prompt, as it went out. Both ids are uuids, which
 *  git accepts. */
function refFor(channelId: string, eventId: string): string {
  return `refs/ruri/${channelId}/${eventId}`;
}

/** The same prompt's tree as its turn left it. */
function doneRefFor(channelId: string, eventId: string): string {
  return `refs/ruri/${channelId}/done/${eventId}`;
}

function indexFor(channelId: string): string {
  return path.join(indexDir(), `${channelId}.index`);
}

/** Where HEAD stood: on a branch (even one with no commit yet), or on a
 *  commit of its own. */
type Head = { ref: string } | { sha: string } | null;

/** The repository's own state beside the files: HEAD, and every branch and
 *  tag with what it points at. */
interface RefState {
  head: Head;
  refs: Map<string, string>;
}

function sameHead(a: Head, b: Head): boolean {
  if (!a || !b) return a === b;
  return "ref" in a ? "ref" in b && a.ref === b.ref : "sha" in b && a.sha === b.sha;
}

/** A state as the lines of a checkpoint's message. */
function stateLines(state: RefState): string {
  const head = !state.head
    ? "head none"
    : "ref" in state.head
      ? `head ${state.head.ref}`
      : `detached ${state.head.sha}`;
  return [head, ...[...state.refs].map(([name, sha]) => `ref ${sha} ${name}`)].join("\n");
}

/** Read back what stateLines wrote. A checkpoint from before states were
 *  written has none, and answers undefined. */
function parseState(message: string): RefState | undefined {
  const refs = new Map<string, string>();
  let head: Head | undefined;
  for (const line of message.split("\n")) {
    const [word, a, b] = line.split(" ");
    if (word === "head") head = a === "none" || !a ? null : { ref: a };
    else if (word === "detached" && a) head = { sha: a };
    else if (word === "ref" && a && b) refs.set(b, a);
  }
  return head === undefined ? undefined : { head, refs };
}

/** One path a turn changed: what it was before, and after. An absent side
 *  has no mode. */
interface Change {
  path: string;
  before?: { mode: string; sha: string };
  after?: { mode: string; sha: string };
}

type Entry = { mode: string; sha: string };

function sameEntry(a: Entry | undefined, b: Entry | undefined): boolean {
  if (!a || !b) return a === b;
  return a.sha === b.sha && a.mode === b.mode;
}

/** What a rewind did, for the words that tell the user. */
export interface RewindReport {
  /** Why the files could not be put back at all. The rest is empty then. */
  error?: string;
  /** Files something else had also changed since, where the lines would not
   *  merge: put back whole, to how they were before the prompt. */
  conflicts: string[];
  /** Branches and tags taken back: moved to where they were (`to`), or
   *  taken away because a discarded turn made them (`to` absent). */
  refs: Array<{ name: string; to?: string; commits: number }>;
  /** Ones a discarded turn moved that were left where they are, and why. */
  kept: Array<{ name: string; why: "pushed" | "moved" | "worktree" }>;
  /** HEAD put back on the branch (or commit) it was on. */
  head?: string;
}

export interface Checkpoints {
  /** Write down the project's files as they stand, under this prompt.
   *  Answers whether there is now a checkpoint to come back to. */
  capture(project: { id: string; path: string }, channelId: string, eventId: string): Promise<boolean>;
  /** Write them down again as the prompt's turn ends — the other half of
   *  what the turn did. */
  settle(project: { path: string }, channelId: string, eventId: string): Promise<boolean>;
  /** Wait for whatever capture this channel has in hand. A harness about
   *  to touch a file waits on it, so the checkpoint is never late. */
  idle(channelId: string): Promise<void>;
  /** Put the project's files back to a prompt's checkpoint, whole. Answers
   *  what went wrong, or nothing at all if the tree is back. */
  restore(project: { path: string }, channelId: string, eventId: string): Promise<string | undefined>;
  /**
   * Undo these prompts' turns — the prompt rewound to first, then every one
   * after it, in the order they were sent: their changes to the files taken
   * back out of the tree as it stands, and the branches and tags they moved
   * put back where that is safe.
   */
  rewind(project: { path: string }, channelId: string, eventIds: string[]): Promise<RewindReport>;
  /** Whether a prompt has a checkpoint at all. */
  has(project: { path: string }, channelId: string, eventId: string): Promise<boolean>;
  /** Drop the checkpoints of prompts that are no longer in the transcript. */
  forget(project: { path: string }, channelId: string, eventIds: string[]): Promise<void>;
  /** Drop every checkpoint a channel owns, and its index file. */
  forgetChannel(project: { path: string }, channelId: string): Promise<void>;
}

export function createCheckpoints(): Checkpoints {
  /** One git run per channel at a time: two captures racing on the same
   *  index file would each see the other's half-written state. */
  const lanes = new Map<string, Promise<unknown>>();
  const queue = <T>(key: string, work: () => Promise<T>): Promise<T> => {
    const next = (lanes.get(key) ?? Promise.resolve()).then(work, work);
    lanes.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  };

  /** The repository root a path sits in — a project inside a worktree or a
   *  subdirectory checkpoints the whole tree it belongs to. */
  async function root(dir: string): Promise<string | undefined> {
    if (!dir || !fs.existsSync(dir)) return undefined;
    const found = await git(["rev-parse", "--show-toplevel"], dir);
    return found.ok && found.out ? found.out : undefined;
  }

  /** HEAD, and where every branch and tag points. */
  async function stateOf(top: string): Promise<RefState> {
    const refs = new Map<string, string>();
    const listed = await git(
      ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags"],
      top,
    );
    if (listed.ok && listed.out) {
      for (const line of listed.out.split("\n")) {
        const [sha, name] = line.split(" ");
        if (sha && name) refs.set(name, sha);
      }
    }
    const symbolic = await git(["symbolic-ref", "-q", "HEAD"], top);
    if (symbolic.ok && symbolic.out) return { head: { ref: symbolic.out }, refs };
    const sha = await git(["rev-parse", "-q", "--verify", "HEAD"], top);
    return { head: sha.ok && sha.out ? { sha: sha.out } : null, refs };
  }

  /** The working tree as it stands, as a commit object — with the refs'
   *  state in its message, and parented on HEAD (and on anything else that
   *  must stay reachable through it). */
  async function commitTree(
    top: string,
    channelId: string,
    subject: string,
    extraParents: string[] = [],
  ): Promise<string | undefined> {
    fs.mkdirSync(indexDir(), { recursive: true });
    const index = indexFor(channelId);
    const added = await git(["add", "-A", "--", "."], top, { index });
    if (!added.ok) return undefined;
    const tree = await git(["write-tree"], top, { index });
    if (!tree.ok || !tree.out) return undefined;
    const head = await git(["rev-parse", "--verify", "HEAD"], top);
    // parented on HEAD when there is one, so the object is reachable from
    // something familiar if anyone ever goes looking; a repository without
    // a first commit yet checkpoints just as well
    const parents = [...new Set([...(head.ok && head.out ? [head.out] : []), ...extraParents])];
    const message = `${subject}\n\n${stateLines(await stateOf(top))}\n`;
    const commit = await git(["commit-tree", tree.out, ...parents.flatMap((p) => ["-p", p])], top, {
      index,
      input: message,
    });
    return commit.ok && commit.out ? commit.out : undefined;
  }

  async function refs(top: string, channelId: string): Promise<{ name: string; ts: number }[]> {
    const listed = await git(
      ["for-each-ref", "--format=%(refname) %(committerdate:unix)", `refs/ruri/${channelId}`],
      top,
    );
    if (!listed.ok || !listed.out) return [];
    return listed.out.split("\n").map((line) => {
      const [name = "", ts = "0"] = line.split(" ");
      return { name, ts: Number(ts) };
    });
  }

  async function drop(top: string, names: string[]): Promise<void> {
    // one process for the lot: a channel with two hundred stale refs is one
    // `update-ref --stdin`, not two hundred spawns
    if (names.length === 0) return;
    await git(["update-ref", "--stdin"], top, { input: names.map((name) => `delete ${name}\n`).join("") });
  }

  /** Write the tree down under `ref`, then trim the channel's oldest. */
  async function take(top: string, channelId: string, ref: string, subject: string): Promise<boolean> {
    const commit = await commitTree(top, channelId, subject);
    if (!commit) return false;
    const set = await git(["update-ref", ref, commit], top);
    if (!set.ok) return false;
    const held = await refs(top, channelId);
    if (held.length > KEEP) {
      const stale = held
        .filter((r) => !r.name.endsWith(`/${UNDO}`))
        .sort((a, b) => a.ts - b.ts)
        .slice(0, held.length - KEEP)
        .map((r) => r.name);
      await drop(top, stale);
    }
    return true;
  }

  /** A ref's commit, if it has one. */
  async function resolve(top: string, ref: string): Promise<string | undefined> {
    const found = await git(["rev-parse", "-q", "--verify", `${ref}^{commit}`], top);
    return found.ok && found.out ? found.out : undefined;
  }

  /** What a checkpoint commit says the refs were. */
  async function stateIn(top: string, commit: string): Promise<RefState | undefined> {
    const body = await git(["cat-file", "commit", commit], top);
    if (!body.ok) return undefined;
    const at = body.out.indexOf("\n\n");
    return at === -1 ? undefined : parseState(body.out.slice(at + 2));
  }

  /** Every path that differs between two trees, with both sides. */
  async function changes(top: string, from: string, to: string): Promise<Change[]> {
    const diff = await git(["diff-tree", "-r", "-z", "--no-renames", from, to], top);
    if (!diff.ok || !diff.out) return [];
    const fields = diff.out.split("\0");
    const out: Change[] = [];
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const [modeA, modeB, shaA, shaB] = fields[i]!.replace(/^:/, "").split(" ");
      const file = fields[i + 1]!;
      if (!modeA || !modeB || !shaA || !shaB) continue;
      out.push({
        path: file,
        ...(NULL_SHA.test(shaA) ? {} : { before: { mode: modeA, sha: shaA } }),
        ...(NULL_SHA.test(shaB) ? {} : { after: { mode: modeB, sha: shaB } }),
      });
    }
    return out;
  }

  /** Every file in a tree, by path. */
  async function entries(top: string, tree: string): Promise<Map<string, Entry>> {
    const listed = await git(["ls-tree", "-r", "-z", "--full-tree", tree], top);
    const map = new Map<string, Entry>();
    if (!listed.ok || !listed.out) return map;
    for (const record of listed.out.split("\0")) {
      const tab = record.indexOf("\t");
      if (tab === -1) continue;
      const [mode, , sha] = record.slice(0, tab).split(" ");
      if (mode && sha) map.set(record.slice(tab + 1), { mode, sha });
    }
    return map;
  }

  /**
   * One file changed by the turn and by something else since: the turn's
   * change (`base` → `theirs`, backwards) taken out of what is there now,
   * line by line. Answers the merged blob, or undefined when the lines
   * cross — or when either side is not a plain file to begin with.
   */
  async function mergeBack(top: string, now: Entry, base: Entry, theirs: Entry): Promise<Entry | undefined> {
    const plain = (e: Entry) => e.mode === "100644" || e.mode === "100755";
    if (!plain(now) || !plain(base) || !plain(theirs)) return undefined;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-merge-"));
    try {
      const files: string[] = [];
      for (const [name, entry] of [
        ["now", now],
        ["base", base],
        ["theirs", theirs],
      ] as const) {
        const blob = await gitRaw(["cat-file", "blob", entry.sha], top);
        if (blob.code !== 0) return undefined;
        const file = path.join(tmp, name);
        fs.writeFileSync(file, blob.out);
        files.push(file);
      }
      const merged = await gitRaw(["merge-file", "-p", "-q", ...files], top);
      if (merged.code !== 0) return undefined;
      const written = await git(["hash-object", "-w", "--stdin"], top, { input: merged.out });
      return written.ok && written.out ? { mode: now.mode, sha: written.out } : undefined;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Commits a ref's move would drop from it — reachable from where it is
   *  now and not from where it goes back to, nor from anything that stood
   *  before the turn — and whether any of them is on a remote already. */
  async function dropped(
    top: string,
    name: string,
    from: string,
    to: string | undefined,
    before: RefState,
  ): Promise<{ commits: number; pushed: boolean }> {
    const floor = [...new Set([...(to ? [to] : []), ...before.refs.values()])].map((sha) => `${sha}^{}`);
    const count = async (extra: string[]) => {
      const listed = await git(["rev-list", "--count", `${from}^{}`, "--not", ...floor, ...extra], top);
      return listed.ok ? Number(listed.out) : NaN;
    };
    const commits = await count([]);
    const unpushed = await count(["--remotes"]);
    // what cannot be counted cannot be shown to be safe to let go of
    if (!(commits === unpushed)) return { commits: commits || 0, pushed: true };
    // a branch pushed as it stands, with nothing new on it
    if (name.startsWith("refs/heads/")) {
      const tracking = await git(["for-each-ref", "--points-at", from, "refs/remotes"], top);
      if (tracking.ok && tracking.out) return { commits, pushed: true };
    }
    return { commits, pushed: false };
  }

  /** Branches checked out in some other worktree of this repository —
   *  moving one would pull the ground from under that checkout. */
  async function elsewhere(top: string): Promise<Set<string>> {
    const listed = await git(["worktree", "list", "--porcelain"], top);
    const out = new Set<string>();
    if (!listed.ok) return out;
    let here = false;
    for (const line of listed.out.split("\n")) {
      if (line.startsWith("worktree ")) here = path.resolve(line.slice(9)) === path.resolve(top);
      else if (line.startsWith("branch ") && !here) out.add(line.slice(7));
    }
    return out;
  }

  return {
    async capture(project, channelId, eventId) {
      return queue(channelId, async () => {
        const top = await root(project.path);
        if (!top) return false;
        return take(top, channelId, refFor(channelId, eventId), `ruri checkpoint ${eventId}`);
      });
    },

    async settle(project, channelId, eventId) {
      return queue(channelId, async () => {
        const top = await root(project.path);
        if (!top) return false;
        // a turn with no checkpoint of its own going in has no change to
        // measure, and this one would only take up room
        if (!(await resolve(top, refFor(channelId, eventId)))) return false;
        return take(top, channelId, doneRefFor(channelId, eventId), `ruri turn done ${eventId}`);
      });
    },

    async idle(channelId) {
      await lanes.get(channelId);
    },

    async restore(project, channelId, eventId) {
      return queue(channelId, async () => {
        const top = await root(project.path);
        if (!top) return "this project isn't a git repository, so ruri has no checkpoints for it";
        const ref = refFor(channelId, eventId);
        const found = await git(["rev-parse", "--verify", `${ref}^{tree}`], top);
        if (!found.ok || !found.out) return "no checkpoint was taken for that prompt";
        // Where the files stand right now, kept before they are replaced —
        // a rewind is the one move here that destroys work, and this is the
        // copy that means it doesn't have to.
        const undo = await commitTree(top, channelId, `ruri pre-rewind ${eventId}`);
        if (undo) await git(["update-ref", refFor(channelId, UNDO), undo], top);
        // The index was just brought up to the working tree by that capture,
        // so git knows exactly which files the checkpoint doesn't have and
        // takes them away with it — every file it never had (ignored ones
        // included) it leaves alone.
        const back = await git(["read-tree", "-u", "--reset", found.out], top, {
          index: indexFor(channelId),
        });
        if (!back.ok) return back.error;
        return undefined;
      });
    },

    async rewind(project, channelId, eventIds) {
      const report: RewindReport = { conflicts: [], refs: [], kept: [] };
      const fail = (error: string): RewindReport => ({ ...report, error });
      return queue(channelId, async () => {
        const top = await root(project.path);
        if (!top) return fail("this project isn't a git repository, so ruri has no checkpoints for it");
        const first = eventIds[0];
        const start = first ? await resolve(top, refFor(channelId, first)) : undefined;
        if (!first || !start) return fail("no checkpoint was taken for that prompt");

        // The tree as it stands, written down before anything moves: the
        // private index is now the working tree, which is what lets the
        // tree be put back file by file at the end.
        const now = await commitTree(top, channelId, `ruri pre-rewind ${first}`);
        if (!now) return fail("the working tree could not be read");
        const nowState = (await stateIn(top, now)) ?? (await stateOf(top));

        // The turns, each as the stretch between its two captures. A turn
        // missing its closing capture (ruri stopped mid-turn, or the turn is
        // from before they were taken) runs on to the next prompt's opening
        // one, or to now — so everything a discarded turn did is covered, at
        // the cost of taking along whatever happened in between.
        const spans: Array<{ from: string; to: string }> = [];
        let from = start;
        for (let i = 0; i < eventIds.length; i++) {
          const id = eventIds[i]!;
          const next = eventIds[i + 1];
          const nextStart = next ? await resolve(top, refFor(channelId, next)) : undefined;
          const to =
            (await resolve(top, doneRefFor(channelId, id))) ??
            nextStart ??
            (next === undefined ? now : undefined);
          if (!to) continue;
          spans.push({ from, to });
          from = nextStart ?? to;
        }

        // ── the files ──────────────────────────────────────────────────
        // Each turn's change is taken back out of the tree, newest first:
        // a file the turn changed and nothing touched since goes back to
        // how the turn found it; one something else has changed as well
        // has the turn's change merged back out of it, line by line.
        const tree = await entries(top, now);
        const touched = new Set<string>();
        for (const span of [...spans].reverse()) {
          for (const change of await changes(top, span.from, span.to)) {
            const current = tree.get(change.path);
            if (sameEntry(current, change.before)) continue;
            let next: Entry | undefined = change.before;
            if (!sameEntry(current, change.after)) {
              const merged =
                current && change.before && change.after
                  ? await mergeBack(top, current, change.after, change.before)
                  : undefined;
              if (merged) next = merged;
              else if (!report.conflicts.includes(change.path)) report.conflicts.push(change.path);
            }
            if (next) tree.set(change.path, next);
            else tree.delete(change.path);
            touched.add(change.path);
          }
        }

        // ── the refs ───────────────────────────────────────────────────
        // A branch or tag a turn moved (or made, or took away) goes back to
        // how the turn found it, when it still stands where the turn left
        // it and nothing it would drop has been pushed.
        const states = new Map<string, RefState | undefined>();
        const stateAt = async (commit: string) => {
          if (!states.has(commit)) states.set(commit, commit === now ? nowState : await stateIn(top, commit));
          return states.get(commit);
        };
        const live = new Map(nowState.refs);
        let head = nowState.head;
        const busyElsewhere = await elsewhere(top);
        /** Each ref to put back: where it stands now, where it goes (absent:
         *  it goes), and how many commits it lets go of on the way. The same
         *  ref taken back across several turns is one move. */
        const plan = new Map<string, { from?: string; to?: string; commits: number }>();
        for (const span of [...spans].reverse()) {
          const before = await stateAt(span.from);
          const after = await stateAt(span.to);
          if (!before || !after) continue; // checkpoints from before refs were written down
          for (const name of new Set([...before.refs.keys(), ...after.refs.keys()])) {
            const was = before.refs.get(name);
            const became = after.refs.get(name);
            if (was === became) continue;
            const why =
              live.get(name) !== became ? "moved" : busyElsewhere.has(name) ? "worktree" : undefined;
            if (why) {
              report.kept.push({ name, why });
              continue;
            }
            let commits = 0;
            if (became) {
              const lost = await dropped(top, name, became, was, before);
              if (lost.pushed) {
                report.kept.push({ name, why: "pushed" });
                continue;
              }
              commits = lost.commits;
            }
            const seen = plan.get(name);
            plan.set(name, {
              ...(seen ? (seen.from ? { from: seen.from } : {}) : became ? { from: became } : {}),
              ...(was ? { to: was } : {}),
              commits: (seen?.commits ?? 0) + commits,
            });
            if (was) live.set(name, was);
            else live.delete(name);
          }
          if (!sameHead(before.head, after.head) && sameHead(head, after.head)) {
            const branch = before.head && "ref" in before.head ? before.head.ref : undefined;
            // back onto a branch only if it is there to stand on (or had no
            // commit yet, which is what an unborn HEAD looks like)
            if (!branch || live.has(branch) || !before.refs.has(branch)) head = before.head;
          }
        }
        // the branch HEAD ends up on is never the one taken away under it
        const onBranch = head && "ref" in head ? head.ref : undefined;
        if (onBranch && plan.has(onBranch) && !plan.get(onBranch)!.to) {
          plan.delete(onBranch);
          report.kept.push({ name: onBranch, why: "moved" });
        }
        for (const [name, move] of plan) {
          if (move.from === move.to) plan.delete(name);
          else report.refs.push({ name, ...(move.to ? { to: move.to } : {}), commits: move.commits });
        }

        // What is about to stop being reachable stays reachable through the
        // undo checkpoint: it is parented on every tip that moves or goes.
        const tips: string[] = [];
        for (const move of plan.values()) {
          const tip = move.from ? await resolve(top, move.from) : undefined;
          if (tip) tips.push(tip);
        }
        const undo = tips.length ? await commitTree(top, channelId, `ruri pre-rewind ${first}`, tips) : now;
        if (undo) await git(["update-ref", refFor(channelId, UNDO), undo], top);

        // ── putting it all down ────────────────────────────────────────
        const oldHead = await resolve(top, "HEAD");
        if (plan.size > 0) {
          const script = [...plan]
            .map(([name, m]) =>
              !m.to
                ? `delete ${name} ${m.from}\n`
                : m.from
                  ? `update ${name} ${m.to} ${m.from}\n`
                  : `create ${name} ${m.to}\n`,
            )
            .join("");
          const moved = await git(["update-ref", "--stdin"], top, { input: script });
          if (!moved.ok) {
            // all or nothing: update-ref applies the lot in one transaction
            for (const entry of report.refs) report.kept.push({ name: entry.name, why: "moved" });
            report.refs = [];
          }
        }
        if (!sameHead(head, nowState.head) && head) {
          const put =
            "ref" in head
              ? await git(["symbolic-ref", "HEAD", head.ref], top)
              : await git(["update-ref", "--no-deref", "HEAD", head.sha], top);
          if (put.ok) report.head = "ref" in head ? head.ref : head.sha;
        }

        // The files: the result as a tree of its own, then laid over the
        // working tree through the private index, which knows the working
        // tree exactly — so only what differs is written.
        if (touched.size > 0) {
          const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rewind-"));
          try {
            const index = path.join(scratch, "index");
            const seeded = await git(["read-tree", now], top, { index });
            if (!seeded.ok) return fail(seeded.error);
            const lines = [...touched]
              .map((file) => {
                const entry = tree.get(file);
                return entry ? `${entry.mode} ${entry.sha}\t${file}\0` : `0 ${"0".repeat(40)}\t${file}\0`;
              })
              .join("");
            const updated = await git(["update-index", "-z", "--index-info"], top, { index, input: lines });
            if (!updated.ok) return fail(updated.error);
            const result = await git(["write-tree"], top, { index });
            if (!result.ok || !result.out)
              return fail(result.ok ? "the rewound tree could not be written" : result.error);
            const back = await git(["read-tree", "-u", "--reset", result.out], top, {
              index: indexFor(channelId),
            });
            if (!back.ok) return fail(back.error);
          } finally {
            fs.rmSync(scratch, { recursive: true, force: true });
          }
        }

        // The staging area follows HEAD where HEAD moved, and lets go of
        // anything a discarded turn staged — so `git status` afterwards says
        // what the tree now differs by, not what the turns had in hand.
        const newHead = await resolve(top, "HEAD");
        const unstage = new Set<string>();
        if (oldHead && newHead && oldHead !== newHead) {
          const moved = await git(
            ["diff-tree", "-r", "-z", "--name-only", "--no-renames", oldHead, newHead],
            top,
          );
          if (moved.ok) for (const file of moved.out.split("\0")) if (file) unstage.add(file);
        }
        if (touched.size > 0) {
          const staged = await git(["ls-files", "-s", "-z"], top);
          const nowTree = await entries(top, now);
          if (staged.ok) {
            for (const record of staged.out.split("\0")) {
              const tab = record.indexOf("\t");
              if (tab === -1) continue;
              const file = record.slice(tab + 1);
              if (!touched.has(file)) continue;
              const [mode, sha] = record.slice(0, tab).split(" ");
              // staged as the turns left it, and no longer what the tree holds
              if (sameEntry({ mode: mode!, sha: sha! }, nowTree.get(file))) unstage.add(file);
            }
          }
        }
        if (newHead && unstage.size > 0) {
          await git(["reset", "-q", newHead, "--pathspec-from-file=-", "--pathspec-file-nul"], top, {
            input: [...unstage].join("\0"),
          });
        }
        return report;
      });
    },

    async has(project, channelId, eventId) {
      const top = await root(project.path);
      if (!top) return false;
      const found = await git(["rev-parse", "--verify", refFor(channelId, eventId)], top);
      return found.ok && found.out.length > 0;
    },

    async forget(project, channelId, eventIds) {
      if (eventIds.length === 0) return;
      await queue(channelId, async () => {
        const top = await root(project.path);
        if (!top) return;
        const held = new Set((await refs(top, channelId)).map((r) => r.name));
        await drop(
          top,
          eventIds
            .flatMap((eventId) => [refFor(channelId, eventId), doneRefFor(channelId, eventId)])
            .filter((name) => held.has(name)),
        );
      });
    },

    async forgetChannel(project, channelId) {
      await queue(channelId, async () => {
        const top = await root(project.path);
        if (top)
          await drop(
            top,
            (await refs(top, channelId)).map((ref) => ref.name),
          );
        fs.rmSync(indexFor(channelId), { force: true });
      });
    },
  };
}
