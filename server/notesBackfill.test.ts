import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Yagami } from "@justin06lee/yagami";
import type { TranscriptEvent } from "../shared/protocol.js";
import type { ServerContext } from "./context.js";
import { backfillNotes, NoteBackfill } from "./notes.js";
import { setCompletionClient } from "./smallmodel.js";

// a turn found without its note is sent to be noted: never to a real
// model, and nothing of it lands in the real config
const saved = process.env["RURI_CONFIG_DIR"];
beforeAll(() => {
  process.env["RURI_CONFIG_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-notes-"));
  setCompletionClient({
    messages: { create: async () => ({ content: [{ type: "text", text: "a note" }] }) },
  } as unknown as Yagami);
});
afterAll(() => {
  setCompletionClient(null);
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

/** A chat whose every turn is long finished and noted. */
function chat(): { ctx: ServerContext; reads: () => number; add: (event: TranscriptEvent) => void } {
  const old = Date.now() - 60 * 60_000;
  const events: TranscriptEvent[] = [
    { kind: "user", id: "u1", text: "fix it", ts: old },
    { kind: "assistant", id: "a1", text: "fixed", ts: old + 1 },
    { kind: "result", id: "r1", ok: true, ts: old + 2 },
  ];
  const summaries: Record<string, { user?: string; reply?: string }> = { u1: { user: "fix", reply: "done" } };
  let reads = 0;
  const ctx = {
    notes: new NoteBackfill(),
    store: { sessionIds: () => ["c1"] },
    clients: { broadcast: () => {} },
    archive: {
      events: () => events,
      summaries: () => summaries,
      setSummary: () => {},
      earlier: () => [],
      allEvents: () => {
        reads += 1;
        return events;
      },
    },
  } as unknown as ServerContext;
  return { ctx, reads: () => reads, add: (event) => events.push(event) };
}

describe("the notes' hourly pass", () => {
  test("reads a chat it found whole again only once the chat has moved on", () => {
    const { ctx, reads, add } = chat();
    backfillNotes(ctx, ["c1"]);
    expect(reads()).toBe(1);
    backfillNotes(ctx, ["c1"]);
    backfillNotes(ctx, ["c1"]);
    expect(reads()).toBe(1);
    add({ kind: "user", id: "u2", text: "and this", ts: Date.now() - 60 * 60_000 });
    backfillNotes(ctx, ["c1"]);
    expect(reads()).toBe(2);
  });

  test("a chat whose newest turn is still young is looked at again", () => {
    const { ctx, reads, add } = chat();
    add({ kind: "user", id: "u2", text: "just now", ts: Date.now() });
    backfillNotes(ctx, ["c1"]);
    backfillNotes(ctx, ["c1"]);
    expect(reads()).toBe(2);
  });
});
