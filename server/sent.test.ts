import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import type { ClientMessage, Project, ServerMessage, TranscriptEvent } from "../shared/protocol.js";
import type { ClientConn, ServerContext } from "./context.js";
import { Clients } from "./clients.js";
import { handleMessage } from "./handlers/index.js";
import { SendQueues } from "./queue.js";

/*
 * A prompt the window has already put on screen under its own id: the
 * server files it under that id, says where it went, and takes a second
 * copy of it (a window sending again after its socket dropped) as the same
 * prompt rather than a new one.
 */

let dir: string;
let saved: string | undefined;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-sent-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

function world(status: "idle" | "working" = "working", events: TranscriptEvent[] = []) {
  const projects: Project[] = [
    { id: "p", name: "web", path: dir, sessions: [{ id: "a", title: "Frontend" }] },
  ];
  const said: ServerMessage[] = [];
  const broadcast = (message: ServerMessage) => said.push(message);
  const digests: string[] = [];
  const ctx = {
    store: {
      list: () => projects,
      sessionIds: () => ["a"],
      leadIds: () => ["a"],
      findSession: (id: string) =>
        id === "a" ? { project: projects[0]!, session: projects[0]!.sessions[0]! } : undefined,
    },
    clients: new Clients(),
    queues: new SendQueues(broadcast),
    manager: { statuses: () => ({ a: status }), settle: () => {} },
    meters: { watch: () => {}, latest: () => undefined },
    archive: {
      events: () => events,
      allSummaries: () => ({}),
      earlier: () => [],
    },
    readable: { allowReadImages: () => {} },
    retries: { cancelRetry: () => {} },
    digests: { run: (id: string) => digests.push(id) },
  } as unknown as ServerContext;
  const heard: ServerMessage[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: (raw: string) => heard.push(JSON.parse(raw) as ServerMessage),
  } as unknown as ClientConn;
  const say = (msg: ClientMessage) => handleMessage(ctx, ws, msg);
  return { ctx, ws, said, heard, say, digests };
}

/** A fresh id per test: the server remembers every prompt it has taken
 *  for as long as it runs, and these tests share one. */
const newId = () => crypto.randomUUID();
const settled = () => new Promise<void>((resolve) => queueMicrotask(resolve));

describe("a prompt the window named", () => {
  test("behind a running turn it waits in the queue under the window's id, and the window hears so", async () => {
    const ID = newId();
    const { ctx, heard, say } = world("working");
    say({ type: "send", projectId: "a", text: "and then the tests", clientId: ID });
    expect(ctx.queues.entries.get("a")?.map((e) => e.id)).toEqual([ID]);
    // the answer waits for the prompt to have landed
    expect(heard.filter((m) => m.type === "sent")).toEqual([]);
    await settled();
    expect(heard).toContainEqual({ type: "sent", projectId: "a", clientId: ID, as: "queued" });
  });

  test("sent a second time it is the same prompt: answered again, queued once", async () => {
    const ID = newId();
    const { ctx, heard, say } = world("working");
    say({ type: "send", projectId: "a", text: "once", clientId: ID });
    await settled();
    say({ type: "send", projectId: "a", text: "once", clientId: ID });
    await settled();
    expect(ctx.queues.entries.get("a")).toHaveLength(1);
    expect(heard.filter((m) => m.type === "sent")).toHaveLength(2);
  });

  test("one the transcript already holds — the server restarted since — is not run again", async () => {
    const ID = newId();
    const prompt: TranscriptEvent = { kind: "user", id: ID, text: "done already", ts: 1 };
    const { ctx, heard, say } = world("idle", [prompt]);
    say({ type: "send", projectId: "a", text: "done already", clientId: ID });
    await settled();
    expect(ctx.queues.entries.get("a")).toBeUndefined();
    expect(heard).toEqual([{ type: "sent", projectId: "a", clientId: ID, as: "event" }]);
  });

  test("a window that names nothing is answered nothing, as before", async () => {
    const { ctx, heard, say } = world("working");
    say({ type: "send", projectId: "a", text: "plain" });
    await settled();
    expect(ctx.queues.entries.get("a")).toHaveLength(1);
    expect(ctx.queues.entries.get("a")![0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(heard.filter((m) => m.type === "sent")).toEqual([]);
  });
});

describe("the line itself", () => {
  test("a ping is answered with a pong, to the asker", () => {
    const { heard, said, say } = world();
    say({ type: "ping" });
    expect(heard).toEqual([{ type: "pong" }]);
    expect(said).toEqual([]);
  });
});

describe("a transcript asked for ahead of opening", () => {
  test("is sent, sets nothing else going, and marks where the window now stands", () => {
    const { ctx, ws, heard, say, digests } = world("idle", [{ kind: "user", id: "u1", text: "hi", ts: 1 }]);
    say({ type: "view", channels: [], live: true });
    say({ type: "transcript_get", projectId: "a", prefetch: true });
    expect(heard.map((m) => m.type)).toContain("transcript");
    expect(digests).toEqual([]);
    // opening it later catches the window up from here, rather than
    // leaving it holding what it fetched
    expect(ctx.clients.views.get(ws)?.seen.get("a")).toEqual(ctx.clients.mark("a"));
  });
});
