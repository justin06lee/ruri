import { describe, expect, test } from "bun:test";
import type { QueuedPrompt, TranscriptEvent } from "../../../shared/protocol";
import {
  ASSUMED_MS,
  insertAt,
  predict,
  statusWithOutgoing,
  withOutgoing,
  withOutgoingItems,
  type Outgoing,
} from "./outgoing";

const user = (id: string, ts = 1): TranscriptEvent => ({ kind: "user", id, text: id, ts });
const result = (id: string, ts: number): TranscriptEvent =>
  ({ kind: "result", id, ok: true, ts }) as TranscriptEvent;

function out(
  clientId: string,
  shown: Outgoing["shown"],
  extra: Partial<Outgoing> = {},
  now?: true,
): Outgoing {
  return {
    message: { type: "send", projectId: "a", text: clientId, clientId, ...(now ? { now } : {}) },
    shown,
    ...(shown === "event" ? { event: user(clientId, 9) } : {}),
    ...(shown === "queued" ? { item: { id: clientId, text: clientId } } : {}),
    at: 1_000,
    onWire: 1_000,
    ...extra,
  };
}

describe("where a prompt will land", () => {
  test("an idle chat: out now", () => {
    expect(predict({ status: "idle", queued: [], held: undefined }, "go", false)).toBe("event");
  });

  test("a running turn: behind it, cutting in or not", () => {
    expect(predict({ status: "working", queued: [], held: undefined }, "next", false)).toBe("queued");
    expect(predict({ status: "permission", queued: [], held: undefined }, "next", true)).toBe("queued");
  });

  test("a queue still moving goes first; one standing by since a stop waits for this", () => {
    const queued: QueuedPrompt[] = [{ id: "q", text: "later" }];
    expect(predict({ status: "idle", queued, held: undefined }, "go", false)).toBe("queued");
    expect(predict({ status: "idle", queued, held: { by: "stop" } }, "go", false)).toBe("event");
  });

  test("the one being rewritten is not in line", () => {
    const queued: QueuedPrompt[] = [{ id: "q", text: "later", editing: true }];
    expect(predict({ status: "idle", queued, held: undefined }, "go", false)).toBe("event");
  });

  test("a command is the server's to place", () => {
    expect(predict({ status: "idle", queued: [], held: undefined }, "  /compact", false)).toBe("none");
  });
});

describe("laid over what the server sends", () => {
  test("a transcript sent whole keeps the bubble still on its way, at the end", () => {
    const sending = out("c1", "event");
    const events = [user("u1")];
    expect(withOutgoing("a", events, [sending])).toEqual([user("u1"), sending.event!]);
  });

  test("once the server has the event, it is the server's alone — the same list back", () => {
    const sending = out("c1", "event");
    const events = [user("u1"), user("c1", 2)];
    expect(withOutgoing("a", events, [sending])).toBe(events);
  });

  test("another chat's prompts are not this one's", () => {
    const events = [user("u1")];
    const elsewhere = out("c1", "event");
    elsewhere.message = { ...elsewhere.message, projectId: "b" };
    expect(withOutgoing("a", events, [elsewhere])).toBe(events);
  });

  test("a queue sent whole keeps the cards on their way: cut-ins first, the rest last", () => {
    const items: QueuedPrompt[] = [{ id: "q", text: "queued before" }];
    const cut = out("cut", "queued", {}, true);
    const later = out("later", "queued");
    expect(withOutgoingItems("a", items, [later, cut]).map((i) => i.id)).toEqual(["cut", "q", "later"]);
    expect(withOutgoingItems("a", [...items, { id: "later", text: "x" }], [later])).toHaveLength(2);
  });

  test("a status says working while a prompt to go now is on its way — for a while", () => {
    const sending = out("c1", "event");
    expect(statusWithOutgoing("a", "idle", [sending], 1_500)).toBe("working");
    expect(statusWithOutgoing("a", "idle", [sending], 1_000 + ASSUMED_MS)).toBe("idle");
    expect(statusWithOutgoing("a", "idle", [out("q", "queued")], 1_500)).toBe("idle");
    expect(statusWithOutgoing("a", "permission", [sending], 1_500)).toBe("permission");
    // still in the window, waiting for a socket: nothing is working on it
    expect(statusWithOutgoing("a", "idle", [out("held", "event", { onWire: undefined })], 1_500)).toBe(
      "idle",
    );
  });
});

describe("a chat held from before", () => {
  test("events missed while it was away go before the result that ended their turn", () => {
    const held = [user("u1", 10), result("r1", 50)];
    expect(insertAt(held, { kind: "assistant", id: "a1", text: "hi", ts: 20 } as TranscriptEvent)).toBe(1);
    expect(insertAt(held, user("u2", 60))).toBe(2);
    expect(insertAt(held, result("r2", 40))).toBe(2);
    expect(insertAt([], user("u1"))).toBe(0);
  });
});
