/**
 * Who keeps an agent process warm: a chat open in a window someone is
 * looking at, and nobody else.
 *
 * A warm CLI is 200-odd MB and goes on asking for the CPU for as long as it
 * lives, so "open" has to mean open in front of someone. These are the two
 * readings server/chats.ts hands the reaper (server/sessions.ts): `isOpen`,
 * which holds a process for ten minutes, and `isDozing`, which holds it for
 * one.
 */
import { describe, expect, test } from "bun:test";
import type { ClientConn } from "./context.js";
import { Clients, type ClientView } from "./clients.js";
import { clientMessageSchema } from "../shared/clientSchema.js";

let next = 0;
/** A window, as far as these two readings are concerned. */
function window(clients: Clients, channels: string[], awake: boolean): ClientConn {
  const ws = { id: (next += 1) } as unknown as ClientConn;
  clients.views.set(ws, {
    channels: new Set(channels),
    board: false,
    meters: false,
    awake,
    seen: new Map(),
  } satisfies ClientView);
  return ws;
}

describe("isOpen", () => {
  test("a chat open in a window someone is looking at", () => {
    const clients = new Clients();
    window(clients, ["a"], true);
    expect(clients.isOpen("a")).toBe(true);
  });

  test("the same chat, once the window has gone to sleep", () => {
    const clients = new Clients();
    window(clients, ["a"], false);
    expect(clients.isOpen("a")).toBe(false);
  });

  test("one window awake on it is enough, whatever the others are doing", () => {
    const clients = new Clients();
    window(clients, ["a"], false);
    window(clients, ["a"], true);
    expect(clients.isOpen("a")).toBe(true);
    expect(clients.isDozing("a")).toBe(false);
  });

  test("a chat nobody has open", () => {
    const clients = new Clients();
    window(clients, ["b"], true);
    expect(clients.isOpen("a")).toBe(false);
    expect(clients.isDozing("a")).toBe(false);
  });
});

describe("isDozing", () => {
  test("open, but only where nobody is looking", () => {
    const clients = new Clients();
    window(clients, ["a"], false);
    expect(clients.isDozing("a")).toBe(true);
  });

  test("open in front of someone is not dozing — it has the long lease", () => {
    const clients = new Clients();
    window(clients, ["a"], true);
    expect(clients.isDozing("a")).toBe(false);
  });

  test("every window asleep, on several chats", () => {
    const clients = new Clients();
    window(clients, ["a", "b"], false);
    window(clients, ["b"], false);
    expect(clients.isDozing("a")).toBe(true);
    expect(clients.isDozing("b")).toBe(true);
    expect(clients.isOpen("b")).toBe(false);
  });
});

describe("the view message carries it", () => {
  const view = (extra: object) =>
    clientMessageSchema.safeParse({ type: "view", channels: ["a"], live: true, ...extra });

  test("awake survives the schema — stripped, the server would never hear it", () => {
    const parsed = view({ awake: false });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.type === "view" && parsed.data.awake).toBe(false);
  });

  test("a client that does not say at all still parses", () => {
    const parsed = view({});
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.type === "view" && parsed.data.awake).toBeUndefined();
  });
});
