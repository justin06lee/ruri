import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BriefStore } from "./brief.js";
import type { ServerContext } from "./context.js";
import { candidatePairs, cancelChecks, checkMemory } from "./memoryCheck.js";
import { linesWith, MemoryBook } from "./memoryLog.js";

let config: string;
let repo: string;
let ctx: ServerContext;
let asked: Array<{ system: string; prompt: string }>;
let replies: Record<string, (prompt: string) => string>;

function sh(...args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}

const ask = async (system: string, prompt: string) => {
  asked.push({ system, prompt });
  const key = system.includes("pairs") ? "pairs" : "verify";
  return replies[key]?.(prompt) ?? "{}";
};

beforeEach(() => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-check-"));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-check-repo-"));
  process.env["RURI_CONFIG_DIR"] = config;
  sh("init", "-q", "-b", "master");
  write("README.md", "# env.local\n\nLLM-built simulation worlds on a fork of Bevy 0.19.1.\n");
  write("app/package.json", JSON.stringify({ dependencies: { "@justin06lee/yagami": "^0.12.0" } }));
  write("app/web/icon.html", "const LIFT = 10;\nconst NUDGE = 21;\n");
  sh("add", "-A");
  sh("commit", "-q", "-m", "Import Bevy v0.19.1");
  const briefs = new BriefStore();
  briefs.write("p", { description: "A Bevy-based studio for simulation worlds", features: [] });
  const project = { id: "p", name: "env.local", path: repo, sessions: [] };
  asked = [];
  replies = {};
  ctx = {
    store: { get: (id: string) => (id === "p" ? project : undefined), list: () => [project] },
    briefs,
    memory: new MemoryBook(briefs),
    archive: { exchangeNo: () => undefined, turnIds: () => [] },
    clients: { broadcast: () => {} },
    manager: { statuses: () => ({}) },
  } as unknown as ServerContext;
});

afterEach(() => {
  cancelChecks();
  fs.rmSync(config, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  delete process.env["RURI_CONFIG_DIR"];
});

/** The memory as an older ruri kept it, brought into the log. */
function seed(lines: Array<{ id: string; part: string; text: string; by?: string; why?: string }>): void {
  const memory = { now: [], decisions: [], worked: [], failed: [], gotchas: [], open: [] } as Record<
    string,
    unknown[]
  >;
  for (const l of lines)
    memory[l.part]!.push({ id: l.id, text: l.text, by: l.by ?? "model", ...(l.why ? { why: l.why } : {}) });
  (ctx.briefs as BriefStore).remember("p", memory as never);
  ctx.memory.state("p");
}

/** A line as the log has it — a copy, since the matchers may write to
 *  what they are handed. */
const current = (id: string) => {
  const record = ctx.memory.record("p", id);
  return record ? structuredClone(record) : undefined;
};

describe("a memory held up against its code", () => {
  test("without a model: what moved is marked stale, what can't be told waits, what holds is anchored", async () => {
    seed([
      {
        id: "dymp8",
        part: "decisions",
        text: "Keep env.local on `file:../../yagami` until v0.12.0 published, then flip to `^0.12.0`",
      },
      { id: "d5d9r", part: "decisions", text: "Build skin over unmodified Godot 4.6, not fork" },
      { id: "d9c2j", part: "decisions", text: "App icon cube LIFT 10 NUDGE 21", by: "agent" },
    ]);
    const report = (await checkMemory(ctx, "p", { verify: false }))!;
    expect(report).toMatchObject({ checked: 3, stale: 1, unchecked: 1 });
    expect(current("dymp8")!.check).toMatchObject({
      reason: expect.stringContaining("not file:../../yagami"),
    });
    expect(current("d5d9r")!.check).toMatchObject({ kind: "unchecked" });
    expect(current("d9c2j")!.check).toBeUndefined();
    expect(current("d9c2j")!.anchors?.values).toEqual([
      { name: "LIFT", value: "10", file: "app/web/icon.html" },
      { name: "NUDGE", value: "21", file: "app/web/icon.html" },
    ]);
    // a second pass changes nothing
    const events = ctx.memory.history("p").length;
    await checkMemory(ctx, "p", { verify: false });
    expect(ctx.memory.history("p").length).toBe(events);
  });

  test("the model's verdicts: holds is anchored, stale is corrected or retired, the user's line is only marked", async () => {
    seed([
      {
        id: "dymp8",
        part: "decisions",
        text: "Keep env.local on `file:../../yagami` until v0.12.0, then flip to `^0.12.0`",
      },
      { id: "d5d9r", part: "decisions", text: "Build skin over unmodified Godot 4.6, not fork" },
      { id: "oura0", part: "open", text: "Godot go/no-go: install Godot 4.6 and measure steps/s" },
      { id: "duser", part: "decisions", text: "Godot editor replaces the three.js one", by: "user" },
      { id: "dmuj", part: "decisions", text: "Fly body needs MuJoCo for physics fidelity", by: "agent" },
    ]);
    replies["verify"] = (prompt) => {
      expect(prompt).toContain("README opens");
      expect(prompt).toContain("Import Bevy v0.19.1");
      return JSON.stringify({
        verdicts: [
          {
            id: "dymp8",
            verdict: "stale",
            reason: "the flip happened",
            evidence: "app/package.json has ^0.12.0",
          },
          {
            id: "d5d9r",
            verdict: "stale",
            reason: "the studio is on Bevy",
            evidence: "README: on a fork of Bevy 0.19.1",
            text: "Studio is built on a fork of Bevy 0.19.1, not Godot",
          },
          {
            id: "oura0",
            verdict: "stale",
            reason: "decided for Bevy",
            evidence: "commit Import Bevy v0.19.1",
          },
          { id: "duser", verdict: "stale", reason: "Godot is gone", evidence: "README" },
          { id: "dmuj", verdict: "unsure", reason: "nothing in the repo bears on it" },
        ],
      });
    };
    const report = (await checkMemory(ctx, "p", { ask }))!;
    expect(report.verdicts).toMatchObject({ retired: 2, superseded: 1, unsure: 1 });
    expect(current("dymp8")).toMatchObject({ status: "retired" });
    expect(current("oura0")).toMatchObject({ status: "retired" });
    const replacement = current(current("d5d9r")!.supersededBy!)!;
    expect(replacement).toMatchObject({
      status: "current",
      text: "Studio is built on a fork of Bevy 0.19.1, not Godot",
    });
    // the user's line is never changed by the model: marked with what the check found
    expect(current("duser")).toMatchObject({
      status: "current",
      check: { reason: "Godot is gone (README)" },
    });
    expect(current("duser")!.check!.kind).toBeUndefined();
    expect(current("dmuj")!.check!.tried).toBeNumber();
    // and one fold of the log takes it all back
    const undo = ctx.memory.undo("p", { by: "user" });
    expect(undo.undone.length).toBeGreaterThan(0);
  });

  test("two lines giving one setting two values: the one the code agrees with is kept", async () => {
    seed([
      {
        id: "d9c2j",
        part: "decisions",
        text: "App icon cube drawn at 820 px, LIFT 10 NUDGE 21",
        by: "agent",
      },
      {
        id: "wm4eu",
        part: "worked",
        text: "Icon page centres cube with LIFT=9 up, NUDGE=18 right in app/web/icon.html",
      },
    ]);
    const pairs = candidatePairs(linesWith(ctx.memory.state("p")));
    expect(pairs.map((p) => [p.a.id, p.b.id, p.clash])).toEqual([["d9c2j", "wm4eu", ["LIFT", "NUDGE"]]]);
    replies["verify"] = () =>
      JSON.stringify({
        verdicts: [{ id: "wm4eu", verdict: "unsure", reason: "leave it to the pair check" }],
      });
    replies["pairs"] = (prompt) => {
      expect(prompt).toContain("the code: LIFT is set to 10 in app/web/icon.html");
      return JSON.stringify({
        pairs: [
          {
            pair: 1,
            verdict: "contradict",
            keep: "d9c2j",
            reason: "the code sets 10 and 21",
            evidence: "app/web/icon.html",
          },
        ],
      });
    };
    const report = (await checkMemory(ctx, "p", { ask }))!;
    expect(report.clashes).toEqual([{ a: "d9c2j", b: "wm4eu", names: ["LIFT", "NUDGE"] }]);
    expect(report.conflicts).toEqual([
      { a: "d9c2j", b: "wm4eu", verdict: "contradict", reason: "the code sets 10 and 21" },
    ]);
    expect(current("wm4eu")).toMatchObject({
      status: "retired",
      reason: expect.stringContaining("contradicted by d9c2j"),
    });
    expect(current("d9c2j")!.status).toBe("current");
  });

  test("a now restating an open is merged into it; a pair judged unrelated isn't asked about again", async () => {
    seed([
      {
        id: "nb4nq",
        part: "now",
        text: "Debrief output still labels people Players, awaiting user call on Personnel",
      },
      {
        id: "o7bd6",
        part: "open",
        text: "Debrief report still says Players — change to Personnel or similar",
        by: "agent",
      },
      { id: "g1", part: "gotchas", text: "Pushing to the Jetson checkout fails for its checked-out branch" },
      { id: "g2", part: "gotchas", text: "The Jetson checkout rejects a push to the branch it has out" },
    ]);
    replies["pairs"] = (prompt) => {
      // the pairs come numbered in the order the check ranks them
      const blocks = prompt.split("\n\n");
      const n = (id: string) => blocks.findIndex((block) => block.includes(`  ${id} (`)) + 1;
      return JSON.stringify({
        pairs: [
          { pair: n("nb4nq"), verdict: "duplicate", keep: "o7bd6", reason: "same item" },
          { pair: n("g1"), verdict: "consistent" },
        ],
      });
    };
    await checkMemory(ctx, "p", { ask });
    expect(current("nb4nq")).toMatchObject({ status: "superseded", supersededBy: "o7bd6" });
    const before = asked.filter((a) => a.system.includes("pairs")).length;
    await checkMemory(ctx, "p", { ask });
    expect(asked.filter((a) => a.system.includes("pairs")).length).toBe(before);
  });

  test("a repeat keeps the agent's line over the model's, whichever the judge preferred", async () => {
    seed([
      {
        id: "d9c2j",
        part: "decisions",
        text: "Studio button shows a still glass cube while the preview is on; app icon cube drawn at 820 px, LIFT 10 NUDGE 21",
        by: "agent",
      },
      {
        id: "wasnw",
        part: "worked",
        text: "Icon page centres cube with LIFT 10 NUDGE 21 in app/web/icon.html",
      },
      { id: "o1", part: "open", text: "Debrief report still says Players — change to Personnel or similar" },
      {
        id: "n1",
        part: "now",
        text: "Debrief output still labels people Players, awaiting user call on Personnel",
        by: "agent",
      },
    ]);
    replies["pairs"] = (prompt) => {
      const blocks = prompt.split("\n\n");
      const n = (id: string) => blocks.findIndex((block) => block.includes(`  ${id} (`)) + 1;
      return JSON.stringify({
        pairs: [
          { pair: n("d9c2j"), verdict: "duplicate", keep: "wasnw", reason: "same values" },
          { pair: n("o1"), verdict: "duplicate", keep: "o1", reason: "same item" },
        ],
      });
    };
    await checkMemory(ctx, "p", { ask });
    // the judge would have merged the agent's fuller line away: the
    // model's shorter one goes into it instead
    expect(current("d9c2j")!.status).toBe("current");
    expect(current("wasnw")).toMatchObject({ status: "superseded", supersededBy: "d9c2j" });
    // the agent's stays, whatever the judge preferred
    expect(current("o1")).toMatchObject({ status: "superseded", supersededBy: "n1" });
  });

  test("an undecided contradiction marks both lines, shown as disagreeing", async () => {
    seed([
      { id: "a1", part: "decisions", text: "Themes default to light at 7AM, TIMEOUT 30", by: "user" },
      { id: "a2", part: "decisions", text: "Themes default to dark at 7AM, TIMEOUT 45" },
    ]);
    replies["pairs"] = () =>
      JSON.stringify({ pairs: [{ pair: 1, verdict: "contradict", reason: "light or dark?" }] });
    await checkMemory(ctx, "p", { ask });
    expect(current("a1")!.check).toMatchObject({
      kind: "conflict",
      reason: "disagrees with a2: light or dark?",
    });
    expect(current("a2")!.check).toMatchObject({ kind: "conflict" });
  });
});
