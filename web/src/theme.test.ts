import "./test/dom";
import { describe, expect, test } from "bun:test";
import { DEFAULT_SCHEDULE, themeAt, type ThemeSchedule } from "./theme";

const at = (h: number, m = 0) => h * 60 + m;

describe("themeAt", () => {
  test("each theme from the minute it takes over", () => {
    // light 05:00, dark 14:00, ember 18:00
    expect(themeAt(at(5), DEFAULT_SCHEDULE)).toBe("light");
    expect(themeAt(at(13, 59), DEFAULT_SCHEDULE)).toBe("light");
    expect(themeAt(at(14), DEFAULT_SCHEDULE)).toBe("dark");
    expect(themeAt(at(18), DEFAULT_SCHEDULE)).toBe("ember");
    expect(themeAt(at(23, 59), DEFAULT_SCHEDULE)).toBe("ember");
  });

  test("before the day's first boundary it is still the last one, from yesterday", () => {
    expect(themeAt(0, DEFAULT_SCHEDULE)).toBe("ember");
    expect(themeAt(at(4, 59), DEFAULT_SCHEDULE)).toBe("ember");
  });

  test("the order is read from the times, not from the names", () => {
    // a night owl: dark in the small hours, ember before bed, light at noon
    const owl: ThemeSchedule = { on: true, dark: at(2), light: at(12), ember: at(22) };
    expect(themeAt(at(1), owl)).toBe("ember");
    expect(themeAt(at(3), owl)).toBe("dark");
    expect(themeAt(at(12), owl)).toBe("light");
    expect(themeAt(at(22, 30), owl)).toBe("ember");
  });

  test("two themes on the same minute: the later one in the list wins it", () => {
    const tie: ThemeSchedule = { on: true, light: at(8), dark: at(8), ember: at(20) };
    expect(themeAt(at(9), tie)).toBe("dark");
  });
});
