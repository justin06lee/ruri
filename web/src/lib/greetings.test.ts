import { describe, expect, test } from "bun:test";
import {
  cleanGreetings,
  DEFAULT_GREETINGS,
  GREETING_CHARS,
  greetingsFromText,
  MAX_GREETINGS,
  parseGreetings,
  pickGreeting,
} from "./greetings";

describe("parseGreetings", () => {
  test("nothing kept anywhere says sup.", () => {
    expect(parseGreetings(null)).toEqual(["sup."]);
    expect(parseGreetings(null, null)).toEqual([...DEFAULT_GREETINGS]);
    expect(parseGreetings("{nope", "also nope")).toEqual(["sup."]);
  });

  test("a list under its own key is what is said", () => {
    expect(parseGreetings(JSON.stringify(["hey", "yo"]))).toEqual(["hey", "yo"]);
  });

  test("the hero face's greetings carry over until a list of their own is kept", () => {
    const hero = JSON.stringify({ show: true, mode: "random", faces: [], greetings: ["gm", "wb"] });
    expect(parseGreetings(null, hero)).toEqual(["gm", "wb"]);
    expect(parseGreetings(JSON.stringify(["hi"]), hero)).toEqual(["hi"]);
    // a hero kept before greetings were part of it
    expect(parseGreetings(null, JSON.stringify({ show: false }))).toEqual(["sup."]);
  });

  test("an empty list is kept as one: no title on Home", () => {
    expect(parseGreetings("[]")).toEqual([]);
    expect(parseGreetings(null, JSON.stringify({ greetings: [] }))).toEqual([]);
  });

  test("lines come trimmed, clipped, and no more than fit", () => {
    const kept = JSON.stringify(["  sup.  ", "", 42, "x".repeat(200), ...Array(30).fill("more")]);
    const lines = parseGreetings(kept);
    expect(lines.slice(0, 2)).toEqual(["sup.", "x".repeat(GREETING_CHARS)]);
    expect(lines).toHaveLength(MAX_GREETINGS);
  });
});

describe("greetingsFromText", () => {
  test("one to a line, blanks dropped", () => {
    expect(greetingsFromText("hey\n\n  yo \n")).toEqual(["hey", "yo"]);
    expect(greetingsFromText("")).toEqual([]);
    expect(cleanGreetings([" a ", null, "b"])).toEqual(["a", "b"]);
  });
});

describe("pickGreeting", () => {
  test("one line is always said; several take turns by the launch's roll", () => {
    expect(pickGreeting(["sup."], 0.73)).toBe("sup.");
    const several = ["a", "b", "c", "d"];
    expect(pickGreeting(several, 0)).toBe("a");
    expect(pickGreeting(several, 0.3)).toBe("b");
    expect(pickGreeting(several, 0.99)).toBe("d");
    expect(pickGreeting([], 0.5)).toBe("");
  });
});
