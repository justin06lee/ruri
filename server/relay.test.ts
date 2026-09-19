import { describe, expect, test } from "bun:test";
import type { ClientConn } from "./context.js";
import { TerminalRelay } from "./relay.js";

/** A window, as much of one as the relay looks at. */
class FakeSocket {
  readyState = 1; // WebSocket.OPEN
  bufferedAmount = 0;
  readonly sent: string[] = [];
  terminated = false;
  send(payload: string): void {
    this.sent.push(payload);
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3; // CLOSED
  }
  /** The terminal text it has been given, in order. */
  text(): string {
    return this.sent
      .map((payload) => JSON.parse(payload) as { type: string; data?: string })
      .filter((message) => message.type === "terminal_data")
      .map((message) => message.data ?? "")
      .join("");
  }
  as(): ClientConn {
    return this as unknown as ClientConn;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The relay, its sockets, and every hold it asked for. */
function setup() {
  const sockets = new Set<ClientConn>();
  const holds: Array<[string, boolean]> = [];
  const relay = new TerminalRelay(sockets, (termId, held) => holds.push([termId, held]));
  const add = () => {
    const socket = new FakeSocket();
    sockets.add(socket.as());
    return socket;
  };
  return { relay, sockets, holds, add };
}

describe("TerminalRelay", () => {
  test("a window with room takes its output straight away", () => {
    const { relay, add } = setup();
    const window = add();
    relay.data("p", "p#1", "hello");
    expect(window.text()).toBe("hello");
    expect(JSON.parse(window.sent[0]!)).toEqual({
      type: "terminal_data",
      projectId: "p",
      termId: "p#1",
      data: "hello",
    });
    relay.stop();
  });

  test("a closed window is not written to", () => {
    const { relay, add } = setup();
    const window = add();
    window.readyState = 3;
    relay.data("p", "p#1", "hello");
    expect(window.sent).toHaveLength(0);
    relay.stop();
  });

  test("a window that is behind has its output held, joined, and sent when it drains", async () => {
    const { relay, add } = setup();
    const window = add();
    window.bufferedAmount = 1024 * 1024;
    relay.data("p", "p#1", "one ");
    relay.data("p", "p#1", "two ");
    relay.data("p", "p#1", "three");
    expect(window.sent).toHaveLength(0);

    window.bufferedAmount = 0;
    await sleep(60);
    // three chunks, one frame, same characters in the same order
    expect(window.sent).toHaveLength(1);
    expect(window.text()).toBe("one two three");
    relay.stop();
  });

  test("the shell is paused while every window is behind, and let go when one catches up", async () => {
    const { relay, holds, add } = setup();
    const window = add();
    window.bufferedAmount = 1024 * 1024;
    relay.data("p", "p#1", "output");
    expect(holds).toEqual([["p#1", true]]);

    window.bufferedAmount = 0;
    await sleep(60);
    expect(holds).toEqual([
      ["p#1", true],
      ["p#1", false],
    ]);
    relay.stop();
  });

  test("a window keeping up is not held back by one that is not", () => {
    const { relay, add } = setup();
    const quick = add();
    const slow = add();
    slow.bufferedAmount = 1024 * 1024;
    relay.data("p", "p#1", "now");
    expect(quick.text()).toBe("now");
    expect(slow.sent).toHaveLength(0);
    relay.stop();
  });

  test("once a window is behind on a tab it stays in order behind it", () => {
    const { relay, add } = setup();
    const window = add();
    window.bufferedAmount = 1024 * 1024;
    relay.data("p", "p#1", "first");
    // room again, but what is waiting must go out before anything newer
    window.bufferedAmount = 0;
    relay.data("p", "p#1", "second");
    expect(window.sent).toHaveLength(0);
    relay.flush("p#1");
    expect(window.text()).toBe("firstsecond");
    relay.stop();
  });

  test("a shell ending sends what it last said", () => {
    const { relay, holds, add } = setup();
    const window = add();
    window.bufferedAmount = 1024 * 1024;
    relay.data("p", "p#1", "the last words");
    relay.flush("p#1");
    expect(window.text()).toBe("the last words");
    expect(holds.at(-1)).toEqual(["p#1", false]);
    relay.stop();
  });

  test("a window that has gone is forgotten, and its tab let go with it", () => {
    const { relay, sockets, holds, add } = setup();
    const window = add();
    window.bufferedAmount = 1024 * 1024;
    relay.data("p", "p#1", "output");
    expect(holds).toEqual([["p#1", true]]);
    sockets.delete(window.as());
    relay.forget(window.as());
    expect(holds).toEqual([
      ["p#1", true],
      ["p#1", false],
    ]);
    relay.stop();
  });

  test("a window that is not draining at all is closed rather than queued for", () => {
    const { relay, add } = setup();
    const window = add();
    window.bufferedAmount = 64 * 1024 * 1024;
    relay.data("p", "p#1", "output");
    expect(window.terminated).toBe(true);
    expect(window.sent).toHaveLength(0);
    relay.stop();
  });

  test("what is held for one window is bounded however far behind it falls", () => {
    const { relay, add } = setup();
    const window = add();
    window.bufferedAmount = 1024 * 1024;
    const line = "x".repeat(1000);
    for (let i = 0; i < 2000; i++) relay.data("p", "p#1", line);
    relay.flush("p#1");
    const kept = window.text();
    expect(kept.length).toBe(400_000);
    expect(kept.endsWith(line)).toBe(true);
    relay.stop();
  });

  test("tabs are held apart from one another", () => {
    const { relay, add } = setup();
    const window = add();
    window.bufferedAmount = 1024 * 1024;
    relay.data("p", "p#1", "one");
    relay.data("p", "p#2", "two");
    relay.flush("p#1");
    expect(window.text()).toBe("one");
    relay.flush("p#2");
    expect(window.text()).toBe("onetwo");
    relay.stop();
  });
});
