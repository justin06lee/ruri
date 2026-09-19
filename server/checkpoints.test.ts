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
    expect(await createCheckpoints().restore(project(), "chan", "never")).toBe("no checkpoint was taken for that prompt");
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
    expect(await createCheckpoints().capture({ id: "p", path: path.join(os.tmpdir(), "ruri-no-such-dir") }, "c", "e")).toBe(false);
  });
});
