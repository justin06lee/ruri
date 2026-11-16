import { describe, expect, test } from "bun:test";
import type { ProjectStatus, ServerMessage } from "../../shared/protocol.js";
import type { ClientConn, ServerContext } from "../context.js";
import { SendQueues, type QueueEntry } from "../queue.js";
import { promptHandlers } from "./prompts.js";

const CHAT = "chat";

const entry = (id: string, extra: Partial<QueueEntry> = {}): QueueEntry => ({
  id,
  text: `prompt ${id}`,
  uploads: [],
  silent: false,
  ...extra,
});

/** A server with one chat in it: its queue real, the rest only what a
 *  queued prompt sent now touches. */
function world(status: ProjectStatus, queue: QueueEntry[], held = false) {
  const sent: ServerMessage[] = [];
  const interrupted: string[] = [];
  const queues = new SendQueues((message) => sent.push(message));
  queues.entries.set(CHAT, queue);
  if (held) queues.held.set(CHAT, { by: "stop" });
  const ctx = {
    queues,
    retries: { cancelRetry: () => {} },
    manager: {
      statuses: () => ({ [CHAT]: status }),
      interrupt: (id: string) => interrupted.push(id),
    },
    clients: { broadcast: (message: ServerMessage) => sent.push(message) },
    // the user's own chat: a lead, never on another agent's job
    store: { isMember: () => false, findSession: () => undefined },
  } as unknown as ServerContext;
  const now = (itemId: string) =>
    promptHandlers.queue_now(ctx, {} as ClientConn, { type: "queue_now", projectId: CHAT, itemId });
  const line = () => (queues.entries.get(CHAT) ?? []).map((e) => e.id);
  return { queues, interrupted, now, line };
}

describe("a queued prompt sent now", () => {
  test("stops the running turn and stands at the head of the line, the rest behind it as they were", () => {
    const w = world("working", [entry("1"), entry("2"), entry("3")]);
    w.now("3");
    expect(w.interrupted).toEqual([CHAT]);
    expect(w.line()).toEqual(["3", "1", "2"]);
    expect(w.queues.entries.get(CHAT)![0]!.cut).toBe(true);
    // the stopped turn's end is what sends it: the queue is held meanwhile,
    // and marked as cut into, so it moves the moment the turn is over
    expect(w.queues.held.has(CHAT)).toBe(true);
    expect(w.queues.cutIn.has(CHAT)).toBe(true);
  });

  test("goes behind one that cut in before it, and ahead of everything else", () => {
    const w = world("working", [entry("cut", { cut: true }), entry("1"), entry("2")]);
    w.now("2");
    expect(w.line()).toEqual(["cut", "2", "1"]);
  });

  test("with nothing running, leads a queue that was standing by out", () => {
    const w = world("idle", [entry("1"), entry("2"), entry("3")], true);
    w.now("2");
    expect(w.interrupted).toEqual([]);
    // released, and the one held down already on its way; the others wait
    // behind it in the order they stood. (The send itself is a microtask
    // later, into a server that isn't here: its one warning is expected.)
    expect(w.queues.held.has(CHAT)).toBe(false);
    expect(w.line()).toEqual(["1", "3"]);
  });

  test("one being rewritten, being cut into tasks, or not there is left alone", () => {
    const w = world("working", [entry("e", { editing: true }), entry("s", { splitting: true }), entry("1")]);
    w.now("e");
    w.now("s");
    w.now("gone");
    expect(w.interrupted).toEqual([]);
    expect(w.line()).toEqual(["e", "s", "1"]);
  });
});
