import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  branchFacts,
  commitsSince,
  gitLines,
  gitState,
  gitStateSync,
  headSync,
  unmerged,
} from "./gitState.js";

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-git-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
  git("init", "-q", "-b", "master");
  fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "first");
  git("switch", "-qc", "feat/done");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  git("add", ".");
  git("commit", "-qm", "done work");
  git("switch", "-q", "master");
  git("merge", "-q", "--no-ff", "-m", "merge done", "feat/done");
  git("switch", "-qc", "feat/self-update");
  fs.writeFileSync(path.join(dir, "c.txt"), "c\n");
  git("add", ".");
  git("commit", "-qm", "self update");
  git("switch", "-q", "master");
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
  return dir;
}

describe("git's account", () => {
  const dir = repo();

  test("the branch, what's uncommitted, what's unmerged and the last commits", async () => {
    const state = (await gitState(dir))!;
    expect(state.branch).toBe("master");
    expect(state.mainline).toBe("master");
    expect(state.dirty.length).toBe(2);
    expect(unmerged(state)).toEqual(["feat/self-update"]);
    expect(state.commits[0]!.subject).toBe("merge done");
    const lines = gitLines(state);
    expect(lines[0]).toStartWith("Branch: on master (");
    expect(lines.join("\n")).toContain("Uncommitted: 2 files — M a.txt, ?? new.txt");
    expect(lines.join("\n")).toContain("Not merged into master: feat/self-update");
    expect(lines.join("\n")).toContain("Last commits:");
    // the blocking read says the same
    expect(gitStateSync(dir)).toEqual(state);
  });

  test("what git says about the branches a line names", async () => {
    const state = await gitState(dir);
    expect(branchFacts("Publish subaru, then merge feat/self-update", state)).toBe(
      "[git: feat/self-update is not merged yet]",
    );
    expect(branchFacts("merge feat/done", state)).toBe("[git: feat/done is merged into master]");
    expect(branchFacts("finish feat/gone.", state)).toBe("[git: feat/gone isn't a branch here any more]");
    expect(branchFacts("run make update", state)).toBe("");
  });

  test("commits since a read of the repo, and nothing outside a repo", async () => {
    const head = headSync(dir)!;
    expect(await commitsSince(dir, head)).toBe(0);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-nogit-"));
    expect(await gitState(outside)).toBeUndefined();
    expect(gitStateSync(outside)).toBeUndefined();
  });
});
