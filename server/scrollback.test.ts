import { describe, expect, test } from "bun:test";
import { Scrollback } from "./scrollback.js";

/** What the single-string version did, kept here as the thing to match. */
function naive(chunks: string[], max: number): string {
  let buffer = "";
  for (const chunk of chunks) buffer = (buffer + chunk).slice(-max);
  return buffer;
}

describe("Scrollback", () => {
  test("holds everything printed while it fits", () => {
    const back = new Scrollback(100);
    back.push("hello ");
    back.push("world");
    expect(back.read()).toBe("hello world");
    expect(back.length).toBe(11);
  });

  test("an empty one reads as nothing", () => {
    expect(new Scrollback(100).read()).toBe("");
  });

  test("keeps the newest `max` characters, as the string version did", () => {
    const chunks = ["abcdefgh", "ijkl", "mnopqrstuv", "wxyz"];
    for (const max of [1, 2, 5, 7, 12, 26, 40]) {
      const back = new Scrollback(max);
      for (const chunk of chunks) back.push(chunk);
      expect(back.read()).toBe(naive(chunks, max));
    }
  });

  test("a chunk longer than the whole budget keeps only its tail", () => {
    const back = new Scrollback(8);
    back.push("xy");
    back.push("0123456789abcdef");
    expect(back.read()).toBe("89abcdef");
    expect(back.read()).toBe(naive(["xy", "0123456789abcdef"], 8));
    expect(back.length).toBe(8);
  });

  test("many small writes match the string version exactly", () => {
    const max = 64;
    const chunks: string[] = [];
    for (let i = 0; i < 500; i++) chunks.push(`${i}\n`);
    const back = new Scrollback(max);
    for (const chunk of chunks) back.push(chunk);
    expect(back.read()).toBe(naive(chunks, max));
  });

  test("reading twice does not change what is held", () => {
    const back = new Scrollback(6);
    back.push("abcdefgh");
    expect(back.read()).toBe("cdefgh");
    expect(back.read()).toBe("cdefgh");
    back.push("ij");
    expect(back.read()).toBe("efghij");
  });

  test("an empty write is not a write", () => {
    const back = new Scrollback(4);
    back.push("ab");
    back.push("");
    expect(back.read()).toBe("ab");
  });

  test("a budget of nothing holds nothing", () => {
    const back = new Scrollback(0);
    back.push("abc");
    expect(back.read()).toBe("");
    expect(back.length).toBe(0);
  });

  test("clearing empties it", () => {
    const back = new Scrollback(10);
    back.push("abcdef");
    back.clear();
    expect(back.read()).toBe("");
    expect(back.length).toBe(0);
    back.push("gh");
    expect(back.read()).toBe("gh");
  });

  test("the cut never falls between a surrogate pair", () => {
    // four code units: two astral characters
    const back = new Scrollback(3);
    back.push("😀😀");
    const kept = back.read();
    expect(kept).toBe("😀");
    expect([...kept]).toHaveLength(1);
    expect(kept.length).toBe(2);
  });

  test("stays O(what arrived): a megabyte of small writes is quick", () => {
    const back = new Scrollback(200_000);
    const line = "the quick brown fox jumps over the lazy dog\n";
    const started = performance.now();
    for (let i = 0; i < 40_000; i++) back.push(line);
    const elapsed = performance.now() - started;
    expect(back.length).toBe(200_000);
    // the string version needs ~8 GB of copying for this; anything near
    // that blows well past a second, and this should be tens of ms
    expect(elapsed).toBeLessThan(2_000);
  });
});
