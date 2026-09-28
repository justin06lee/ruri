/**
 * A window nobody is looking at is sent nothing of its chats.
 *
 * It says so in its view (`live` false, web/src/lib/awake.ts). Until it says
 * live again, none of what its chats do reaches it — not a reply's
 * paragraphs, not the turn's counter, not the turn's end — and waking, it is
 * caught up on exactly what it missed. Chats it does not have open still
 * send it their finished turns, which it holds unread (web/src/lib/held.ts).
 */
import { describe, expect, test } from "bun:test";
import { WebSocket } from "ws";
import type { ServerMessage, TranscriptEvent } from "../shared/protocol.js";
import { Clients } from "./clients.js";
import type { ClientConn, ServerContext } from "./context.js";
import { transcriptHandlers } from "./handlers/transcript.js";

/** A window: what it was sent, as the messages themselves. */
function socket(clients: Clients): { ws: ClientConn; got: ServerMessage[] } {
  const got: ServerMessage[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: (payload: string) => got.push(JSON.parse(payload) as ServerMessage),
  } as unknown as ClientConn;
  clients.sockets.add(ws);
  return { ws, got };
}

/** As much of the server as the view handler and a catch-up reach for. */
function server(): { ctx: ServerContext; clients: Clients } {
  const clients = new Clients();
  const ctx = {
    clients,
    store: { sessionIds: () => ["a", "b"] },
    meters: { watch: () => {}, latest: () => undefined },
    readable: { allowReadImages: () => {}, allowArchived: (t: unknown) => t },
    archive: { events: () => [], allSummaries: () => ({}), earlier: () => [], tails: () => ({}) },
    turns: { gates: new Map(), progress: new Map() },
    crew: { list: () => [] },
    manager: { settle: () => {} },
  } as unknown as ServerContext;
  return { ctx, clients };
}

const view = (ctx: ServerContext, ws: ClientConn, channels: string[], live: boolean) =>
  transcriptHandlers.view(ctx, ws, { type: "view", channels, live, awake: live });

const said = (id: string): TranscriptEvent => ({ kind: "assistant", id, text: id, ts: 0 }) as TranscriptEvent;
const done = (id: string): TranscriptEvent => ({ kind: "result", id, ts: 0 }) as unknown as TranscriptEvent;

const events = (got: ServerMessage[]) =>
  got.flatMap((m) => (m.type === "event" ? [`${m.projectId}:${m.event.id}`] : []));

describe("a sleeping window", () => {
  test("is sent nothing of the chat it has open", () => {
    const { ctx, clients } = server();
    const { ws, got } = socket(clients);
    view(ctx, ws, ["a"], false);
    got.length = 0;
    clients.pushEvent("a", said("m1"));
    clients.pushEvent("a", done("r1"));
    clients.toViewers("a", { type: "turn", projectId: "a", turn: null });
    expect(got).toEqual([]);
  });

  test("still hears a turn end in a chat it does not have open", () => {
    const { ctx, clients } = server();
    const { ws, got } = socket(clients);
    view(ctx, ws, ["a"], false);
    got.length = 0;
    clients.pushEvent("b", said("m1"));
    clients.pushEvent("b", done("r1"));
    expect(events(got)).toEqual(["b:r1"]);
  });

  test("waking, is caught up on exactly what it missed, in order", () => {
    const { ctx, clients } = server();
    const { ws, got } = socket(clients);
    view(ctx, ws, ["a"], true);
    clients.pushEvent("a", said("m1"));
    view(ctx, ws, ["a"], false);
    clients.pushEvent("a", said("m2"));
    clients.pushEvent("a", done("r1"));
    got.length = 0;
    view(ctx, ws, ["a"], true);
    expect(events(got)).toEqual(["a:m2", "a:r1"]);
    // and the live turn's state after the events, for the counter
    expect(got.map((m) => m.type)).toEqual(["event", "event", "reply", "turn"]);
  });

  test("awake again, it is sent the chat as it happens", () => {
    const { ctx, clients } = server();
    const { ws, got } = socket(clients);
    view(ctx, ws, ["a"], false);
    view(ctx, ws, ["a"], true);
    got.length = 0;
    clients.pushEvent("a", said("m3"));
    expect(events(got)).toEqual(["a:m3"]);
  });

  test("another window awake on the same chat is sent it as ever", () => {
    const { ctx, clients } = server();
    const asleep = socket(clients);
    const awake = socket(clients);
    view(ctx, asleep.ws, ["a"], false);
    view(ctx, awake.ws, ["a"], true);
    asleep.got.length = 0;
    awake.got.length = 0;
    clients.pushEvent("a", said("m1"));
    clients.pushEvent("a", done("r1"));
    expect(events(asleep.got)).toEqual([]);
    expect(events(awake.got)).toEqual(["a:m1", "a:r1"]);
  });

  test("keeps its chats open, so their processes keep the sleeping lease", () => {
    const { ctx, clients } = server();
    const { ws } = socket(clients);
    view(ctx, ws, ["a"], false);
    expect(clients.isDozing("a")).toBe(true);
  });
});
