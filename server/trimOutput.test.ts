import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { SHOW_ALL_LINES, trimCommand } from "./trimOutput.js";

describe("which commands are wrapped", () => {
  test("test, build and lint runs, alone or after a cd", () => {
    for (const command of ["bun test", "bun test server/x.test.ts", "cd web && npm run build", "pytest -q", "go test ./...", "make test", 'make tenet RUN="bun test"'])
      expect(trimCommand({ command })).toBeDefined();
  });

  test("everything else, and any run whose output the model already shapes", () => {
    for (const command of [
      "ls -la",
      "git status",
      "bun test | tail -5",
      "bun test > out.txt",
      "bun test 2>&1 | grep fail",
      "cat <<EOF\nx\nEOF",
      "bun test &",
      "bun test; echo done",
      "echo $(bun test)",
      "make dev",
    ])
      expect(trimCommand({ command })).toBeUndefined();
    expect(trimCommand({ command: "bun test", run_in_background: true })).toBeUndefined();
    expect(trimCommand({})).toBeUndefined();
  });
});

describe("what the model gets back", () => {
  /** Runs `make test` with a make that prints `lines` lines and exits `status`. */
  const run = (lines: number, status: number) => {
    const fake = `make() { i=1; while [ $i -le ${lines} ]; do if [ $i -eq 7 ]; then echo "line $i FAIL here"; else echo "line $i ok"; fi; i=$((i+1)); done; return ${status}; }`;
    const wrapped = trimCommand({ command: "make test" })!;
    return spawnSync("sh", ["-c", `${fake}; ${wrapped}`], { encoding: "utf8" });
  };

  test("short output whole, with the run's own exit status", () => {
    const out = run(SHOW_ALL_LINES, 0);
    expect(out.status).toBe(0);
    expect(out.stdout.trim().split("\n")).toHaveLength(SHOW_ALL_LINES);
    expect(out.stdout).not.toContain("cut this output down");
  });

  test("long output: the failing lines, the tail, and where the rest is; the status kept", () => {
    const out = run(2000, 3);
    expect(out.status).toBe(3);
    expect(out.stdout).toContain("7:line 7 FAIL here");
    expect(out.stdout).toContain("line 2000 ok");
    expect(out.stdout).not.toContain("line 1000 ok");
    expect(out.stdout).toContain("the last 60 of 2000 lines");
    const file = /all of it is in (\S+)\]/.exec(out.stdout)?.[1];
    expect(file).toBeDefined();
    spawnSync("rm", ["-f", file!]);
  });
});
