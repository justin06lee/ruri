import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BriefStore } from "./brief.js";
import { LedgerStore } from "./ledger.js";

const saved = process.env["RURI_CONFIG_DIR"];
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

describe("a store writes where it was made", () => {
  // A test sets its own config folder and puts the old one back when it is
  // done; a write the store had put off a moment then landed in whatever
  // the folder was by then — the user's own, when the tests ran on their
  // machine: the projects' sheets in briefs.json replaced by a test's.
  test("a write put off past a change of config folder still lands in the store's own", async () => {
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-writes-mine-"));
    const theirs = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-writes-theirs-"));
    process.env["RURI_CONFIG_DIR"] = mine;
    const briefs = new BriefStore();
    const ledger = new LedgerStore();
    briefs.write("p", { description: "Made here.", features: [] });
    ledger.record("p", { tokens: 10 });
    process.env["RURI_CONFIG_DIR"] = theirs;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    briefs.flush();
    ledger.flush();
    expect(fs.existsSync(path.join(mine, "briefs.json"))).toBe(true);
    expect(fs.existsSync(path.join(mine, "ledger.json"))).toBe(true);
    expect(fs.existsSync(path.join(theirs, "briefs.json"))).toBe(false);
    expect(fs.existsSync(path.join(theirs, "ledger.json"))).toBe(false);
    for (const dir of [mine, theirs]) fs.rmSync(dir, { recursive: true, force: true });
  });
});
