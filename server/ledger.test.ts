import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LedgerStore } from "./ledger.js";

let dir: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ledger-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

/** A local-time instant: buckets are drawn where a person would draw them. */
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 2, day, hour, minute).getTime();
const ZERO = { tokens: 0, costUsd: 0, turns: 0, ms: 0 };

describe("bucketing", () => {
  test("a turn lands in its project's day, counting as one turn unless told otherwise", () => {
    const ledger = new LedgerStore();
    ledger.record("p", { tokens: 10, costUsd: 0.5, ms: 100 }, at(10));
    expect(ledger.stats("p", at(10)).today).toEqual({ tokens: 10, costUsd: 0.5, turns: 1, ms: 100 });
    ledger.record("p", { tokens: 5, turns: 3 }, at(10));
    expect(ledger.stats("p", at(10)).today).toEqual({ tokens: 15, costUsd: 0.5, turns: 4, ms: 100 });
  });

  test("today, this week, and all time are three different sums", () => {
    const ledger = new LedgerStore();
    ledger.record("p", { tokens: 1 }, at(10)); // today
    ledger.record("p", { tokens: 10 }, at(4)); // six days ago: in the week
    ledger.record("p", { tokens: 100 }, at(3)); // seven days ago: out of it
    const stats = ledger.stats("p", at(10, 23, 59));
    expect(stats.today.tokens).toBe(1);
    expect(stats.week.tokens).toBe(11);
    expect(stats.total.tokens).toBe(111);
  });

  test("the day turns at local midnight", () => {
    const ledger = new LedgerStore();
    ledger.record("p", { tokens: 1 }, at(9, 23, 59));
    ledger.record("p", { tokens: 2 }, at(10, 0, 1));
    expect(ledger.stats("p", at(10)).today.tokens).toBe(2);
    expect(ledger.stats("p", at(9)).today.tokens).toBe(1);
  });

  test("projects do not share buckets", () => {
    const ledger = new LedgerStore();
    ledger.record("a", { tokens: 1 }, at(10));
    ledger.record("b", { tokens: 2 }, at(10));
    expect(ledger.stats("a", at(10)).total.tokens).toBe(1);
    expect(ledger.stats("b", at(10)).total.tokens).toBe(2);
    expect(ledger.all(["a", "b", "c"])).toEqual({
      a: { total: { ...ZERO, tokens: 1, turns: 1 }, today: expect.anything(), week: expect.anything() },
      b: { total: { ...ZERO, tokens: 2, turns: 1 }, today: expect.anything(), week: expect.anything() },
      c: { total: ZERO, today: ZERO, week: ZERO },
    });
  });

  test("a project nobody has spent on is all zeros", () => {
    expect(new LedgerStore().stats("nobody")).toEqual({ total: ZERO, today: ZERO, week: ZERO });
  });

  test("removing a project forgets its days", () => {
    const ledger = new LedgerStore();
    ledger.record("p", { tokens: 1 }, at(10));
    ledger.removeProject("p");
    expect(ledger.stats("p", at(10)).total).toEqual(ZERO);
    ledger.flush();
  });
});

describe("on disk", () => {
  test("flush writes the file at once, and a fresh store reads it back", () => {
    const ledger = new LedgerStore();
    ledger.record("p", { tokens: 7, costUsd: 0.25 }, at(10));
    ledger.record("p", { tokens: 1 }, at(3));
    ledger.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "ledger.json"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(Object.keys(raw["p"]!)).toEqual(["2026-03-10", "2026-03-03"]);
    const again = new LedgerStore();
    expect(again.stats("p", at(10))).toEqual(ledger.stats("p", at(10)));
  });

  test("a flush with nothing pending writes nothing", () => {
    new LedgerStore().flush();
    expect(fs.existsSync(path.join(dir, "ledger.json"))).toBe(false);
  });

  test("a half-written file on disk is an empty ledger, not a crash", () => {
    fs.writeFileSync(path.join(dir, "ledger.json"), '{"p": {"2026-03-10": {"tokens": 3}}, "q": null');
    expect(new LedgerStore().stats("p").total).toEqual(ZERO);
  });

  test("partial totals on disk are filled out with zeros", () => {
    fs.writeFileSync(
      path.join(dir, "ledger.json"),
      JSON.stringify({ p: { "2026-03-10": { tokens: 3 } }, q: null }),
    );
    expect(new LedgerStore().stats("p", at(10)).total).toEqual({ ...ZERO, tokens: 3 });
  });
});
