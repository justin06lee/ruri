import { describe, expect, test } from "bun:test";
import {
  MARKER_SPACE,
  backspaceHits,
  findMarkers,
  holdMarkers,
  holdMarkersAt,
  markerSpan,
  markerText,
  moveMarker,
  releaseMarkers,
  removeMarker,
  snapSelection,
  spaceMarkers,
  stripMarkers,
} from "./markers";

const NB = String.fromCharCode(0xa0);
/** A marker the way the composer writes it: unbreakable space inside. */
const img = (n: number) => `[image${NB}#${n}]`;

describe("findMarkers", () => {
  test("attachment markers with either space inside, and where they stand", () => {
    const text = `see [image #1] and ${img(2)}`;
    const found = findMarkers(text);
    expect(found.map((m) => [m.kind, m.n, text.slice(m.start, m.end)])).toEqual([
      ["image", 1, "[image #1]"],
      ["image", 2, img(2)],
    ]);
    expect(findMarkers("[video #3] [file #4] [region #5]").map((m) => m.kind)).toEqual([
      "video",
      "file",
      "region",
    ]);
  });

  test("a command is a chip once a space follows it", () => {
    expect(findMarkers("/compact now").map((m) => [m.kind, m.text])).toEqual([["command", "/compact"]]);
    expect(findMarkers("/comm")).toEqual([]); // still being typed
  });

  test("a path, a quoted mention and a URL tail are not commands", () => {
    expect(findMarkers("/tmp/x ")).toEqual([]);
    expect(findMarkers("'/compact' ")).toEqual([]);
    expect(findMarkers("https://a.b/c ")).toEqual([]);
  });

  test("an unknown kind or a missing number is text", () => {
    expect(findMarkers("[audio #1] [image #] [image#1]")).toEqual([]);
  });
});

describe("markerText and holding/releasing", () => {
  test("the composer writes markers with the unbreakable space", () => {
    expect(MARKER_SPACE).toBe(NB);
    expect(markerText("file", 7)).toBe(`[file${NB}#7]`);
  });

  test("hold makes plain markers unbreakable; release puts plain spaces back", () => {
    expect(holdMarkers("a [image #1] b")).toBe(`a ${img(1)} b`);
    expect(releaseMarkers(`a ${img(1)} b`)).toBe("a [image #1] b");
  });

  test("the extra space between two chips goes out as one", () => {
    expect(releaseMarkers(`${img(1)}   ${img(2)}`)).toBe("[image #1] [image #2]");
    // a gap with words in it is the person's, and stays
    expect(releaseMarkers(`${img(1)}  x  ${img(2)}`)).toBe("[image #1]  x  [image #2]");
  });

  test("holdMarkersAt keeps the caret where it was relative to the text", () => {
    const text = "see[image #1]";
    expect(holdMarkersAt(text, text.length)).toEqual({ text: `see ${img(1)} `, caret: text.length + 2 });
  });
});

describe("spaceMarkers", () => {
  test("a tag has exactly one space either side", () => {
    expect(spaceMarkers(`see${img(1)}here`).text).toBe(`see ${img(1)} here`);
    expect(spaceMarkers(`see    ${img(1)}     here`).text).toBe(`see ${img(1)} here`);
    expect(spaceMarkers(`see ${img(1)}.`).text).toBe(`see ${img(1)} .`);
    expect(spaceMarkers(`see ${img(1)}`).text).toBe(`see ${img(1)} `);
  });

  test("none before a tag at the start of a line", () => {
    expect(spaceMarkers(`${img(1)} x`).text).toBe(`${img(1)} x`);
    expect(spaceMarkers(`  ${img(1)} x`).text).toBe(`${img(1)} x`);
    expect(spaceMarkers(`a\n ${img(1)} x`).text).toBe(`a\n${img(1)} x`);
  });

  test("two tags side by side keep a space each", () => {
    expect(spaceMarkers(`${img(1)}${img(2)}`).text).toBe(`${img(1)}  ${img(2)} `);
    expect(spaceMarkers(`${img(1)}      ${img(2)} `).text).toBe(`${img(1)}  ${img(2)} `);
  });

  test("nothing is pushed into a command being written; two commands are held apart", () => {
    expect(spaceMarkers("x/compact ").text).toBe("x/compact ");
    expect(spaceMarkers("/a /b ").text).toBe("/a   /b ");
  });

  test("a caret in a tag's spaces comes out on the outside", () => {
    // a space typed after the tag's own: taken back out, caret after the one
    const after = `see ${img(1)}  x`;
    expect(spaceMarkers(after, after.indexOf("x"))).toEqual({
      text: `see ${img(1)} x`,
      caret: `see ${img(1)} `.length,
    });
    // a space typed before the tag's own: caret stays left of it
    expect(spaceMarkers(`see  ${img(1)} x`, 4)).toEqual({ text: `see ${img(1)} x`, caret: 3 });
    // a word typed against the tag: the space goes in behind the caret
    const typed = `ab${img(1)}cd`;
    expect(spaceMarkers(typed, 2).caret).toBe(2);
    expect(spaceMarkers(typed, typed.length).caret).toBe(typed.length + 2);
  });

  test("text with no markers comes back as it was", () => {
    expect(spaceMarkers("plain", 3)).toEqual({ text: "plain", caret: 3 });
  });
});

describe("the caret and a tag", () => {
  const text = `see ${img(1)} here`;
  const markers = findMarkers(text);
  const span = markerSpan(text, markers[0]!);

  test("a tag's span is the tag and its two spaces", () => {
    expect(span).toEqual({ start: 3, end: 3 + img(1).length + 2 });
  });

  test("a click inside goes to the nearer edge; left of the left space when it's between space and tag", () => {
    expect(snapSelection(text, markers, 4, 4, null)).toEqual({ start: 3, end: 3 });
    expect(snapSelection(text, markers, span.end - 1, span.end - 1, null)).toEqual({ start: span.end, end: span.end });
  });

  test("a step in from either side goes straight through", () => {
    expect(snapSelection(text, markers, 4, 4, 3)).toEqual({ start: span.end, end: span.end });
    expect(snapSelection(text, markers, span.end - 1, span.end - 1, span.end)).toEqual({ start: 3, end: 3 });
  });

  test("outside a tag, nothing moves; a selection ending in one takes it whole", () => {
    expect(snapSelection(text, markers, 3, 3, 2)).toBeNull();
    expect(snapSelection(text, markers, span.end, span.end, null)).toBeNull();
    expect(snapSelection(text, markers, 0, 6, null)).toEqual({ start: 0, end: span.end });
  });

  test("a backspace after the right space, or a delete before the left, takes the whole of it", () => {
    expect(backspaceHits(text, markers[0]!, span.end)).toBe(true);
    expect(backspaceHits(text, markers[0]!, span.start)).toBe(false);
  });
});

describe("removing markers", () => {
  test("removeMarker takes the chip and the space after it", () => {
    const text = `a ${img(1)} b`;
    const [marker] = findMarkers(text);
    expect(removeMarker(text, marker!)).toEqual({ text: "a b", caret: 2 });
  });

  test("at the end of the prompt, the space before it goes instead", () => {
    const text = `a ${img(1)}`;
    const [marker] = findMarkers(text);
    expect(removeMarker(text, marker!)).toEqual({ text: "a", caret: 1 });
  });

  test("stripMarkers drops the ones asked for and resettles the spacing", () => {
    const text = `${img(1)}  ${img(2)}  ${img(3)} done`;
    expect(stripMarkers(text, (m) => m.n === 2)).toBe(`${img(1)}  ${img(3)} done`);
    expect(stripMarkers(text, () => true)).toBe("done");
  });

  test("a backspace inside or right after a chip hits it; a command's trailing space counts too", () => {
    const text = `a ${img(1)} b`;
    const [marker] = findMarkers(text);
    expect(backspaceHits(text, marker!, marker!.start - 1)).toBe(false);
    expect(backspaceHits(text, marker!, marker!.start)).toBe(true);
    expect(backspaceHits(text, marker!, marker!.end + 1)).toBe(true);
    expect(backspaceHits(text, marker!, marker!.end + 2)).toBe(false);
    const cmd = "/compact ";
    const [command] = findMarkers(cmd);
    expect(backspaceHits(cmd, command!, command!.end + 1)).toBe(true);
  });
});

describe("moveMarker", () => {
  test("picked up with its space and put down with one either side", () => {
    const text = `${img(1)} one two`;
    const [marker] = findMarkers(text);
    const moved = moveMarker(text, marker!, text.length);
    expect(moved.text).toBe(`one two ${img(1)} `);
    expect(moved.caret).toBe(moved.text.length);
  });

  test("a drop inside a word lands at its nearer edge", () => {
    const text = `${img(1)} here`;
    const [marker] = findMarkers(text);
    // "here" starts at 11; 12 is between "h" and "ere": nearer the start
    const start = text.indexOf("here");
    expect(moveMarker(text, marker!, start + 1).text).toBe(`${img(1)} here`);
    // between "her" and "e": nearer the end
    expect(moveMarker(text, marker!, start + 3).text).toBe(`here ${img(1)} `);
  });

  test("dropped against another chip, the two are held apart", () => {
    const text = `${img(1)} word ${img(2)}`;
    const [first] = findMarkers(text);
    expect(moveMarker(text, first!, text.length).text).toBe(`word ${img(2)}  ${img(1)} `);
  });

  test("dropped where it already was, nothing changes", () => {
    const text = `a ${img(1)} b`;
    const [marker] = findMarkers(text);
    expect(moveMarker(text, marker!, marker!.start).text).toBe(text);
  });
});
