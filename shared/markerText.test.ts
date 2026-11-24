import { describe, expect, test } from "bun:test";
import { plainMarkers } from "./markerText.js";

describe("plainMarkers", () => {
  test("a marker's unbreakable space becomes a plain one", () => {
    expect(plainMarkers("see [image\u00a0#1] and [file\u00a0#12] and [region\u00a0#3]")).toBe(
      "see [image #1] and [file #12] and [region #3]",
    );
  });

  test("anything else is left as it is", () => {
    expect(plainMarkers("[image #1] stays")).toBe("[image #1] stays");
    // an unbreakable space that is nobody's marker is the user's own
    expect(plainMarkers("10\u00a0km and [note\u00a0#1]")).toBe("10\u00a0km and [note\u00a0#1]");
    expect(plainMarkers("")).toBe("");
  });
});
