import { afterEach, describe, expect, test } from "bun:test";
import { SPLIT_PREF, type AttachmentUpload, type ServerMessage } from "../shared/protocol.js";
import type { ClientConn, ServerContext } from "./context.js";
import { drainQueue } from "./dispatch.js";
import { promptHandlers } from "./handlers/prompts.js";
import { HOME_ID } from "./manager.js";
import { cutAt, pieces, routeUploads, SPLIT_LONGER_THAN, wantsSplit } from "./promptSplit.js";
import { combine, SendQueues } from "./queue.js";
import { setCompletionClient } from "./smallmodel.js";

const padding = "Details about it that go on for a while. ".repeat(Math.ceil(SPLIT_LONGER_THAN / 40));
const LONG = `Fix the header. ${padding}\nThen fix the footer. It flickers.\n\nAnd also don't push.`;

let chats = 0;
function chat(opts: { prefs?: Record<string, string>; status?: string } = {}) {
  // the handler remembers every window id it has taken, for good
  const run = ++chats;
  const id = (name: string) => `${name}-${run}`;
  const sent: ServerMessage[] = [];
  const said: string[] = [];
  const status = { c1: opts.status ?? "working" } as Record<string, string>;
  const ctx = {
    prefs: { all: () => opts.prefs ?? {} },
    queues: new SendQueues((m) => sent.push(m)),
    retries: { cancelRetry: () => {} },
    store: { findSession: () => ({ session: { id: "c1" }, project: { id: "p", path: undefined } }) },
    manager: { statuses: () => status },
    archive: {
      events: () => [],
      append: (_: string, e: { text: string }) => said.push(e.text),
    },
    clients: { pushEvent: () => {} },
  } as unknown as ServerContext;
  const ws = { readyState: 1, send: () => {} } as unknown as ClientConn;
  const prompt = (text: string, clientId: string, attachments?: AttachmentUpload[]) =>
    promptHandlers.send(ctx, ws, {
      type: "send",
      projectId: "c1",
      text,
      clientId: id(clientId),
      ...(attachments ? { attachments } : {}),
    });
  const queue = () => ctx.queues.entries.get("c1") ?? [];
  return { ctx, id, prompt, queue, said, status };
}

const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

afterEach(() => setCompletionClient(null));

describe("the pieces of a prompt", () => {
  test("in order they are the text, exactly", () => {
    for (const text of [LONG, "One. Two!  Three?\n\n\nFour\n", "  lead\n```\ncode. more code.\n\nstill code\n```\nafter. end"]) {
      expect(pieces(text)!.join("")).toBe(text);
    }
  });

  test("a sentence is a piece, a code fence stays whole", () => {
    expect(pieces("One. Two.\nThree")).toEqual(["One. ", "Two.\n", "Three"]);
    expect(pieces("Look:\n```\na. b.\n\nc\n```\nDone")).toEqual(["Look:\n", "```\na. b.\n\nc\n```\n", "Done"]);
  });

  test("a huge paste comes in coarser pieces, or none", () => {
    const sentences = "Word here. ".repeat(400) + "\n";
    expect(pieces(sentences)!.length).toBe(1);
    const manyParagraphs = "line\n\n".repeat(400);
    expect(pieces(manyParagraphs)).toBeUndefined();
  });
});

describe("cutting at the model's numbers", () => {
  const parts = ["From Sam. ", "Fix A in the header. ", "More on A and how. ", "Fix B in the footer. ", "Don't push."];

  test("every task is the user's own words, the shared pieces around it", () => {
    expect(cutAt(parts, { tasks: [2, 4], shared: [5] })).toEqual([
      "From Sam.\n\nFix A in the header. More on A and how.\n\nDon't push.",
      "From Sam.\n\nFix B in the footer.\n\nDon't push.",
    ]);
  });

  test("nothing but the numbers it was shown, and at least two tasks", () => {
    for (const bad of [
      { tasks: [2], shared: [] },
      { tasks: [4, 2], shared: [] },
      { tasks: [2, 9], shared: [] },
      { tasks: [2, 2.5], shared: [] },
      { tasks: [2, 4], shared: [4] },
      { tasks: [2, "4"] as unknown as number[], shared: [] },
      // nearly all "shared": it didn't divide the prompt
      { tasks: [4, 5], shared: [] },
    ]) {
      expect(cutAt(["Long opening words here.", ...parts], bad)).toBeUndefined();
    }
  });

  test("a task with nothing of its own is no task", () => {
    expect(cutAt(parts, { tasks: [2, 3], shared: [3] })).toBeUndefined();
  });
});

describe("attachments go with the task that names them", () => {
  const upload = (kind: AttachmentUpload["kind"], n: number, extra = {}) =>
    ({ id: `${kind}${n}`, kind, n, name: "x", mediaType: "image/png", data: "", ...extra }) as AttachmentUpload;

  test("by marker, to each that names it; one nobody names to the first", () => {
    const routed = routeUploads(
      ["look at [image #1]", "and [image #2] with [image #1], see [region #1]"],
      [upload("image", 1), upload("image", 2), upload("file", 1), upload("image", 3, { regions: [{ n: 1 }] })],
    );
    expect(routed.map((part) => part.map((u) => u.id))).toEqual([
      ["image1", "file1"],
      ["image1", "image2", "image3"],
    ]);
  });
});

describe("which prompts are cut", () => {
  const { ctx } = chat();
  test("long ones from the user, in a project's chat", () => {
    expect(wantsSplit(ctx, "c1", LONG, "id")).toBe(true);
    expect(wantsSplit(ctx, "c1", "short", "id")).toBe(false);
    expect(wantsSplit(ctx, HOME_ID, LONG, "id")).toBe(false);
  });
  test("not midna's: it follows its prompt by its id", () => {
    expect(wantsSplit(ctx, "c1", LONG, "midna-x")).toBe(false);
  });
  test("not with the switch off", () => {
    expect(wantsSplit(chat({ prefs: { [SPLIT_PREF]: "off" } }).ctx, "c1", LONG, "id")).toBe(false);
  });
  test("not one holding a command", () => {
    expect(wantsSplit(ctx, "c1", `/compact\n${LONG}`, "id")).toBe(false);
  });
});

describe("a long prompt on its way through the queue", () => {
  const answering = (reply: string | Error) =>
    setCompletionClient(async () => {
      if (reply instanceof Error) throw reply;
      return reply;
    });

  test("its tasks stand where it stood, in order, the first under its id", async () => {
    answering('{"tasks":[1,4],"shared":[]}');
    const c = chat();
    c.prompt("first in line", "a");
    c.prompt(LONG, "b");
    c.prompt("behind it", "c");
    expect(c.queue().find((e) => e.id === c.id("b"))?.splitting).toBe(true);
    await settled();
    expect(c.queue().length).toBe(4);
    expect(c.queue()[0]!.id).toBe(c.id("a"));
    expect(c.queue()[1]!.id).toBe(c.id("b"));
    expect(c.queue()[1]!.part).toEqual({ n: 1, of: 2 });
    expect(c.queue()[2]!.part).toEqual({ n: 2, of: 2 });
    expect(c.queue()[3]!.id).toBe(c.id("c"));
    expect(c.said).toEqual(["Split into 2 tasks, sent one at a time."]);
  });

  test("attachments and their display go with the task", async () => {
    answering('{"tasks":[1,4],"shared":[]}');
    const c = chat();
    const text = `Fix [image #1]. ${padding}\nThen [image #2]. Also this.\nDone.`;
    const parts = pieces(text)!;
    const second = parts.findIndex((p) => p.startsWith("Then")) + 1;
    answering(`{"tasks":[1,${second}],"shared":[]}`);
    const picture = (n: number) =>
      ({ id: `i${n}`, kind: "image", n, name: "x.png", mediaType: "image/png", data: "aGk=" }) as AttachmentUpload;
    c.prompt(text, "b", [picture(1), picture(2)]);
    await settled();
    expect(c.queue().map((e) => e.uploads.map((u) => u.id))).toEqual([["i1"], ["i2"]]);
    expect(c.queue().map((e) => e.attachments?.map((a) => a.id))).toEqual([["i1"], ["i2"]]);
  });

  for (const [why, reply] of [
    ["the model fails", new Error("down")],
    ["the model talks", "I'd rather not"],
    ["it sees one task", '{"tasks":[1],"shared":[]}'],
    ["its numbers are wrong", '{"tasks":[1,9999],"shared":[]}'],
  ] as const) {
    test(`goes whole when ${why}`, async () => {
      answering(reply);
      const c = chat();
      c.prompt(LONG, "b");
      for (let i = 0; i < 400 && c.queue()[0]?.splitting; i++) await new Promise((r) => setTimeout(r, 10));
      expect(c.queue().length).toBe(1);
      expect(c.queue()[0]!.text).toBe(LONG);
      expect(c.queue()[0]!.splitting).toBeUndefined();
      expect(c.said).toEqual([]);
    }, 15_000);
  }

  test("nothing goes past it while it is being cut", () => {
    setCompletionClient(() => new Promise(() => {}));
    const c = chat({ status: "idle" });
    c.prompt(LONG, "b");
    expect(c.queue()[0]!.splitting).toBe(true);
    expect(drainQueue(c.ctx, "c1")).toBe(false);
    expect(c.queue().length).toBe(1);
    // and it can't be folded into another meanwhile
    expect(combine([...c.queue(), { id: "x", text: "x", uploads: [], silent: false }], "x", c.id("b"))).toBeNull();
  });

  test("taken out meanwhile, it stays out", async () => {
    answering('{"tasks":[1,4],"shared":[]}');
    const c = chat();
    c.prompt(LONG, "b");
    promptHandlers.queue_remove(c.ctx, {} as ClientConn, { type: "queue_remove", projectId: "c1", itemId: c.id("b") });
    await settled();
    expect(c.queue()).toEqual([]);
    expect(c.said).toEqual([]);
  });

  test("rewritten meanwhile, the user's rewrite stands", async () => {
    answering('{"tasks":[1,4],"shared":[]}');
    const c = chat();
    c.prompt(LONG, "b");
    promptHandlers.queue_edit(c.ctx, {} as ClientConn, { type: "queue_edit", projectId: "c1", itemId: c.id("b") });
    await settled();
    expect(c.queue().length).toBe(1);
    expect(c.queue()[0]!.editing).toBe(true);
    expect(c.said).toEqual([]);
  });

  test("a short prompt and midna's go as they always did", async () => {
    let asked = 0;
    setCompletionClient(async () => {
      asked += 1;
      return '{"tasks":[1,4],"shared":[]}';
    });
    const c = chat();
    c.prompt("short", "a");
    c.prompt(LONG, "midna-b");
    await settled();
    expect(asked).toBe(0);
    expect(c.queue().map((e) => e.id)).toEqual([c.id("a"), c.id("midna-b")]);
    expect(c.queue()[1]!.text).toBe(LONG);
  });
});
