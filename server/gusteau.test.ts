import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GUSTEAU_PREF } from "../shared/protocol.js";
import { gusteauBriefing, tasteBriefing } from "./gusteau.js";

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
  test("is off unless the setting says on", () => {
    process.env["RURI_GUSTEAU"] = bin;
    expect(tasteBriefing(withPref())).toBe("");
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
