import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GUSTEAU_PREF } from "../shared/protocol.js";
import { checkSummary, gusteauBriefing, learnFromProject, tasteBriefing, tasteCheck } from "./gusteau.js";

const withPref = (value?: string) => ({
  prefs: { all: (): Record<string, string> => (value === undefined ? {} : { [GUSTEAU_PREF]: value }) },
});

let dir: string;
let bin: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_GUSTEAU"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-gusteau-"));
  bin = path.join(dir, "gusteau");
  fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_GUSTEAU"];
  else process.env["RURI_GUSTEAU"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("design taste", () => {
  test("is on unless the setting says off", () => {
    process.env["RURI_GUSTEAU"] = bin;
    expect(tasteBriefing(withPref())).toContain("<ruri:taste>");
    expect(tasteBriefing(withPref("off"))).toBe("");
    expect(tasteBriefing(withPref("on"))).toContain("<ruri:taste>");
  });

  test("says nothing when gusteau isn't on this machine", () => {
    process.env["RURI_GUSTEAU"] = "";
    expect(tasteBriefing(withPref("on"))).toBe("");
  });

  test("names gusteau where it is, quoted when the path has a space", () => {
    expect(gusteauBriefing("/opt/g/gusteau")).toContain("`/opt/g/gusteau brief`");
    expect(gusteauBriefing("/Users/a b/gusteau")).toContain('`"/Users/a b/gusteau" check`');
  });
});

describe("design check and learning", () => {
  test("sums a check up: passing, or the count and the worst three", () => {
    expect(checkSummary(JSON.stringify({ passed: true, failures: [] }))).toBe("Design check passes");
    const failures = [1, 3, 2, 3, 1].map((severity, i) => ({ severity, message: `m${i}` }));
    expect(checkSummary(JSON.stringify({ passed: false, failures }))).toBe(
      "Design check: 5 issues — m1; m3; m2; …",
    );
    expect(checkSummary(JSON.stringify({ passed: false, failures: [{ severity: 1, message: "one" }] }))).toBe(
      "Design check: 1 issue — one",
    );
    expect(checkSummary("not json")).toBeNull();
    expect(checkSummary("{}")).toBeNull();
  });

  test("checks only a project with a .gusteau folder", async () => {
    const fake = path.join(dir, "fake-check");
    fs.writeFileSync(fake, `#!/bin/sh\necho '{"passed":false,"failures":[{"severity":2,"message":"raw hex"}]}'\nexit 1\n`, {
      mode: 0o755,
    });
    const project = fs.mkdtempSync(path.join(dir, "p-"));
    expect(await tasteCheck(project, fake)).toBeNull();
    fs.mkdirSync(path.join(project, ".gusteau"));
    expect(await tasteCheck(project, fake)).toBe("Design check: 1 issue — raw hex");
    expect(await tasteCheck(project, null)).toBeNull();
  });

  test("learns from the project in its folder, and says when gusteau is missing", async () => {
    const fake = path.join(dir, "fake-learn");
    fs.writeFileSync(fake, '#!/bin/sh\necho "learned 2 from this project in $(basename "$PWD")"\n', { mode: 0o755 });
    const project = fs.mkdtempSync(path.join(dir, "q-"));
    expect(await learnFromProject(project, fake)).toEqual({
      ok: true,
      output: `learned 2 from this project in ${path.basename(project)}`,
    });
    expect((await learnFromProject(project, null)).ok).toBe(false);
  });
});
