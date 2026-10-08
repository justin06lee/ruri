import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { BRIEF_RECENT, buildAfterCompaction, buildCompaction, relevantBlock } from "./compaction.js";
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
      "- Files this conversation changed, those more exchanges worked on first (by the exchanges that changed them, and as they stand now): server/ledger.ts [2, 3 … 6]; src/components/PeekBand.tsx [1]",
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

  test("what the pick found goes in at length: this chat's by its record, another's by its ref", () => {
    const events = conversation(8);
    buildCompaction("chat-3", events, {});
    const exchanges = exchangesOf("chat-3", events, {});
    const other = { ...exchanges[2]!, chat: "0ther123-chat", n: 14, title: "Peek band" };
    const block = relevantBlock("chat-3", {
      exchanges: [exchanges[0]!, other],
      lines: [{ label: "didn't work", text: "Polling the cursor for the peek band hover — cost battery" }],
    });
    expect(block).toStartWith("<relevant>");
    expect(block).toContain(
      '1. user wrote:\n"""\nthe peek band hover is blocked by the drag region, fix it\n"""',
    );
    expect(block).toContain("changed: web/src/components/PeekBand.tsx");
    expect(block).toContain(path.join("turns", "chat-3", "001.md"));
    expect(block).toContain('0ther123#14 (in the "Peek band" chat). The user wrote:');
    expect(block).toContain("full: `ruri recall show 0ther123#14`");
    // another chat's first, then this chat's in order
    expect(block.indexOf("0ther123#14")).toBeLessThan(block.indexOf("1. user wrote"));
    expect(block).toContain("- didn't work: Polling the cursor for the peek band hover — cost battery");
    // nothing found, nothing added
    expect(relevantBlock("chat-3", { exchanges: [], lines: [] })).toBe("");
  });
});

describe("a brief within its budget", () => {
  test("each file it changed says how it stands now", () => {
    const events = conversation(4);
    const brief = buildCompaction("chat-7", events, {}, undefined, {
      projectName: "web",
      standing: (files) =>
        new Map(
          files.flatMap((f): Array<[string, string]> =>
            f === "server/ledger.ts" ? [[f, "uncommitted"]] : [],
          ),
        ),
    })!.brief;
    expect(brief).toContain("server/ledger.ts [2, 3, 4] uncommitted; src/components/PeekBand.tsx [1]");
  });

  test("the state and the last exchanges always go; the oldest listed ones give way, named by their records", () => {
    const events = conversation(60);
    const whole = buildCompaction("chat-8", events, {})!.brief;
    const tight = buildCompaction("chat-8", events, {}, undefined, { budget: 1200 })!.brief;
    expect(tight.length).toBeLessThan(whole.length);
    expect(tight.length).toBeLessThanOrEqual(1200 * 4 + 200);
    expect(tight).toContain("<recent>");
    expect(tight).toContain("60. user wrote:");
    expect(tight).toMatch(
      /Exchanges 1–\d+ aren't listed here, for room; their full records are files 001\.md to/,
    );
    // the newest listed ones are the ones kept
    expect(tight).toContain("57. user wrote:");
    expect(tight).not.toContain("\n1. user wrote:");
  });
});

describe("after Claude compacted itself", () => {
  test("the state, the layers and the last prompts word for word, the one in flight first", () => {
    const events = conversation(8);
    const text = buildAfterCompaction(
      "chat-9",
      events,
      {},
      {
        git: ["Branch: on master (abc1234)"],
        layers: () => "This conversation worked in these layers of the stack: ledger (1 file).",
      },
    );
    expect(text).toStartWith("<ruri:after-compaction>");
    expect(text).toContain("- Branch: on master (abc1234)");
    expect(text).toContain("<layers>\nThis conversation worked in these layers");
    expect(text).toContain(
      '8. user wrote (the prompt you are working on now):\n"""\nstep 8: tidy the ledger totals\n"""',
    );
    expect(text.indexOf("8. user wrote")).toBeLessThan(text.indexOf("7. user wrote"));
    expect(text).not.toContain("2. user wrote");
    expect(text).toContain(path.join("turns", "chat-9"));
  });
});
