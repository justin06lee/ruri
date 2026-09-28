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
    expect(brief.indexOf("<state>")).toBeLessThan(brief.indexOf("1. user wrote:"));
    expect(brief).toContain("- Branch: on master (abc1234)");
    expect(brief).toContain(
      "- Files this conversation changed, those more exchanges worked on first: server/ledger.ts (in 5), src/components/PeekBand.tsx",
    );
    expect(brief).toContain(
      "- Your last reply offered to do next: 1. merge feat/ledger 2. cut a release [git: feat/ledger is not merged yet]",
    );
    // every prompt in the user's own words; the older replies as notes, the
    // last BRIEF_RECENT at length
    expect(brief).toContain(
      '1. user wrote:\n"""\nthe peek band hover is blocked by the drag region, fix it\n"""\n   you: Moved the hover',
    );
    expect(brief).toContain(
      `${6 - BRIEF_RECENT}. user wrote:\n"""\nstep ${6 - BRIEF_RECENT}: tidy the ledger totals\n"""`,
    );
    expect(brief).not.toContain("ledger step 6\n");
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
    expect(brief).toContain("<state>\n- Files this conversation changed, those more");
  });

  test("a prompt pasted long is cut in its middle, and nothing else is", () => {
    const long = `${"a".repeat(2000)} MIDDLE ${"z".repeat(2000)}`;
    const events = [user(long), reply("read it"), ...conversation(4)];
    const brief = buildCompaction("chat-long", events, {})!.brief;
    expect(brief).toContain(`1. user wrote:\n"""\n${"a".repeat(1000)}`);
    expect(brief).toContain("[…]");
    expect(brief).not.toContain("MIDDLE");
    expect(brief).toContain(
      '2. user wrote:\n"""\nthe peek band hover is blocked by the drag region, fix it\n"""',
    );
  });

  test("what a turn's checkpoints say it changed counts, shell edits included, and names its layers", () => {
    const events = conversation(2);
    const first = events.find((e) => e.kind === "user")!;
    let asked: string[] = [];
    const brief = buildCompaction(
      "chat-4",
      events,
      { [first.id]: { files: ["web/src/components/PeekBand.tsx", "web/src/styles.css"] } },
      undefined,
      {
        layers: (files) => {
          asked = files;
          return "This conversation worked in these layers of the stack: appearance (2 files).";
        },
      },
    )!.brief;
    expect(brief).toContain("web/src/styles.css");
    expect(asked).toContain("web/src/styles.css");
    expect(brief).toContain(
      "<layers>\nThis conversation worked in these layers of the stack: appearance (2 files).\n</layers>",
    );
    expect(brief.indexOf("</state>")).toBeLessThan(brief.indexOf("<layers>\n"));
    // nothing to say, no block
    expect(buildCompaction("chat-5", events, {}, undefined, { layers: () => "" })!.brief).not.toContain(
      "<layers>",
    );
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
