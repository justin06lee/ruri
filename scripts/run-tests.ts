/**
 * Every integration script that costs no tokens, run one after another,
 * with a pass/fail table at the end and a non-zero exit if any failed.
 *
 *   bun run test:scripts
 *
 * The scripts themselves are unchanged: each is run as `bunx tsx
 * scripts/<name>.ts` from the repo root, exactly as its own `bun run
 * <name>-test` line does, and only its exit code is read. Anything that
 * spends tokens (smoke, rewind, fork, the live agent tests…) or needs a
 * display (bridge, chips, shot) stays manual — see docs/testing.md.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

interface Script {
  name: string;
  /** What it covers, for the table. */
  what: string;
  /** A binary that must be on PATH, or the script is skipped, not failed. */
  needs?: string;
}

const SCRIPTS: Script[] = [
  { name: "paragraphs", what: "a streamed reply comes out a paragraph at a time" },
  { name: "commands", what: "slash commands lifted out of a prompt" },
  { name: "session-settings", what: "model, effort and mode are per chat" },
  { name: "history", what: "the two-part transcript: fold, split, rewind, fork, cap" },
  { name: "home-cap", what: "Home keeps its newest 50 events" },
  { name: "digest", what: "a brief lists 40 exchanges; the oldest fold into its digest" },
  { name: "notes", what: "recall notes survive a spent small model; the history outline" },
  { name: "compaction-attachments", what: "compaction leaves a path to every attachment" },
  { name: "orphans", what: "the launch sweep for what closed sessions left" },
  { name: "uploads-sweep", what: "uploads nothing mentions are swept after a day" },
  { name: "checkpoint", what: "ruri's own file checkpoints against a real git repo" },
  { name: "port", what: "the port is reclaimed from an orphaned ruri, never a stranger" },
  { name: "provider-events", what: "a fake harness turn, event by event" },
  { name: "subagents", what: "a fake harness's agents become cards and logs" },
  { name: "hidden", what: "hidden projects, Home's tools, the finder, the real server" },
  { name: "asleep", what: "a window asleep stops the meters sampling" },
  { name: "terminal", what: "a noisy shell: output whole and in order, scrollback capped" },
  { name: "rewind-compaction", what: "rewinding either side of a compaction" },
  { name: "retry", what: "a dropped turn goes again (real CLI, mock gateway)", needs: "claude" },
];

/** Whole-run guard: a script that hangs must not hold the suite open. */
const TIMEOUT_MS = 10 * 60_000;

const root = path.resolve(import.meta.dirname, "..");

function onPath(binary: string): boolean {
  return (process.env["PATH"] ?? "").split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      fs.accessSync(path.join(dir, binary), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

interface Outcome {
  name: string;
  what: string;
  status: "pass" | "fail" | "skip";
  ms: number;
  note?: string;
}

function run(script: Script): Promise<Outcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bunx", ["tsx", `scripts/${script.name}.ts`], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      output += `\n[run-tests] killed after ${TIMEOUT_MS / 1000}s\n`;
    }, TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Date.now() - started;
      if (code === 0) {
        resolve({ name: script.name, what: script.what, status: "pass", ms });
        return;
      }
      // the whole output of a failed script, so the failure can be read
      // without running it again
      process.stdout.write(`\n──── ${script.name} failed (exit ${code}) ────\n${output}\n`);
      resolve({ name: script.name, what: script.what, status: "fail", ms, note: `exit ${code}` });
    });
  });
}

const outcomes: Outcome[] = [];
for (const script of SCRIPTS) {
  if (script.needs && !onPath(script.needs)) {
    outcomes.push({
      name: script.name,
      what: script.what,
      status: "skip",
      ms: 0,
      note: `no ${script.needs} on PATH`,
    });
    console.log(`skip  ${script.name} (no ${script.needs} on PATH)`);
    continue;
  }
  process.stdout.write(`run   ${script.name} …`);
  const outcome = await run(script);
  outcomes.push(outcome);
  process.stdout.write(
    `\r${outcome.status === "pass" ? "ok  " : "FAIL"}  ${script.name} (${(outcome.ms / 1000).toFixed(1)}s)\n`,
  );
}

const width = Math.max(...outcomes.map((o) => o.name.length));
console.log("\n" + "─".repeat(72));
for (const o of outcomes) {
  const mark = o.status === "pass" ? "ok  " : o.status === "fail" ? "FAIL" : "skip";
  const time = o.status === "skip" ? "" : `${(o.ms / 1000).toFixed(1)}s`;
  console.log(`${mark}  ${o.name.padEnd(width)}  ${time.padStart(6)}  ${o.note ?? o.what}`);
}
const passed = outcomes.filter((o) => o.status === "pass").length;
const failed = outcomes.filter((o) => o.status === "fail").length;
const skipped = outcomes.filter((o) => o.status === "skip").length;
console.log("─".repeat(72));
console.log(`${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
