import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LedgerStore } from "./ledger.js";
import { transcriptCosts, transcriptFolder } from "./ledgerRebuild.js";

let root: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-rebuild-"));
  process.env["RURI_CONFIG_DIR"] = path.join(root, "config");
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime();
/** One call's transcript line: Opus 5.5, $0.20 per thousand output tokens. */
const call = (id: string, ts: number, output: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: new Date(ts).toISOString(),
    message: { id, model: "claude-opus-5-5", usage: { output_tokens: output } },
  });

function write(file: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join("\n") + "\n");
}

describe("transcriptCosts", () => {
  test("prices each call once, by project and local day, only ruri's chats and only before the cut", async () => {
    const transcripts = path.join(root, "claude");
    const archive = path.join(root, "sessions");
    const mira = { id: "p-mira", path: "/w/mira", sessions: [{ id: "chat-lead" }, { id: "chat-mate" }] };
    write(path.join(archive, "chat-lead.json"), [JSON.stringify({ sessionIds: ["s1"], lastSessionId: "s2" })]);
    write(path.join(archive, "chat-mate.json"), [JSON.stringify({ sessionIds: ["s3"] })]);
    // a chat no project lists any more: placed by the folder its transcript is in
    write(path.join(archive, "chat-gone.json"), [JSON.stringify({ sessionIds: ["s4"] })]);
    const folder = path.join(transcripts, transcriptFolder("/w/mira"));
    write(path.join(folder, "s1.jsonl"), [
      JSON.stringify({ type: "user", message: { content: "hi" } }),
      call("m1", at(20), 10_000), // $0.20
      call("m1", at(20), 10_000), // the same call's second content block
      call("m2", at(21), 5_000), // $0.10, the next day
    ]);
    write(path.join(folder, "s2.jsonl"), [call("m3", at(21), 5_000)]);
    write(path.join(folder, "s2", "subagents", "agent-1.jsonl"), [call("m4", at(21), 5_000)]);
    write(path.join(folder, "s3.jsonl"), [call("m5", at(22, 9), 5_000), call("m6", at(22, 15), 50_000)]);
    write(path.join(folder, "s4.jsonl"), [call("m7", at(20), 5_000)]);
    write(path.join(folder, "not-ruri.jsonl"), [call("m8", at(20), 50_000)]);
    const costs = await transcriptCosts({ transcripts, archive, projects: [mira], before: at(22, 12) });
    const days = costs.get("p-mira")!;
    expect(days.get("2026-10-20")).toBeCloseTo(0.3, 6); // m1 once, m7 by folder
    expect(days.get("2026-10-21")).toBeCloseTo(0.3, 6); // m2, m3, the subagent's m4
    expect(days.get("2026-10-22")).toBeCloseTo(0.1, 6); // m5; m6 is after the cut
    expect(costs.size).toBe(1);
  });
});

describe("LedgerStore.rebuildCosts", () => {
  test("days take their transcripts' dollars, keep what this launch recorded, and estimate the rest", () => {
    const config = process.env["RURI_CONFIG_DIR"]!;
    fs.mkdirSync(config, { recursive: true });
    // what the old code left: running totals added up
    fs.writeFileSync(
      path.join(config, "ledger.json"),
      JSON.stringify({
        p: {
          "2026-10-01": { tokens: 1000, costUsd: 90, turns: 3, ms: 1 }, // no transcript left
          "2026-10-20": { tokens: 2000, costUsd: 80, turns: 4, ms: 1 },
          "2026-10-21": { tokens: 3000, costUsd: 70, turns: 5, ms: 1 },
        },
      }),
    );
    const ledger = new LedgerStore();
    ledger.record("p", { tokens: 500, costUsd: 0.5 }, at(21, 18)); // after the launch: already right
    const rebuilt = new Map([["p", new Map([["2026-10-20", 2], ["2026-10-21", 3]])]]);
    ledger.rebuildCosts(rebuilt);
    const day = (d: string) => {
      const stats = ledger.stats("p", new Date(`${d}T12:00:00`).getTime());
      return stats.today;
    };
    expect(day("2026-10-20").costUsd).toBeCloseTo(2, 6);
    expect(day("2026-10-21")).toEqual({ tokens: 3500, costUsd: 3.5, turns: 6, ms: 1 });
    // $5 for 5000 tokens on the days that have transcripts: $0.001 a token
    expect(day("2026-10-01").costUsd).toBeCloseTo(1, 6);
    expect(day("2026-10-01").tokens).toBe(1000);
  });
});
