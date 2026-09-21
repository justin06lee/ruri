import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Attachment } from "../shared/protocol.js";
import { IdeaStore } from "./ideas.js";

let dir: string;
let saved: string | undefined;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-ideas-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
});

const picture = (n: number): Attachment => ({
  id: `att-${n}`,
  kind: "image",
  mediaType: "image/png",
  name: `shot-${n}.png`,
  n,
  url: `/uploads/att-${n}-shot-${n}.png`,
});

describe("ideas with pictures", () => {
  test("an idea keeps its lines and its pictures, and they survive a reload", () => {
    const ideas = new IdeaStore();
    const idea = ideas.add("p", "first line\nsecond line [image #1]", [picture(1)]);
    expect(idea.attachments).toEqual([picture(1)]);
    const again = new IdeaStore().items("p");
    expect(again[0]!.text).toBe("first line\nsecond line [image #1]");
    expect(again[0]!.attachments).toEqual([picture(1)]);
  });

  test("an idea with no pictures carries no empty list", () => {
    const idea = new IdeaStore().add("p", "words only");
    expect("attachments" in idea).toBe(false);
  });

  test("a picture alone is an idea; its words may be emptied while a picture stays", () => {
    const ideas = new IdeaStore();
    const idea = ideas.add("p", "", [picture(1)]);
    ideas.update("p", idea.id, { text: "" });
    expect(ideas.get("p", idea.id)!.attachments).toHaveLength(1);
    ideas.update("p", idea.id, { text: "now with words" });
    expect(ideas.get("p", idea.id)!.text).toBe("now with words");
  });

  test("an update's list replaces the pictures, but never empties an idea completely", () => {
    const ideas = new IdeaStore();
    const idea = ideas.add("p", "", [picture(1), picture(2)]);
    ideas.update("p", idea.id, { attachments: [picture(2)] });
    expect(ideas.get("p", idea.id)!.attachments).toEqual([picture(2)]);
    // no words and no pictures would be nothing at all: refused
    ideas.update("p", idea.id, { attachments: [] });
    expect(ideas.get("p", idea.id)!.attachments).toEqual([picture(2)]);
    // with words, the last picture can go — and the field goes with it
    ideas.update("p", idea.id, { text: "kept", attachments: [] });
    const now = ideas.get("p", idea.id)!;
    expect(now.text).toBe("kept");
    expect("attachments" in now).toBe(false);
  });
});
