import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../shared/protocol.js";

type ToolEvent = Extract<TranscriptEvent, { kind: "tool" }>;
import { AgentBook } from "./sessions.js";

function opened(): { book: AgentBook; sent: TranscriptEvent[] } {
  const sent: TranscriptEvent[] = [];
  const events = {
    onEvent: (_: string, event: TranscriptEvent) => sent.push(event),
    onEventUpdate: (_: string, event: TranscriptEvent) => sent.push(event),
  };
  return { book: new AgentBook("p", events as never), sent };
}

const card = (): ToolEvent => ({
  kind: "tool",
  id: "t1",
  name: "Agent",
  summary: "audit",
  agent: { key: "k1", type: "Explore", description: "audit", status: "running", startedAt: 1 },
  ts: 1,
});

const activity = (e: TranscriptEvent | undefined) => (e?.kind === "tool" ? e.agent?.activity : undefined);

describe("a running agent's card", () => {
  test("goes out at most twice a second, the newest each time", async () => {
    const { book, sent } = opened();
    book.start(card());
    for (let i = 0; i < 20; i++) book.update("k1", { activity: `Read file${i}.ts` });
    // the card, the first progress at once, and the rest waiting their turn
    expect(sent).toHaveLength(2);
    expect(activity(sent[1])).toBe("Read file0.ts");
    await new Promise((r) => setTimeout(r, 600));
    expect(sent).toHaveLength(3);
    expect(activity(sent[2])).toBe("Read file19.ts");
  });

  test("an agent that ends says so at once, with what it was last doing", () => {
    const { book, sent } = opened();
    book.start(card());
    book.update("k1", { activity: "Read a.ts" });
    book.update("k1", { activity: "Read b.ts" });
    book.update("k1", { status: "done" });
    const last = sent.at(-1);
    expect(last?.kind === "tool" && last.agent?.status).toBe("done");
    expect(activity(last)).toBe("Read b.ts");
  });
});
