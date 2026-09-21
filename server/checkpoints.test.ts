import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCheckpoints } from "./checkpoints.js";

let config: string;
let repo: string;
let saved: string | undefined;

const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const read = (rel: string) => fs.readFileSync(path.join(repo, rel), "utf8");
const write = (rel: string, text: string) => fs.writeFileSync(path.join(repo, rel), text);

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ckpt-config-"));
  process.env["RURI_CONFIG_DIR"] = config;
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ckpt-repo-"));
  git("init", "-q", "-b", "master");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  write(".gitignore", "secret.env\n");
  write("a.txt", "one");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

const project = () => ({ id: "proj", path: repo });

describe("checkpoints against a real repository", () => {
  test("a restore puts the tree back: edits undone, new files gone, deleted files back", async () => {
    const ckpt = createCheckpoints();
    write("b.txt", "untracked but not ignored");
    expect(await ckpt.capture(project(), "chan", "e1")).toBe(true);
    expect(await ckpt.has(project(), "chan", "e1")).toBe(true);

    write("a.txt", "two");
    write("c.txt", "made by the turn");
    fs.rmSync(path.join(repo, "b.txt"));
    expect(await ckpt.restore(project(), "chan", "e1")).toBeUndefined();

    expect(read("a.txt")).toBe("one");
    expect(read("b.txt")).toBe("untracked but not ignored");
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
  });

  test("the user's repository is untouched: branch, log, staging area", async () => {
    const ckpt = createCheckpoints();
    const head = git("rev-parse", "HEAD");
    write("a.txt", "edited, unstaged");
    await ckpt.capture(project(), "chan", "e1");
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("log", "--oneline").split("\n")).toHaveLength(1);
    expect(git("diff", "--cached", "--name-only")).toBe("");
    expect(git("status", "--porcelain")).toBe("M a.txt");
    expect(git("for-each-ref", "--format=%(refname)", "refs/ruri/")).toBe("refs/ruri/chan/e1");
  });

  test("ignored files are neither captured nor taken away", async () => {
    const ckpt = createCheckpoints();
    await ckpt.capture(project(), "chan", "e1");
    write("secret.env", "TOKEN=1");
    await ckpt.restore(project(), "chan", "e1");
    expect(read("secret.env")).toBe("TOKEN=1");
  });

  test("the tree as it stood before a restore is kept under an undo ref", async () => {
    const ckpt = createCheckpoints();
    await ckpt.capture(project(), "chan", "e1");
    write("a.txt", "work worth keeping");
    await ckpt.restore(project(), "chan", "e1");
    expect(git("show", "refs/ruri/chan/undo:a.txt")).toBe("work worth keeping");
  });

  test("forget drops a prompt's checkpoint; forgetChannel drops them all and the index", async () => {
    const ckpt = createCheckpoints();
    await ckpt.capture(project(), "chan", "e1");
    await ckpt.capture(project(), "chan", "e2");
    await ckpt.forget(project(), "chan", ["e1"]);
    expect(await ckpt.has(project(), "chan", "e1")).toBe(false);
    expect(await ckpt.has(project(), "chan", "e2")).toBe(true);
    expect(fs.existsSync(path.join(config, "checkpoints", "chan.index"))).toBe(true);
    await ckpt.forgetChannel(project(), "chan");
    expect(await ckpt.has(project(), "chan", "e2")).toBe(false);
    expect(fs.existsSync(path.join(config, "checkpoints", "chan.index"))).toBe(false);
  });

  test("a prompt with no checkpoint says so", async () => {
    expect(await createCheckpoints().restore(project(), "chan", "never")).toBe(
      "no checkpoint was taken for that prompt",
    );
  });

  test("a repository with no first commit yet checkpoints just as well", async () => {
    // a fresh directory rather than this one with its .git taken away: a
    // git process the setup's commit left running can write the old refs
    // back into a .git re-made at the same path, and HEAD then names a
    // commit that is not there
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ckpt-empty-"));
    write("a.txt", "one");
    git("init", "-q", "-b", "master");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    const ckpt = createCheckpoints();
    expect(await ckpt.capture(project(), "chan", "e1")).toBe(true);
    write("a.txt", "changed");
    expect(await ckpt.restore(project(), "chan", "e1")).toBeUndefined();
    expect(read("a.txt")).toBe("one");
  });
});

describe("a project that is not a git repository", () => {
  test("has no checkpoints, and the restore says why", async () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ckpt-plain-"));
    const ckpt = createCheckpoints();
    expect(await ckpt.capture({ id: "p", path: plain }, "chan", "e1")).toBe(false);
    expect(await ckpt.has({ path: plain }, "chan", "e1")).toBe(false);
    expect(await ckpt.restore({ path: plain }, "chan", "e1")).toBe(
      "this project isn't a git repository, so ruri has no checkpoints for it",
    );
    fs.rmSync(plain, { recursive: true, force: true });
  });

  test("nor does a path that is not there", async () => {
    expect(
      await createCheckpoints().capture(
        { id: "p", path: path.join(os.tmpdir(), "ruri-no-such-dir") },
        "c",
        "e",
      ),
    ).toBe(false);
  });
});

describe("a rewind undoes the discarded turns and nothing else", () => {
  /** One turn of a chat: its opening capture, what it does, its closing one. */
  const turn = async (
    ckpt: ReturnType<typeof createCheckpoints>,
    channel: string,
    id: string,
    work: () => void,
  ) => {
    await ckpt.capture(project(), channel, id);
    work();
    await ckpt.settle(project(), channel, id);
  };
  const lines = (n: number, change: Record<number, string> = {}) =>
    Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join("\n") + "\n";

  test("a chat's turns alone come back out exactly", async () => {
    const ckpt = createCheckpoints();
    write("b.txt", "untracked but not ignored");
    await turn(ckpt, "chan", "e1", () => {
      write("a.txt", "two");
      write("c.txt", "made by the turn");
    });
    await turn(ckpt, "chan", "e2", () => {
      fs.rmSync(path.join(repo, "b.txt"));
      write("a.txt", "three");
    });
    const report = await ckpt.rewind(project(), "chan", ["e1", "e2"]);
    expect(report.error).toBeUndefined();
    expect(report.conflicts).toEqual([]);
    expect(read("a.txt")).toBe("one");
    expect(read("b.txt")).toBe("untracked but not ignored");
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
  });

  test("rewinding the later turn keeps the earlier one", async () => {
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => write("a.txt", "from turn one"));
    await turn(ckpt, "chan", "e2", () => write("c.txt", "from turn two"));
    await ckpt.rewind(project(), "chan", ["e2"]);
    expect(read("a.txt")).toBe("from turn one");
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
  });

  test("what happened between turns — the user's own edit — is still there", async () => {
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => write("a.txt", "the turn's"));
    write("mine.txt", "written by hand between turns");
    await turn(ckpt, "chan", "e2", () => write("c.txt", "more"));
    await ckpt.rewind(project(), "chan", ["e1", "e2"]);
    expect(read("a.txt")).toBe("one");
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
    expect(read("mine.txt")).toBe("written by hand between turns");
  });

  test("another chat's work in the same repository survives", async () => {
    const ckpt = createCheckpoints();
    await turn(ckpt, "chat-a", "a1", () => write("a.txt", "chat a"));
    await turn(ckpt, "chat-b", "b1", () => write("b-made.txt", "chat b"));
    const report = await ckpt.rewind(project(), "chat-a", ["a1"]);
    expect(report.conflicts).toEqual([]);
    expect(read("a.txt")).toBe("one");
    expect(read("b-made.txt")).toBe("chat b");
  });

  test("a file both changed has the turn's lines taken out and the rest kept", async () => {
    write("f.txt", lines(20));
    git("add", "-A");
    git("commit", "-q", "-m", "twenty lines");
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => write("f.txt", lines(20, { 2: "the turn's line" })));
    write("f.txt", lines(20, { 2: "the turn's line", 18: "someone else's line" }));
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.conflicts).toEqual([]);
    expect(read("f.txt")).toBe(lines(20, { 18: "someone else's line" }));
  });

  test("where the lines cross, the file goes back whole and the rewind says so", async () => {
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => write("a.txt", "the turn's"));
    write("a.txt", "someone else's, on top");
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.conflicts).toEqual(["a.txt"]);
    expect(read("a.txt")).toBe("one");
    // and what it held is not lost
    expect(git("show", "refs/ruri/chan/undo:a.txt")).toBe("someone else's, on top");
  });

  test("a commit the turn made is taken back, and nothing is left staged", async () => {
    const ckpt = createCheckpoints();
    const start = git("rev-parse", "HEAD");
    await turn(ckpt, "chan", "e1", () => {
      write("a.txt", "committed by the turn");
      git("commit", "-qam", "the turn's commit");
      write("b.txt", "staged by the turn");
      git("add", "b.txt");
    });
    const made = git("rev-parse", "HEAD");
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.refs).toEqual([{ name: "refs/heads/master", to: start, commits: 1 }]);
    expect(git("rev-parse", "HEAD")).toBe(start);
    expect(read("a.txt")).toBe("one");
    expect(git("status", "--porcelain")).toBe("");
    // the commit it let go of stays reachable through the undo checkpoint
    expect(git("merge-base", "--is-ancestor", made, "refs/ruri/chan/undo") === "").toBe(true);
  });

  test("a commit already pushed is left on its branch", async () => {
    const remote = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ckpt-remote-"));
    execFileSync("git", ["init", "-q", "--bare", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "-u", "origin", "master");
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => {
      write("a.txt", "pushed by the turn");
      git("commit", "-qam", "pushed");
      git("push", "-q");
    });
    const pushed = git("rev-parse", "HEAD");
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.kept).toEqual([{ name: "refs/heads/master", why: "pushed" }]);
    expect(git("rev-parse", "HEAD")).toBe(pushed);
    fs.rmSync(remote, { recursive: true, force: true });
  });

  test("a branch made, merged, deleted and tagged in a turn all comes undone", async () => {
    const ckpt = createCheckpoints();
    const start = git("rev-parse", "HEAD");
    await turn(ckpt, "chan", "e1", () => {
      git("switch", "-q", "-c", "feat/x");
      write("feature.txt", "the feature");
      git("add", "-A");
      git("commit", "-q", "-m", "feature");
      git("switch", "-q", "master");
      git("merge", "-q", "--no-ff", "-m", "merge feat/x", "feat/x");
      git("branch", "-q", "-d", "feat/x");
      git("tag", "-a", "feat-x", "-m", "Feature: x");
    });
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.kept).toEqual([]);
    expect(git("rev-parse", "HEAD")).toBe(start);
    expect(git("tag", "--list")).toBe("");
    expect(git("branch", "--list", "feat/x")).toBe("");
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(false);
    expect(git("status", "--porcelain")).toBe("");
  });

  test("a branch the turn left checked out: HEAD goes back to where it was, the branch goes", async () => {
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => {
      git("switch", "-q", "-c", "wip");
      write("a.txt", "on wip");
      git("commit", "-qam", "wip");
    });
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.head).toBe("refs/heads/master");
    expect(git("symbolic-ref", "HEAD")).toBe("refs/heads/master");
    expect(git("branch", "--list", "wip")).toBe("");
    expect(read("a.txt")).toBe("one");
    expect(git("status", "--porcelain")).toBe("");
  });

  test("a branch moved again since is left where it is", async () => {
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => {
      write("a.txt", "the turn's");
      git("commit", "-qam", "the turn's commit");
    });
    write("later.txt", "the user's");
    git("add", "later.txt");
    git("commit", "-qm", "the user's commit, on top");
    const theirs = git("rev-parse", "HEAD");
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.kept).toEqual([{ name: "refs/heads/master", why: "moved" }]);
    expect(git("rev-parse", "HEAD")).toBe(theirs);
    expect(read("later.txt")).toBe("the user's");
  });

  test("a turn with no closing capture runs on to now, as a whole-tree rewind did", async () => {
    const ckpt = createCheckpoints();
    await ckpt.capture(project(), "chan", "e1");
    write("a.txt", "two");
    write("c.txt", "new");
    const report = await ckpt.rewind(project(), "chan", ["e1"]);
    expect(report.error).toBeUndefined();
    expect(read("a.txt")).toBe("one");
    expect(fs.existsSync(path.join(repo, "c.txt"))).toBe(false);
  });

  test("forget drops a prompt's closing capture along with its opening one", async () => {
    const ckpt = createCheckpoints();
    await turn(ckpt, "chan", "e1", () => write("a.txt", "two"));
    expect(git("for-each-ref", "--format=%(refname)", "refs/ruri/chan/done")).toBe("refs/ruri/chan/done/e1");
    await ckpt.forget(project(), "chan", ["e1"]);
    expect(git("for-each-ref", "--format=%(refname)", "refs/ruri/chan")).toBe("");
  });

  test("a prompt with no checkpoint says so", async () => {
    const report = await createCheckpoints().rewind(project(), "chan", ["never"]);
    expect(report.error).toBe("no checkpoint was taken for that prompt");
  });
});
