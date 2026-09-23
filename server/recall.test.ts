import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../shared/protocol.js";
import { exchangesOf, exchangeText, rankExchanges, terms } from "./recall.js";

let n = 0;
const user = (text: string): TranscriptEvent =>
  ({ kind: "user", id: `u${++n}`, text, ts: 1 }) as TranscriptEvent;
const reply = (text: string): TranscriptEvent =>
  ({ kind: "assistant", id: `a${++n}`, text, ts: 1 }) as TranscriptEvent;
const edit = (file: string): TranscriptEvent =>
  ({
    kind: "tool",
    id: `t${++n}`,
    name: "Edit",
    summary: file,
    diff: { path: file, added: 1, removed: 0, hunks: [] },
    ts: 1,
  }) as TranscriptEvent;

describe("recall", () => {
  test("words are stemmed and paths count whole and by their parts", () => {
    expect(terms("Rewinds the compacted server/compaction.ts")).toEqual(
      expect.arrayContaining(["rewind", "compact", "server/compaction.ts", "compaction"]),
    );
    expect(terms("the and for")).toEqual([]);
  });

  test("an exchange that shares the query's rarer words ranks first", () => {
    const events = [
      user("fix the peek band hover"),
      reply("Moved the hover onto the drag region."),
      edit("web/src/components/PeekBand.tsx"),
      user("the rewind gauge fails after compaction"),
      reply("Rewind snapshots now carry the context gauge."),
      edit("server/checkpoints.ts"),
      user("make the dragons chomp"),
      reply("Two-frame chomp, frozen off screen."),
    ];
    const exchanges = exchangesOf("chat-1", events, {});
    expect(exchanges.map((e) => e.n)).toEqual([1, 2, 3]);
    expect(exchanges[1]!.files).toEqual(["server/checkpoints.ts"]);
    const hits = rankExchanges(exchanges, "why does rewind lose the gauge");
    expect(hits[0]!.item.n).toBe(2);
    expect(hits.every((h) => h.item.n !== 3)).toBe(true);
    // one shared word is not a match when the query has more to say
    expect(rankExchanges(exchanges, "hover color theme palette")).toEqual([]);
  });

  test("an exchange prints whole: the user's words, the files, the tools, the reply", () => {
    const [ex] = exchangesOf("c", [user("do it"), edit("a.ts"), reply("done")], {});
    const text = exchangeText(ex!, "# c#1");
    expect(text).toContain("## The user\n\ndo it");
    expect(text).toContain("## Files it changed\n\n- a.ts");
    expect(text).toContain("## The agent\n\ndone");
  });
});
