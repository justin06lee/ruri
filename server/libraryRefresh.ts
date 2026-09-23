import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { NamedComponent } from "../shared/protocol.js";
import { parseRef } from "./library.js";
import { errorCode, isMissing, warn } from "./log.js";

const execFileAsync = promisify(execFile);

/**
 * Keeping the library true to the code, without a model: what git can say
 * about each entry since it was last known to be right.
 *
 * An entry is written once — named as it was built, or found by the sweep —
 * and the code under it keeps moving. Files get renamed or deleted, and the
 * entry goes on pointing at them; the component gets reworked, and its note
 * and its picture go on describing the old one. Nobody re-reads an entry
 * they think is fine, so the library quietly drifts into describing a
 * project that no longer exists.
 *
 * A turn that edits an entry's files marks it changed as it ends
 * (ComponentStore.touch). This is the rest: work done outside ruri, or by
 * a shell command no diff saw. It answers three things per entry — files
 * that moved (followed through git's renames), files that are gone, and the
 * commits to its own files since its picture and note were current — and
 * the refresh (server/handlers/components.ts) does the rest.
 */

/** Commits this soon after an entry's picture or note are taken to be the
 *  work it already shows. A session builds, photographs, and only then
 *  commits — a commit minutes after the picture is the same change, and
 *  the edits a turn makes after its picture are caught by the turn itself. */
export const CHANGE_GRACE_MS = 60 * 60_000;

async function git(dir: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20_000,
    });
    return stdout;
  } catch (err) {
    // not a repo (128), or no git at all
    const exit = (err as { code?: unknown }).code;
    if (exit !== 128 && errorCode(err) !== "ENOENT") warn("libraryRefresh", err, args[0]);
    return undefined;
  }
}

/** One commit to a file, as the review reads it. */
export interface FileCommit {
  at: number;
  subject: string;
}

/** `git log --format=%x01%ct%x02%s --name-only` read back: each file's
 *  commits, newest first. */
export function parseHistory(out: string): Map<string, FileCommit[]> {
  const byFile = new Map<string, FileCommit[]>();
  let current: FileCommit | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("\u0001")) {
      const [at, ...subject] = line.slice(1).split("\u0002");
      current = { at: Number(at) * 1000, subject: subject.join("\u0002").trim() };
      continue;
    }
    const file = line.trim();
    if (!file || !current) continue;
    const list = byFile.get(file) ?? [];
    list.push(current);
    byFile.set(file, list);
  }
  return byFile;
}

/** Every commit since `since` (ms), per file it touched, newest first — one
 *  `git log` for the whole library rather than one per entry. */
export async function fileHistory(dir: string, since: number): Promise<Map<string, FileCommit[]>> {
  // git reads a small number as anything but a timestamp: below 2001 the
  // whole history is asked for instead
  const from = since >= 1e12 ? [`--since=@${Math.floor(since / 1000)}`] : [];
  const out = await git(dir, ["log", ...from, "--format=%x01%ct%x02%s", "--name-only", "--no-merges"]);
  return out ? parseHistory(out) : new Map();
}

/** Files with changes git hasn't been given yet, repo-relative. */
export async function dirtyFiles(dir: string): Promise<Set<string>> {
  const out = await git(dir, ["status", "--porcelain", "--untracked-files=no"]);
  const dirty = new Set<string>();
  for (const line of (out ?? "").split("\n")) {
    if (line.length < 4) continue;
    // "XY path" or "XY old -> new"
    const file = line.slice(3).split(" -> ").pop()!.trim().replace(/^"|"$/g, "");
    dirty.add(file);
  }
  return dirty;
}

/**
 * Where a file that is no longer there went: the commit that last touched
 * it removed it, and if that commit renamed it, the new name — followed a
 * few hops, in case it moved again. Undefined when it was simply deleted
 * (or git doesn't know it).
 */
export async function renamedTo(dir: string, rel: string, hops = 3): Promise<string | undefined> {
  const last = (await git(dir, ["log", "-1", "--format=%H", "--", rel]))?.trim();
  if (!last) return undefined;
  const out = await git(dir, ["show", "-M", "--name-status", "--format=", last]);
  for (const line of (out ?? "").split("\n")) {
    const [status, from, to] = line.split("\t");
    if (!status?.startsWith("R") || from !== rel || !to) continue;
    if (fs.existsSync(path.join(dir, to))) return to;
    return hops > 1 ? renamedTo(dir, to, hops - 1) : undefined;
  }
  return undefined;
}

/** A ref ("styles.css:2864") pointed somewhere else, its line kept. */
function repoint(ref: string, to: string): string {
  const { line } = parseRef(ref);
  return line !== undefined ? `${to}:${line}` : to;
}

function exists(dir: string, ref: string): boolean {
  try {
    fs.statSync(path.join(dir, parseRef(ref).path));
    return true;
  } catch (err) {
    if (!isMissing(err)) warn("libraryRefresh", err, "exists");
    return false;
  }
}

/** What the files of one entry have become. */
export interface EntryFiles {
  id: string;
  /** Its lists as they should now read — only when something moved or went. */
  files?: string[];
  uses?: string[];
  /** Its own files are gone, and nothing says where to. */
  gone?: boolean;
}

/** Each entry's files checked against the tree: moved ones followed,
 *  deleted ones dropped. Answers only the entries that need a change. */
export async function tidyFiles(dir: string, items: NamedComponent[]): Promise<EntryFiles[]> {
  const out: EntryFiles[] = [];
  const followed = new Map<string, string | undefined>();
  const follow = async (ref: string): Promise<string | undefined> => {
    const file = parseRef(ref).path;
    if (!followed.has(file)) followed.set(file, await renamedTo(dir, file));
    const to = followed.get(file);
    return to ? repoint(ref, to) : undefined;
  };
  const fix = async (list: string[]): Promise<{ list: string[]; changed: boolean }> => {
    let changed = false;
    const next: string[] = [];
    for (const ref of list) {
      if (exists(dir, ref)) {
        next.push(ref);
        continue;
      }
      changed = true;
      const moved = await follow(ref);
      if (moved && !next.includes(moved)) next.push(moved);
    }
    return { list: next, changed };
  };
  for (const item of items) {
    const own = await fix(item.files);
    const uses = await fix(item.uses ?? []);
    if (!own.changed && !uses.changed) continue;
    // its own code gone is the component gone, whatever shared file it
    // reached into; one that only ever lived in shared files goes with them
    const gone = item.files.length
      ? own.list.length === 0
      : (item.uses?.length ?? 0) > 0 && uses.list.length === 0;
    if (gone) {
      out.push({ id: item.id, gone: true });
      continue;
    }
    out.push({
      id: item.id,
      ...(own.changed ? { files: own.list } : {}),
      ...(uses.changed ? { uses: uses.list } : {}),
    });
  }
  return out;
}

/**
 * Commits that change nothing a person sees or reads about a component:
 * tests, docs, builds, chores, and reformatting — conventional commits'
 * `style:` is whitespace and formatting, not CSS, but a scoped one
 * ("style(sidebar): …") is let through, in case a project uses it for looks.
 */
const UNSEEN = /^(test|tests|docs|ci|build|chore)(\([^)]*\))?!?:|^style!?:/i;

export function seenChange(subject: string): boolean {
  return !UNSEEN.test(subject.trim());
}

/** When an entry was last known to be right — the older of its picture and
 *  its note, since either one going stale is worth a look. */
export function currentAsOf(item: NamedComponent): number {
  const note = item.noteAt ?? item.updated ?? item.ts;
  return item.shots.length && item.shotAt ? Math.min(item.shotAt, note) : note;
}

/** What has happened to one entry's own files since it was right. */
export interface EntryChange {
  id: string;
  /** The latest change past the grace — commit or uncommitted edit. */
  at: number;
  /** The commits behind it, newest first. */
  commits: FileCommit[];
  /** Its files have edits git hasn't been given yet. */
  uncommitted: boolean;
}

/**
 * The entries whose own files changed after they were last right, and how:
 * from the history (fileHistory) and the uncommitted set (dirtyFiles), with
 * `mtime` for when an uncommitted file was last written.
 */
export function changesSince(
  items: NamedComponent[],
  history: Map<string, FileCommit[]>,
  dirty: Set<string>,
  mtime: (rel: string) => number | undefined,
): EntryChange[] {
  const out: EntryChange[] = [];
  for (const item of items) {
    const after = currentAsOf(item) + CHANGE_GRACE_MS;
    const own = item.files.map((f) => parseRef(f).path);
    const seen = new Set<string>();
    const commits: FileCommit[] = [];
    for (const file of own) {
      for (const commit of history.get(file) ?? []) {
        if (commit.at <= after || !seenChange(commit.subject)) continue;
        const key = `${commit.at}\u0000${commit.subject}`;
        if (seen.has(key)) continue;
        seen.add(key);
        commits.push(commit);
      }
    }
    commits.sort((a, b) => b.at - a.at);
    let at = commits[0]?.at ?? 0;
    let uncommitted = false;
    for (const file of own) {
      if (!dirty.has(file)) continue;
      const written = mtime(file) ?? 0;
      if (written <= after) continue;
      uncommitted = true;
      at = Math.max(at, written);
    }
    if (at) out.push({ id: item.id, at, commits, uncommitted });
  }
  return out;
}

/** A file's last write, for changesSince. */
export function mtimeIn(dir: string): (rel: string) => number | undefined {
  return (rel) => {
    try {
      return fs.statSync(path.join(dir, rel)).mtimeMs;
    } catch (err) {
      if (!isMissing(err)) warn("libraryRefresh", err, "mtime");
      return undefined;
    }
  };
}
