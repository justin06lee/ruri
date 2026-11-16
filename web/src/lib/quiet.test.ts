import { describe, expect, test } from "bun:test";
import { printing, span } from "./quiet";

describe("a running script, in words", () => {
  const started = 1_000_000;

  test("in its first moments, not having printed says nothing", () => {
    expect(printing(undefined, started, started + 3_000)).toBeUndefined();
    expect(printing(undefined, started, started + 60_000)).toBe("nothing printed yet");
  });

  test("printing while its last output is fresh, quiet for how long after", () => {
    expect(printing(started + 50_000, started, started + 55_000)).toBe("printing");
    expect(printing(started + 50_000, started, started + 62_000)).toBe("quiet 12s");
    expect(printing(started + 50_000, started, started + 50_000 + 185_000)).toBe("quiet 3m 05s");
    expect(printing(started + 50_000, started, started + 110_000, "quiet for")).toBe("quiet for 1m 00s");
  });

  test("a span is seconds, then minutes and seconds", () => {
    expect(span(-5)).toBe("0s");
    expect(span(59_400)).toBe("59s");
    expect(span(60_000)).toBe("1m 00s");
  });
});
