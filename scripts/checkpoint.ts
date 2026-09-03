/**
 * ruri's own file checkpoints, against a real git repository.
 *
 * Everything here runs on a throwaway repo in a temp directory: a prompt is
 * checkpointed, the "model" edits, adds, and deletes files, and the rewind
 * has to put every one of them back — without touching the user's staging
 * area, their branch, or anything git was told to ignore.
 *
 *   bun run checkpoint-test
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createCheckpoints } from "../server/checkpoints.js";

let failures = 0;
function check(what: string, ok: boolean, detail?: string): void {
  console.log(ok ? `  ok   ${what}` : `  FAIL ${what}${detail ? `\n       ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-checkpoint-"));
const project = { id: "prj", path: root };
const channelId = `test-${Date.now()}`;
const checkpoints = createCheckpoints();

async function main(): Promise<void> {
  console.log(`\nruri checkpoints — ${root}\n`);

  git(["init", "-b", "master"], root);
  git(["config", "user.email", "test@ruri"], root);
  git(["config", "user.name", "ruri test"], root);
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored/\n");
  fs.writeFileSync(path.join(root, "kept.txt"), "first\n");
  fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
  fs.writeFileSync(path.join(root, "ignored", "huge.bin"), "not ours\n");
  git(["add", "-A"], root);
  git(["commit", "-m", "first"], root);

  // a file the user has staged but not committed: the rewind must not
  // touch what they have lined up
  fs.writeFileSync(path.join(root, "staged.txt"), "staged\n");
  git(["add", "staged.txt"], root);

  const head = git(["rev-parse", "HEAD"], root);
  const status = git(["status", "--porcelain"], root);

  console.log("before a prompt goes out");
  const prompt = "11111111-1111-1111-1111-111111111111";
  check("a checkpoint is taken", await checkpoints.capture(project, channelId, prompt));
  check("the prompt has one", await checkpoints.has(project, channelId, prompt));

  console.log("\nthe turn does its work");
  fs.writeFileSync(path.join(root, "kept.txt"), "changed by the model\n");
  fs.writeFileSync(path.join(root, "added.txt"), "the model made this\n");
  fs.mkdirSync(path.join(root, "deep", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "deep", "nested", "new.txt"), "nested\n");
  fs.rmSync(path.join(root, "staged.txt"));
  fs.writeFileSync(path.join(root, "ignored", "huge.bin"), "still not ours\n");

  console.log("\nrewind");
  const failed = await checkpoints.restore(project, channelId, prompt);
  check("the restore reports no trouble", failed === undefined, failed);
  check("an edited file is back", fs.readFileSync(path.join(root, "kept.txt"), "utf8") === "first\n");
  check("a file the turn added is gone", !fs.existsSync(path.join(root, "added.txt")));
  check("a nested file the turn added is gone", !fs.existsSync(path.join(root, "deep", "nested", "new.txt")));
  check("a file the turn deleted is back", fs.existsSync(path.join(root, "staged.txt")));
  check(
    "an ignored file is left exactly as it was",
    fs.readFileSync(path.join(root, "ignored", "huge.bin"), "utf8") === "still not ours\n",
  );

  console.log("\nthe user's own repository is untouched");
  check("HEAD has not moved", git(["rev-parse", "HEAD"], root) === head, git(["rev-parse", "HEAD"], root));
  check("the branch is the same", git(["rev-parse", "--abbrev-ref", "HEAD"], root) === "master");
  check("no checkpoint is on any branch", git(["log", "--oneline"], root).split("\n").length === 1);
  check(
    "what was staged is staged",
    git(["status", "--porcelain"], root) === status,
    `${JSON.stringify(git(["status", "--porcelain"], root))} vs ${JSON.stringify(status)}`,
  );

  console.log("\nthe state before the rewind is kept, so a rewind is not the end of it");
  const undo = git(["rev-parse", "--verify", `refs/ruri/${channelId}/undo^{tree}`], root);
  check("an undo ref stands", undo.length === 40);
  check(
    "and it holds what the turn had written",
    git(["show", `refs/ruri/${channelId}/undo:added.txt`], root) === "the model made this",
  );

  console.log("\nforgetting");
  await checkpoints.forget(project, channelId, [prompt]);
  check("a discarded prompt's checkpoint is gone", !(await checkpoints.has(project, channelId, prompt)));
  const second = "22222222-2222-2222-2222-222222222222";
  await checkpoints.capture(project, channelId, second);
  await checkpoints.forgetChannel(project, channelId);
  check("a closed session leaves none behind", !(await checkpoints.has(project, channelId, second)));

  console.log("\na project that is not a repository");
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-norepo-"));
  check("takes no checkpoint", (await checkpoints.capture({ id: "x", path: bare }, "c2", "e2")) === false);
  const why = await checkpoints.restore({ path: bare }, "c2", "e2");
  check("and says why rather than pretending", why !== undefined && why.includes("git repository"), why);
  fs.rmSync(bare, { recursive: true, force: true });

  console.log(failures === 0 ? "\nall good\n" : `\n${failures} failed\n`);
}

await main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true });
    process.exit(failures === 0 ? 0 : 1);
  });
