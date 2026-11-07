import { describe, expect, test } from "bun:test";
import { CARRY_ON, type PhoneChatFrame, type TranscriptEvent } from "../shared/protocol.js";
import { nextFrame, phoneItems, readSendBody } from "./phoneChat.js";

const at = 1_700_000_000_000;

describe("phoneItems", () => {
  test("what was said in full, tool calls folded into steps, ruri's own prompts left out", () => {
    const events: TranscriptEvent[] = [
      { kind: "user", id: "u1", text: "fix the build", ts: at },
      { kind: "tool", id: "t1", name: "Read", summary: "Makefile", ts: at + 1 },
      { kind: "tool", id: "t2", name: "Bash", summary: "make build", ts: at + 2 },
      { kind: "assistant", id: "a1", text: "Fixed.", ts: at + 3 },
      { kind: "result", id: "r1", ok: true, ts: at + 4 },
      { kind: "user", id: "u2", text: `${CARRY_ON}: carry on`, ts: at + 5 },
      { kind: "result", id: "r2", ok: false, error: "overloaded", ts: at + 6 },
      { kind: "result", id: "r3", ok: false, stopped: true, ts: at + 7 },
    ];
    const items = phoneItems(events);
    expect(items.map((item) => [item.id, item.kind, item.text])).toEqual([
      ["u1", "user", "fix the build"],
      ["t1", "steps", "2 steps"],
      ["a1", "assistant", "Fixed."],
      ["r2", "note", "Stopped on an error: overloaded"],
      ["r3", "note", "Stopped"],
    ]);
    expect(items[1]!.steps).toEqual(["Read: Makefile", "Bash: make build"]);
  });

  test("a prompt's attachments come with it, and files alone are still a prompt", () => {
    const attachment = {
      id: "a1",
      kind: "image" as const,
      mediaType: "image/jpeg",
      name: "photo.jpg",
      n: 1,
      url: "/uploads/a1-photo.jpg",
    };
    const items = phoneItems([
      { kind: "user", id: "u1", text: "", attachments: [attachment], ts: at },
      { kind: "user", id: "u2", text: "no file", ts: at + 1 },
      { kind: "user", id: "u3", text: "", ts: at + 2 },
    ]);
    expect(items.map((item) => item.id)).toEqual(["u1", "u2"]);
    expect(items[0]!.attachments).toEqual([attachment]);
    expect(items[1]!.attachments).toBeUndefined();
  });

  test("the reply still being written comes last, marked pending", () => {
    const items = phoneItems([{ kind: "user", id: "u1", text: "hi", ts: at }], { id: "m1", text: "Hel" });
    expect(items.at(-1)).toMatchObject({ id: "draft:m1", kind: "assistant", text: "Hel", pending: true });
  });
});

describe("nextFrame", () => {
  const frame = (items: { id: string; text: string }[]): PhoneChatFrame => ({
    chat: "c",
    name: "ruri",
    project: "ruri",
    state: "working",
    queue: [],
    items: items.map((item) => ({ ...item, kind: "assistant", at: "" })),
  });

  test("the whole list first, then only what changed or is new", () => {
    const first = nextFrame(frame([{ id: "a", text: "1" }]), new Map());
    expect(first.send?.items?.length).toBe(1);
    const second = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      first.held,
    );
    expect(second.send?.items).toBeUndefined();
    expect(second.send?.upsert?.map((item) => item.id)).toEqual(["b"]);
    const same = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      second.held,
    );
    expect(same.send).toBeUndefined();
  });

  test("a draft that became the reply: removed, and the reply added", () => {
    const held = nextFrame(frame([{ id: "draft:m", text: "Hel" }]), new Map()).held;
    const next = nextFrame(frame([{ id: "a", text: "Hello" }]), held);
    expect(next.send?.remove).toEqual(["draft:m"]);
    expect(next.send?.upsert?.map((item) => item.id)).toEqual(["a"]);
  });

  test("a change of order sends the whole list again", () => {
    const held = nextFrame(
      frame([
        { id: "a", text: "1" },
        { id: "b", text: "2" },
      ]),
      new Map(),
    ).held;
    const next = nextFrame(
      frame([
        { id: "b", text: "2" },
        { id: "a", text: "1" },
      ]),
      held,
    );
    expect(next.send?.items?.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("a send from the phone", () => {
  const file = { id: "a-1", kind: "image" as const, mediaType: "image/png", name: "x.png", n: 1, data: "aGk=" };
  const send = (more: Record<string, unknown>) => readSendBody({ id: "c", text: "hi", clientId: "p", ...more });

  test("words, files or both", () => {
    expect(send({})?.uploads).toEqual([]);
    expect(send({ attachments: [file] })?.uploads).toEqual([file]);
    expect(send({ text: "", attachments: [file] })?.uploads).toEqual([file]);
  });

  test("not nothing, and not what isn't one", () => {
    expect(send({ text: "  " })).toBeUndefined();
    expect(send({ attachments: "x" })).toBeUndefined();
    expect(send({ attachments: [{ ...file, kind: "virus" }] })).toBeUndefined();
    expect(send({ attachments: [{ ...file, data: "" }] })).toBeUndefined();
    expect(send({ attachments: Array(21).fill(file) })).toBeUndefined();
  });

  test("an id can't walk out of the uploads folder", () => {
    for (const id of ["../../evil", "a/b", "a\\b", "..", ""])
      expect(send({ attachments: [{ ...file, id }] })).toBeUndefined();
  });

  test("only the fields it may set get through", () => {
    const body = send({ attachments: [{ ...file, url: "/x", picture: "aGk=", regions: [] }] });
    expect(Object.keys(body!.uploads[0]!).sort()).toEqual(["data", "id", "kind", "mediaType", "n", "name"]);
  });
});
