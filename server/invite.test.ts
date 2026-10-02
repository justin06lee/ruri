import { describe, expect, test } from "bun:test";
import {
  INVITE_WORDS,
  macsMatch,
  makeWords,
  nonce,
  pairMac,
  readWords,
  urlHost,
  wordsKey,
} from "./invite.js";
import { WORDS } from "./words.js";

describe("invite words", () => {
  test("are six of the list's words, different every time", () => {
    const a = makeWords();
    expect(a).toHaveLength(INVITE_WORDS);
    for (const word of a) expect(WORDS).toContain(word);
    const seen = new Set(Array.from({ length: 200 }, () => makeWords().join(" ")));
    expect(seen.size).toBe(200);
  });

  test("read back however they were typed", () => {
    const words = ["ocean", "river", "cannon", "orbit", "mango", "fever"];
    expect(readWords("ocean river cannon orbit mango fever")).toEqual({ words });
    expect(readWords("  Ocean, RIVER-cannon\n orbit.mango   fever ")).toEqual({ words });
    // a word is known by its first four letters, typo after them and all
    expect(readWords("ocea rive cann orbi mang feve")).toEqual({ words });
    expect(readWords("oceanx riverr cannons orbits mangoo fevers")).toEqual({ words });
  });

  test("say what is wrong with what isn't an invite", () => {
    expect(readWords("ocean river")).toEqual({ error: "That is 2 words — an invite is 6." });
    const wrong = readWords("ocean river cannon orbit mango zzzz");
    expect("error" in wrong && wrong.error).toContain('"zzzz"');
    // too short to be known by its prefix
    expect("error" in readWords("oce river cannon orbit mango fever")).toBe(true);
  });

  test("an IPv6 address goes in a URL in brackets", () => {
    expect(urlHost("fd7a:115c:a1e0::1")).toBe("[fd7a:115c:a1e0::1]");
    expect(urlHost("10.77.0.1")).toBe("10.77.0.1");
  });
});

describe("pairing proofs", () => {
  test("agree only on the same words, certificate, numbers and side", async () => {
    const words = makeWords();
    const key = await wordsKey(words);
    expect(key).toHaveLength(32);
    expect((await wordsKey(words)).equals(key)).toBe(true);
    const [d, h] = [nonce(), nonce()];
    const mac = pairMac(key, "host", "F", d, h);
    expect(macsMatch(mac, pairMac(key, "host", "F", d, h))).toBe(true);
    // another certificate — a computer in the middle — gets another MAC
    expect(macsMatch(mac, pairMac(key, "host", "G", d, h))).toBe(false);
    expect(macsMatch(mac, pairMac(key, "device", "F", d, h))).toBe(false);
    expect(macsMatch(mac, pairMac(key, "host", "F", nonce(), h))).toBe(false);
    const other = await wordsKey(makeWords());
    expect(macsMatch(mac, pairMac(other, "host", "F", d, h))).toBe(false);
  });
});
