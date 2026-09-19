import { describe, expect, test } from "bun:test";
import { Clients } from "./clients.js";
import type { TranscriptEvent } from "../shared/protocol.js";

function event(id: string, text = id): TranscriptEvent {
  return { kind: "assistant", id, text, ts: 0 };
}

/** A chat with `count` events pushed on it, and the clients that pushed. */
function chatting(count: number, channelId = "c") {
  const clients = new Clients();
  for (let i = 0; i < count; i++) clients.pushEvent(channelId, event(`e${i}`));
  return clients;
}

const ids = (events: TranscriptEvent[] | undefined) => events?.map((e) => e.id);

describe("catching a window up on a chat it looked away from", () => {
  test("a chat that has not moved needs nothing", () => {
    const clients = chatting(3);
    expect(clients.since("c", clients.mark("c"))).toEqual([]);
  });

  test("a chat a few events on sends those events", () => {
    const clients = chatting(3);
    const away = clients.mark("c");
    clients.pushEvent("c", event("e3"));
    clients.pushEvent("c", event("e4"));
    expect(ids(clients.since("c", away))).toEqual(["e3", "e4"]);
  });

  test("a window that never saw the chat at all is caught up from the start", () => {
    const clients = chatting(3);
    expect(ids(clients.since("c", { epoch: 0, revision: 0 }))).toEqual(["e0", "e1", "e2"]);
  });

  test("an event pushed again is replayed as it was pushed", () => {
    const clients = chatting(2);
    const away = clients.mark("c");
    // a tool call settling, an agent card finishing: the same id, new text
    clients.pushEvent("c", event("e1", "settled"));
    const missed = clients.since("c", away);
    expect(ids(missed)).toEqual(["e1"]);
    expect((missed![0] as { text: string }).text).toBe("settled");
  });

  test("a chat rewritten rather than added to wants sending whole", () => {
    const clients = chatting(3);
    const away = clients.mark("c");
    clients.rewrote("c"); // a compaction, a rewind
    expect(clients.since("c", away)).toBeUndefined();
  });

  test("a window from before a rewrite is not resumed even if it has caught the count up", () => {
    const clients = chatting(3);
    const away = clients.mark("c");
    clients.rewrote("c");
    for (let i = 0; i < 10; i++) clients.pushEvent("c", event(`f${i}`));
    expect(clients.since("c", away)).toBeUndefined();
  });

  test("a window too far behind wants sending whole", () => {
    const clients = chatting(1);
    const away = clients.mark("c");
    for (let i = 0; i < 400; i++) clients.pushEvent("c", event(`f${i}`));
    expect(clients.since("c", away)).toBeUndefined();
  });

  test("a window at the oldest event still held is resumed", () => {
    const clients = new Clients();
    for (let i = 0; i < 250; i++) clients.pushEvent("c", event(`e${i}`));
    // the log holds 200; the window that left just as the 50th arrived is
    // the oldest one that can still be walked forward
    const missed = clients.since("c", { epoch: 0, revision: 50 });
    expect(missed).toHaveLength(200);
    expect(missed![0]!.id).toBe("e50");
    expect(missed!.at(-1)!.id).toBe("e249");
    expect(clients.since("c", { epoch: 0, revision: 49 })).toBeUndefined();
  });

  test("a window claiming to be ahead of the chat wants sending whole", () => {
    const clients = chatting(2);
    expect(clients.since("c", { epoch: 0, revision: 99 })).toBeUndefined();
  });

  test("chats are caught up apart from one another", () => {
    const clients = chatting(2, "a");
    clients.pushEvent("b", event("b0"));
    const away = clients.mark("a");
    clients.pushEvent("b", event("b1"));
    expect(clients.since("a", away)).toEqual([]);
    expect(ids(clients.since("b", { epoch: 0, revision: 0 }))).toEqual(["b0", "b1"]);
  });

  test("a turn taken out is not replayed back into the window", () => {
    const clients = chatting(4);
    const away = clients.mark("c");
    clients.pushEvent("c", event("e4"));
    clients.pushEvent("c", event("e5"));
    clients.forgetEvents("c", ["e4"]);
    expect(ids(clients.since("c", away))).toEqual(["e5"]);
  });

  test("a chat forgotten leaves nothing to catch up on", () => {
    const clients = chatting(3);
    clients.forgetChannel("c");
    // the marks a window holds are gone with it, and a fresh mark on a
    // chat nothing is known about resumes from nowhere
    expect(clients.since("c", { epoch: 0, revision: 2 })).toBeUndefined();
    expect(clients.since("c", { epoch: 0, revision: 0 })).toEqual([]);
  });
});
