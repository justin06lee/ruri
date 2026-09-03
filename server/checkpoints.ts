/**
 * A checkpoint of the project's files, per prompt, on every harness.
 *
 * Claude's CLI takes its own file checkpoints and a rewind rides those. No
 * other harness does, so until now a rewind on Codex — or on Claude after a
 * relaunch, since the CLI keeps its checkpoints with the process that took
 * them — put the conversation back and left the files exactly as the
 * discarded turns had left them. The prompt came back to the composer, but
 * the work it caused stayed done.
 *
 * So ruri takes its own, and they belong to ruri rather than to any
 * harness: before a prompt goes out, the project's whole working tree is
 * written into git as a commit nobody can see, under a ref named for the
 * prompt. Rewinding to that prompt puts the tree back.
 *
 * What makes this cheap enough to do on every prompt:
 *
 * - It never touches the repository the user is working in. The commit is
 *   built through a private index file, so `git status`, the staging area,
 *   and the branch are exactly as they were; the object lands in the object
 *   database and a ref under `refs/ruri/` points at it. Nothing is on any
 *   branch, nothing is pushed, and `git log` is unchanged.
 * - That index file is kept per channel rather than made fresh, so git's
 *   stat cache survives between prompts: the first capture in a session
 *   hashes the tree, and the ones after it hash what changed.
 * - Ignored files are ignored — `git add -A` obeys .gitignore, so
 *   node_modules and .env are neither captured nor, on the way back,
 *   deleted.
 *
 * A project that is not a git repository has no checkpoints, and every
 * caller here is written to say so rather than to pretend otherwise.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where the per-channel index files live. */
const INDEX_DIR = path.join(os.homedir(), ".config", "ruri", "checkpoints");

/** A capture that takes longer than this has met a repository ruri has no
 *  business holding up a prompt for. */
const TIMEOUT_MS = 20_000;

/** Checkpoints kept per channel; older refs are dropped as new ones land. */
const KEEP = 200;

/** Where the tree stood before a restore put it back — the one thing a
 *  rewind would otherwise destroy without a copy. */
const UNDO = "undo";

function git(
  args: string[],
  cwd: string,
  indexFile?: string,
): Promise<{ ok: true; out: string } | { ok: false; error: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env,
      },
      (err, stdout, stderr) => {
        if (err) resolve({ ok: false, error: (stderr || err.message).trim().split("\n")[0] ?? "git failed" });
        else resolve({ ok: true, out: stdout.trim() });
      },
    );
  });
}

/** A ref name for one prompt. Both ids are uuids, which git accepts. */
function refFor(channelId: string, eventId: string): string {
  return `refs/ruri/${channelId}/${eventId}`;
}

function indexFor(channelId: string): string {
  return path.join(INDEX_DIR, `${channelId}.index`);
}

export interface Checkpoints {
  /** Write down the project's files as they stand, under this prompt.
   *  Answers whether there is now a checkpoint to come back to. */
  capture(project: { id: string; path: string }, channelId: string, eventId: string): Promise<boolean>;
  /** Put the project's files back to a prompt's checkpoint. Answers what
   *  went wrong, or nothing at all if the tree is back. */
  restore(project: { path: string }, channelId: string, eventId: string): Promise<string | undefined>;
  /** Whether a prompt has a checkpoint at all. */
  has(project: { path: string }, channelId: string, eventId: string): Promise<boolean>;
  /** Drop the checkpoints of prompts that are no longer in the transcript. */
  forget(project: { path: string }, channelId: string, eventIds: string[]): Promise<void>;
  /** Drop every checkpoint a channel owns, and its index file. */
  forgetChannel(project: { path: string }, channelId: string): Promise<void>;
}

export function createCheckpoints(): Checkpoints {
  /** One git run per project at a time: two captures racing on the same
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

  /** The working tree as it stands, as a commit object. */
  async function commitTree(top: string, channelId: string, message: string): Promise<string | undefined> {
    fs.mkdirSync(INDEX_DIR, { recursive: true });
    const index = indexFor(channelId);
    const added = await git(["add", "-A", "--", "."], top, index);
    if (!added.ok) return undefined;
    const tree = await git(["write-tree"], top, index);
    if (!tree.ok || !tree.out) return undefined;
    const head = await git(["rev-parse", "--verify", "HEAD"], top);
    // parented on HEAD when there is one, so the object is reachable from
    // something familiar if anyone ever goes looking; a repository without
    // a first commit yet checkpoints just as well
    const parent = head.ok && head.out ? ["-p", head.out] : [];
    const commit = await git(["commit-tree", tree.out, ...parent, "-m", message], top, index);
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
    await new Promise<void>((resolve) => {
      const child = execFile("git", ["update-ref", "--stdin"], { cwd: top, timeout: TIMEOUT_MS }, () => resolve());
      child.stdin?.end(names.map((name) => `delete ${name}\n`).join(""));
    });
  }

  return {
    async capture(project, channelId, eventId) {
      return queue(channelId, async () => {
        const top = await root(project.path);
        if (!top) return false;
        const commit = await commitTree(top, channelId, `ruri checkpoint ${eventId}`);
        if (!commit) return false;
        const set = await git(["update-ref", refFor(channelId, eventId), commit], top);
        if (!set.ok) return false;
        const held = await refs(top, channelId);
        if (held.length > KEEP) {
          const stale = held
            .filter((ref) => !ref.name.endsWith(`/${UNDO}`))
            .sort((a, b) => a.ts - b.ts)
            .slice(0, held.length - KEEP)
            .map((ref) => ref.name);
          await drop(top, stale);
        }
        return true;
      });
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
        const back = await git(["read-tree", "-u", "--reset", found.out], top, indexFor(channelId));
        if (!back.ok) return back.error;
        return undefined;
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
        await drop(
          top,
          eventIds.map((eventId) => refFor(channelId, eventId)),
        );
      });
    },

    async forgetChannel(project, channelId) {
      await queue(channelId, async () => {
        const top = await root(project.path);
        if (top) await drop(top, (await refs(top, channelId)).map((ref) => ref.name));
        fs.rmSync(indexFor(channelId), { force: true });
      });
    },
  };
}
