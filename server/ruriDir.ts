import * as fs from "node:fs";
import * as path from "node:path";
import { errorCode, isMissing, warn } from "./log.js";

/**
 * The project's `.ruri/` folder: the one place ruri writes into a user's
 * repository.
 *
 * It writes there — a catch-up brief, a component index — because a file is
 * the one interface every harness has. It has no business showing up in
 * their `git status` for it, so the folder ignores itself: one `.gitignore`
 * saying `*`, written once, and git never mentions any of it again.
 *
 * Nor has it any business in a folder that is still blank. A new project is
 * where `create-next-app`, `bun create vite` and `git clone` get run, and
 * each of them refuses a folder holding anything it doesn't recognise
 * (`.ruri/` included) or offers to wipe it. So while a project holds
 * nothing but what a scaffolder builds around, ruri keeps its files to
 * itself and clears away any of them it left there before; the first turn
 * that gives the project something real puts them in (syncProjectFiles in
 * server/events.ts).
 */

/**
 * What a scaffolder builds around: the entries create-next-app lets a "new"
 * folder hold (helpers/is-folder-empty.ts), the strictest list of the
 * common ones. A folder with anything else in it was never going to be
 * scaffolded into, so `.ruri/` makes no difference there.
 */
const SCAFFOLD_SAFE = new Set([
  ".claude",
  ".cursor",
  ".DS_Store",
  ".git",
  ".gitattributes",
  ".gitignore",
  ".gitlab-ci.yml",
  ".hg",
  ".hgcheck",
  ".hgignore",
  ".idea",
  ".npmignore",
  ".travis.yml",
  ".vscode",
  ".yarn",
  ".zed",
  "LICENSE",
  "Thumbs.db",
  "docs",
  "mkdocs.yml",
  "npm-debug.log",
  "yarn-debug.log",
  "yarn-error.log",
  "yarnrc.yml",
]);

/** The files ruri keeps in `.ruri/` itself — the ones it may take away
 *  again. A drop file a model is halfway through writing is not one. */
const OWN = [".gitignore", "catchup.md", "components.md"];

/**
 * Whether a project folder is still blank: nothing in it but ruri's own
 * folder and what a scaffolder builds around. A folder that can't be read
 * counts — it is nowhere to be writing into either, and a project whose
 * drive is unplugged must not be recreated by a brief landing in it.
 */
export function blankProject(projectDir: string): boolean {
  let names: string[];
  try {
    names = fs.readdirSync(projectDir);
  } catch (err) {
    if (!isMissing(err)) warn("ruriDir", err, "blankProject");
    return true;
  }
  return names.every((name) => name === ".ruri" || SCAFFOLD_SAFE.has(name) || name.endsWith(".iml"));
}

/**
 * The project's `.ruri/` folder, made and kept out of git — or nothing,
 * while the project is still blank, with anything ruri left there cleared
 * away.
 */
export function ruriDir(projectDir: string): string | undefined {
  const dir = path.join(projectDir, ".ruri");
  if (blankProject(projectDir)) {
    clearRuriDir(projectDir);
    return undefined;
  }
  fs.mkdirSync(dir, { recursive: true });
  const ignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
  return dir;
}

/** Take ruri's files out of a project, and the folder with them when
 *  nothing else is in it. */
export function clearRuriDir(projectDir: string): void {
  const dir = path.join(projectDir, ".ruri");
  try {
    for (const name of OWN) fs.rmSync(path.join(dir, name), { force: true });
    fs.rmdirSync(dir);
  } catch (err) {
    // not there, or holding something that isn't ruri's to take
    if (!isMissing(err) && errorCode(err) !== "ENOTEMPTY") {
      warn("ruriDir", err, "clearRuriDir");
    }
  }
}

/**
 * Take one of ruri's files back out of a project — and the folder with it,
 * once nothing is left in there but its own `.gitignore`.
 */
export function removeRuriFile(projectDir: string, name: string): void {
  const dir = path.join(projectDir, ".ruri");
  fs.rmSync(path.join(dir, name), { force: true });
  let left: string[];
  try {
    left = fs.readdirSync(dir);
  } catch (err) {
    if (!isMissing(err)) warn("ruriDir", err, "removeRuriFile");
    return;
  }
  if (left.every((entry) => entry === ".gitignore")) clearRuriDir(projectDir);
}
