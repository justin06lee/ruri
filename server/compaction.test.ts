import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { BRIEF_RECENT, buildCompaction, relevantBlock } from "./compaction.js";
import { exchangesOf } from "./recall.js";

let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-compaction-"));
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

let n = 0;
const user = (text: string): TranscriptEvent =>
  ({ kind: "user", id: `u${++n}`, text, ts: n }) as TranscriptEvent;
const reply = (text: string): TranscriptEvent =>
  ({ kind: "assistant", id: `a${++n}`, text, ts: n }) as TranscriptEvent;
const edit = (file: string): TranscriptEvent =>
  ({
    kind: "tool",
    id: `t${++n}`,
    name: "Edit",
    summary: file,
    diff: { path: file, added: 1, removed: 0, hunks: [] },
    ts: n,
  }) as TranscriptEvent;

/** A conversation of `count` exchanges, the first about the peek band. */
function conversation(count: number): TranscriptEvent[] {
  const events: TranscriptEvent[] = [
    user("the peek band hover is blocked by the drag region, fix it"),
    reply("Moved the hover onto a drag-state switch instead of polling the cursor."),
    edit("web/src/components/PeekBand.tsx"),
  ];
  for (let i = 2; i <= count; i++) {
    events.push(
      user(`step ${i}: tidy the ledger totals`),
      reply(`ledger step ${i} done`),
      edit("server/ledger.ts"),
    );
  }
  return events;
}

describe("the compaction brief", () => {
  test("git's account first, notes for the older exchanges, the last ones at length", () => {
    const events = conversation(6);
    const last = events.findLast((e) => e.kind === "user")!;
    const summaries = {
      [last.id]: { user: "ledger step 6", reply: "done · next: 1. merge feat/ledger 2. cut a release" },
    };
    const built = buildCompaction("chat-1", events, summaries, undefined, {
      projectName: "web",
      git: ["Branch: on master (abc1234)", "Not merged into master: feat/ledger"],
      facts: (text) => (text.includes("feat/ledger") ? "[git: feat/ledger is not merged yet]" : ""),
    })!;
    const brief = built.brief;
    expect(brief.indexOf("<state>")).toBeLessThan(brief.indexOf("1. user:"));
    expect(brief).toContain("- Branch: on master (abc1234)");
    expect(brief).toContain(
      "- Files this conversation changed with its edit tools (shell edits don't show), those more exchanges worked on first: server/ledger.ts (in 5), src/components/PeekBand.tsx",
    );
    expect(brief).toContain(
      "- Your last reply offered to do next: 1. merge feat/ledger 2. cut a release [git: feat/ledger is not merged yet]",
    );
    // the older exchanges as notes, the last BRIEF_RECENT at length, verbatim
    expect(brief).toContain("1. user: the peek band hover is blocked");
    expect(brief).toContain(`${6 - BRIEF_RECENT}. user: step ${6 - BRIEF_RECENT}`);
    expect(brief).not.toContain("6. user: ledger step 6");
    expect(brief).toContain('<recent>\n4. user wrote:\n"""\nstep 4: tidy the ledger totals\n"""');
    expect(brief).toContain('6. user wrote:\n"""\nstep 6: tidy the ledger totals\n"""');
    expect(brief).toContain("   changed: server/ledger.ts");
    expect(brief).toContain("</recent>\n</compacted-history>");
    // every exchange still lands in the entries the transcript shows
    expect(built.entries.map((e) => e.n)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a short conversation is all at length, and needs no git to be briefed", () => {
    const brief = buildCompaction("chat-2", conversation(2), {})!.brief;
    expect(brief).not.toContain("1. user: the peek band");
    expect(brief).toContain("1. user wrote:");
    expect(brief).toContain("<state>\n- Files this conversation changed with its edit tools");
  });

  test("the next prompt brings the exchanges and memory lines it shares words with", () => {
    const events = conversation(8);
    buildCompaction("chat-3", events, {});
    const exchanges = exchangesOf("chat-3", events, {});
    const block = relevantBlock(
      "chat-3",
      exchanges,
      [
        { label: "didn't work", text: "Polling the cursor for the peek band hover — cost battery" },
        { label: "decision", text: "Ledger totals are per local day" },
      ],
      "the peek band hover broke again after the drag change",
    );
    expect(block).toStartWith("<relevant>");
    expect(block).toContain(
      '1. user wrote:\n"""\nthe peek band hover is blocked by the drag region, fix it\n"""',
    );
    expect(block).toContain("changed: web/src/components/PeekBand.tsx");
    expect(block).toContain(path.join("turns", "chat-3", "001.md"));
    expect(block).toContain("- didn't work: Polling the cursor for the peek band hover — cost battery");
    expect(block).not.toContain("Ledger totals");
    // nothing shares enough: nothing added
    expect(relevantBlock("chat-3", exchanges, [], "write a haiku about autumn")).toBe("");
    // what the brief already gives at length isn't given twice
    expect(relevantBlock("chat-3", exchanges, [], "step 8 ledger totals tidy")).not.toContain(
      "8. user wrote",
    );
  });
});
