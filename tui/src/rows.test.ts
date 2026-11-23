import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../../shared/protocol";
import { compact, eventLines, fit, pad, span, transcriptLines } from "./rows";
import { said, user } from "./test/fixtures";

const tool = (
  id: string,
  over: Partial<Extract<TranscriptEvent, { kind: "tool" }>> = {},
): TranscriptEvent => ({
  kind: "tool",
  id,
  name: "Bash",
  summary: "ls -la",
  ts: 3,
  ...over,
});

describe("a chat as lines", () => {
  test("a prompt, a reply and a turn's end", () => {
    const lines = transcriptLines(
      [
        user("u1", "hello"),
        said("a1", "hi **there**"),
        {
          kind: "result",
          id: "r1",
          ok: true,
          durationMs: 6200,
          tokens: 65_400,
          costUsd: 0.012,
          models: ["claude-haiku-5-5"],
          ts: 4,
        },
      ],
      60,
      new Set(),
    );
    expect(lines.map((l) => l.text)).toEqual([
      "❯ hello",
      "",
      "hi there",
      "",
      "── 6s · 65k tokens · $0.01 · Haiku 5.5 ──",
    ]);
    expect(lines.map((l) => l.eventId)).toEqual(["u1", undefined, "a1", undefined, "r1"]);
  });

  test("tool steps stand together, one line each until opened", () => {
    const long = tool("t2", { name: "Read", summary: `a/very/long/path/${"x".repeat(80)}` });
    const folded = transcriptLines([tool("t1"), long], 40, new Set());
    expect(folded.map((l) => l.text)).toEqual([
      "  ⏺ Bash ls -la",
      expect.stringMatching(/^ {2}⏺ Read a\/very.*…$/),
    ]);
    const open = transcriptLines([tool("t1"), long], 40, new Set(["t2"]));
    expect(open.length).toBeGreaterThan(2);
    expect(
      open
        .slice(1)
        .map((l) => l.text)
        .join(""),
    ).toContain("x".repeat(30));
  });

  test("a patch says what it changed, and shows it when opened", () => {
    const event = tool("t1", {
      name: "Edit",
      summary: "src/a.ts",
      diff: {
        path: "src/a.ts",
        added: 1,
        removed: 1,
        hunks: [
          {
            oldStart: 3,
            newStart: 3,
            lines: [
              { kind: "ctx", text: "a" },
              { kind: "del", text: "old" },
              { kind: "add", text: "new" },
            ],
          },
        ],
      },
    });
    expect(eventLines(event, 60, false)).toEqual(["  ✎ Edit src/a.ts +1 -1"]);
    expect(eventLines(event, 60, true)).toEqual([
      "  ✎ Edit src/a.ts +1 -1",
      "    @@ -3 +3 @@",
      "      a",
      "    - old",
      "    + new",
    ]);
  });

  test("an agent's card is its line", () => {
    const event = tool("t1", {
      name: "Agent",
      agent: {
        key: "k",
        description: "look into it",
        status: "running",
        tools: 3,
        tokens: 1200,
        startedAt: 1,
        activity: "reading files",
      },
    });
    expect(eventLines(event, 80, false)).toEqual([
      "  ◈ agent: look into it · working · 3 tools · 1.2k tokens",
    ]);
    expect(eventLines(event, 80, true)[1]).toBe("    reading files");
  });

  test("how a turn ended: stopped, failed, out of usage", () => {
    expect(eventLines({ kind: "result", id: "r", ok: false, stopped: true, ts: 1 }, 40, false)).toEqual([
      "■ stopped",
    ]);
    expect(eventLines({ kind: "result", id: "r", ok: false, error: "boom", ts: 1 }, 40, false)).toEqual([
      "✗ boom",
    ]);
    expect(eventLines({ kind: "result", id: "r", ok: false, blocked: "limit", ts: 1 }, 40, false)).toEqual([
      "✗ out of usage",
    ]);
  });

  test("the reply being written follows, with its cursor, until its message lands", () => {
    const writing = transcriptLines([user("u1", "hi")], 40, new Set(), { messageId: "a1", text: "so far" });
    expect(writing.at(-1)).toEqual({ text: "so far▍", eventId: "a1" });
    const landed = transcriptLines([user("u1", "hi"), said("a1", "so far")], 40, new Set(), {
      messageId: "a1",
      text: "so far",
    });
    expect(landed.map((l) => l.text)).toEqual(["❯ hi", "", "so far"]);
  });

  test("a compaction is a rule until it is opened", () => {
    const event: TranscriptEvent = { kind: "compaction", id: "c", text: "what came before", ts: 0 };
    expect(eventLines(event, 60, false)).toHaveLength(1);
    expect(eventLines(event, 60, true)[1]).toBe("  what came before");
  });

  test("a plan lists its steps", () => {
    const event: TranscriptEvent = {
      kind: "plan",
      id: "p",
      entries: [
        { content: "first", status: "completed" },
        { content: "second", status: "in_progress" },
        { content: "third", status: "pending" },
      ],
      ts: 0,
    };
    expect(eventLines(event, 40, false)).toEqual(["Plan", "  ☑ first", "  ◐ second", "  ☐ third"]);
  });

  test("numbers and times as a person says them", () => {
    expect([compact(999), compact(1234), compact(65_400), compact(2_500_000)]).toEqual([
      "999",
      "1.2k",
      "65k",
      "2.5M",
    ]);
    expect([span(8000), span(185_000), span(4_320_000)]).toEqual(["8s", "3m 05s", "1h 12m"]);
  });

  test("fit cuts with an ellipsis, pad fills, and a wide character is two columns", () => {
    expect(fit("abcdef", 4)).toBe("abc…");
    expect(fit("한국어입니다", 7)).toBe("한국어…");
    expect(pad("ab", 4)).toBe("ab  ");
    expect(pad("한", 4)).toBe("한  ");
    expect(fit("two\nlines", 20)).toBe("two lines");
  });
});
