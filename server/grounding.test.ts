import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { MemoryLine } from "../shared/protocol.js";
import { checkLine, lineAnchors, lookAt } from "./grounding.js";

let repo: string;

function sh(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  }).trim();
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}

function commit(message: string): void {
  sh("add", "-A");
  sh("commit", "-q", "-m", message);
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ground-"));
  sh("init", "-q", "-b", "master");
  write("README.md", "# demo\n\nSimulation worlds on a fork of Bevy 0.19.1, drawn with Vulkan.\n");
  write(
    "app/package.json",
    JSON.stringify({ dependencies: { "@justin06lee/yagami": "^0.12.0", react: "^19.1.0" } }, null, 2),
  );
  write("app/web/icon.html", "<script>\n  const LIFT = 10;\n  const NUDGE = 21;\n</script>\n");
  write("server/fold.ts", "export function applyFold() {}\nexport const BRIEF_TURNS = 5;\n");
  commit("first");
  // a branch merged, one not, and one only on the remote
  sh("checkout", "-q", "-b", "feat/merged");
  write("merged.txt", "in");
  commit("merged work");
  sh("checkout", "-q", "master");
  sh("merge", "-q", "--no-ff", "feat/merged", "-m", "merge");
  sh("checkout", "-q", "-b", "codex/profiling");
  write("profile.txt", "work");
  commit("profiling");
  sh("update-ref", "refs/remotes/origin/codex/profiling", "HEAD");
  sh("checkout", "-q", "master");
  sh("branch", "-q", "-D", "codex/profiling");
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

const line = (text: string, extra: Partial<MemoryLine> = {}): MemoryLine => ({
  id: "x1",
  text,
  by: "model",
  ...extra,
});

describe("a line from before anchors, held up against the code as it stands", () => {
  test("a version it quotes that the package no longer has is stale", async () => {
    const view = await lookAt(repo);
    const found = await checkLine(
      line("Keep env.local on `file:../../yagami` until v0.12.0 published, then flip to `^0.12.0`"),
      view,
    );
    expect(found.strong).toEqual([
      "@justin06lee/yagami is ^0.12.0 in app/package.json, not file:../../yagami",
    ]);
  });

  test("a value the code sets otherwise is stale; the one it sets holds", async () => {
    const view = await lookAt(repo);
    const stale = await checkLine(
      line("Icon page centres cube with LIFT=9 up, NUDGE=18 right in app/web/icon.html"),
      view,
    );
    expect(stale.strong).toEqual([
      "app/web/icon.html has LIFT = 10 (the line says 9)",
      "app/web/icon.html has NUDGE = 21 (the line says 18)",
    ]);
    const holds = await checkLine(line("App icon cube drawn at 820 px, LIFT 10 NUDGE 21"), view);
    expect(holds.strong).toEqual([]);
  });

  test("a word the project no longer says of itself is put to a check, not shown as stale", async () => {
    const view = await lookAt(repo);
    const found = await checkLine(
      line("Build skin over unmodified Godot 4.6, not fork — avoids owning Godot upkeep"),
      view,
    );
    expect(found.strong).toEqual([]);
    expect(found.weak).toEqual(["Godot isn't in the project's README, docs or description"]);
    const bevy = await checkLine(line("Studio runs on a fork of Bevy 0.19.1, vendored under crates/"), view);
    expect(bevy.weak).toEqual([]);
  });

  test("a branch is known by any name — a remote's, an agent's prefix — and checked once", async () => {
    const view = await lookAt(repo);
    const open = await checkLine(
      line("origin/codex/profiling (7 commits) is not in master: merging it conflicts in 27 files"),
      view,
    );
    expect(open.strong).toEqual([]);
    expect(open.unchecked).toBe(true);
    expect(open.now.branches).toEqual([{ name: "origin/codex/profiling", state: "unmerged" }]);
    const merged = await checkLine(line("feat/merged is not merged yet — merge it next"), view);
    expect(merged.strong).toEqual(["feat/merged is merged into master now"]);
  });

  test("a path or symbol the code doesn't have is put to a check", async () => {
    const view = await lookAt(repo);
    const found = await checkLine(
      line("Install shipped RL build: examples/gym_env.py and `trainLoop`"),
      view,
    );
    expect(found.weak).toEqual([
      "examples/gym_env.py isn't in the project",
      "trainLoop doesn't appear in the code",
    ]);
    // a list with slashes, a file somewhere else and an outside path are not the project's
    const not = await checkLine(
      line("Themes light/dark/ember stored in settings.json under ~/Library/x"),
      view,
    );
    expect(not.weak).toEqual([]);
  });
});

describe("a line with anchors, compared with what moved", () => {
  test("anchors are what the code has when the line is written", async () => {
    const view = await lookAt(repo);
    const anchors = await lineAnchors(
      "Folds keep applyFold in server/fold.ts with LIFT 10; yagami ^0.12.0",
      "the renderer is on Vulkan",
      view,
    );
    expect(anchors.sha).toBe(sh("rev-parse", "--short", "HEAD"));
    expect(anchors.paths).toEqual([{ path: "server/fold.ts", exists: true }]);
    expect(anchors.symbols).toEqual([{ name: "applyFold", found: true }]);
    expect(anchors.values).toEqual([{ name: "LIFT", value: "10", file: "app/web/icon.html" }]);
    expect(anchors.packages).toEqual([
      { name: "@justin06lee/yagami", spec: "^0.12.0", file: "app/package.json" },
    ]);
    expect(anchors.terms).toEqual([{ term: "Vulkan", present: true }]);
  });

  test("a file gone, a symbol gone, a value, a version and a branch moved are all stale", async () => {
    const view = await lookAt(repo);
    const text =
      "Folds live in server/fold.ts as applyFold; icon LIFT 10; yagami ^0.12.0; origin/codex/profiling waits";
    const written = { ...line(text), anchors: await lineAnchors(text, undefined, view) };
    write("app/web/icon.html", "<script>\n  const LIFT = 12;\n</script>\n");
    write(
      "app/package.json",
      JSON.stringify({ dependencies: { "@justin06lee/yagami": "^0.13.0" } }, null, 2),
    );
    fs.rmSync(path.join(repo, "server/fold.ts"));
    commit("moved on");
    sh("merge", "-q", "--no-ff", "origin/codex/profiling", "-m", "merge profiling");
    const found = await checkLine(written, await lookAt(repo));
    expect(found.strong).toEqual([
      "server/fold.ts isn't in the project any more",
      "applyFold doesn't appear in the code any more",
      "@justin06lee/yagami is ^0.13.0 now (was ^0.12.0)",
      "origin/codex/profiling is merged into master now",
      "app/web/icon.html has LIFT = 12 (was 10)",
    ]);
  });

  test("a file it rests on changed where it touches what the line names", async () => {
    const view = await lookAt(repo);
    const text = "BRIEF_TURNS in server/fold.ts caps a fold at five turns";
    const written = { ...line(text), anchors: await lineAnchors(text, undefined, view) };
    write("server/fold.ts", "export function applyFold() {}\nexport const BRIEF_TURN_LIMIT = 9;\n// x\n");
    commit("renamed the cap");
    const found = await checkLine(written, await lookAt(repo));
    expect(found.strong[0]).toContain("server/fold.ts changed since");
    expect(found.strong[0]).toContain("where it has BRIEF_TURNS");
    // an unrelated change to the same file is not a reason
    const other = "applyFold in server/fold.ts takes deltas";
    const anchoredOther = {
      ...line(other),
      anchors: await lineAnchors(other, undefined, await lookAt(repo)),
    };
    write("server/fold.ts", "export function applyFold() {}\nexport const BRIEF_TURN_LIMIT = 9;\n// y\n");
    commit("comment");
    expect((await checkLine(anchoredOther, await lookAt(repo))).strong).toEqual([]);
  });
});
