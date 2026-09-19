import { describe, expect, test } from "bun:test";
import { score } from "./fuzzy";

/** The names, best first, that answer at all. */
const rank = (query: string, names: string[]) =>
  names
    .map((name) => ({ name, s: score(query, name) }))
    .filter((r) => r.s !== null)
    .sort((a, b) => b.s! - a.s!)
    .map((r) => r.name);

describe("score", () => {
  test("an empty query matches everything equally", () => {
    expect(score("", "anything")).toBe(0);
  });

  test("a prefix beats a word start, which beats a substring, which beats letters in order", () => {
    const prefix = score("fr", "frontend")!;
    const word = score("fr", "the frontend")!;
    const inside = score("ro", "frontend")!;
    const scattered = score("fnd", "frontend")!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(inside);
    expect(inside).toBeGreaterThan(scattered);
  });

  test("words split on spaces, slashes, dots, dashes and underscores", () => {
    for (const name of ["a b", "a/b", "a.b", "a-b", "a_b"]) expect(score("b", name)).toBe(800 - name.length);
  });

  test("case does not matter", () => {
    expect(score("FRONT", "frontend")).toBe(score("front", "Frontend"));
  });

  test("shorter names win ties", () => {
    expect(rank("ruri", ["ruri-desktop", "ruri"])).toEqual(["ruri", "ruri-desktop"]);
  });

  test("each gap in an in-order match costs: 'fui' finds Frontend UI first", () => {
    expect(rank("fui", ["Frontend UI", "fabulous unicorn index"])[0]).toBe("Frontend UI");
    expect(score("fui", "Frontend UI")).toBe(300 - 1 * 20 - "frontend ui".length);
  });

  test("letters out of order, or missing, are no match", () => {
    expect(score("xyz", "frontend")).toBeNull();
    expect(score("dnf", "frontend")).toBeNull();
  });
});
