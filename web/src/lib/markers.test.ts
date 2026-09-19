import { describe, expect, test } from "bun:test";
import {
  MARKER_SPACE,
  backspaceHits,
  findMarkers,
  holdMarkers,
  holdMarkersAt,
  markerText,
  moveMarker,
  releaseMarkers,
  removeMarker,
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
    expect(findMarkers("[video #3] [file #4] [region #5]").map((m) => m.kind)).toEqual(["video", "file", "region"]);
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
    expect(holdMarkersAt(text, text.length)).toEqual({ text: `see ${img(1)}`, caret: text.length + 1 });
  });
});

describe("spaceMarkers", () => {
  test("a word against a chip gets one space on that side", () => {
    expect(spaceMarkers(`see${img(1)}here`).text).toBe(`see ${img(1)} here`);
  });

  test("closing punctuation may sit against a chip, an opening bracket before it", () => {
    expect(spaceMarkers(`see ${img(1)}.`).text).toBe(`see ${img(1)}.`);
    expect(spaceMarkers(`(${img(1)})`).text).toBe(`(${img(1)})`);
  });

  test("two chips are held three spaces apart", () => {
    expect(spaceMarkers(`${img(1)}${img(2)}`).text).toBe(`${img(1)}   ${img(2)}`);
    expect(spaceMarkers(`${img(1)} ${img(2)}`).text).toBe(`${img(1)}   ${img(2)}`);
  });

  test("only ever adds: space already there is left alone", () => {
    const text = `a    ${img(1)}     b`;
    expect(spaceMarkers(text).text).toBe(text);
    expect(spaceMarkers(`${img(1)}      ${img(2)}`).text).toBe(`${img(1)}      ${img(2)}`);
  });

  test("nothing is pushed into a command being written", () => {
    expect(spaceMarkers("x/compact ").text).toBe("x/compact ");
  });

  test("a space put in ahead of the caret moves it; one behind it does not", () => {
    const text = `ab${img(1)}cd`;
    // caret at the end: both spaces are ahead of it
    expect(spaceMarkers(text, text.length).caret).toBe(text.length + 2);
    // caret just after "ab": the space before the chip goes in at the caret, not before it
    expect(spaceMarkers(text, 2).caret).toBe(2);
  });

  test("text with no markers comes back as it was", () => {
    expect(spaceMarkers("plain", 3)).toEqual({ text: "plain", caret: 3 });
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
    const text = `${img(1)}   ${img(2)}   ${img(3)} done`;
    expect(stripMarkers(text, (m) => m.n === 2)).toBe(`${img(1)}   ${img(3)} done`);
    expect(stripMarkers(text, () => true)).toBe("done");
  });

  test("a backspace inside or right after a chip hits it; a command's trailing space counts too", () => {
    const text = `a ${img(1)} b`;
    const [marker] = findMarkers(text);
    expect(backspaceHits(text, marker!, marker!.start)).toBe(false);
    expect(backspaceHits(text, marker!, marker!.start + 1)).toBe(true);
    expect(backspaceHits(text, marker!, marker!.end)).toBe(true);
    expect(backspaceHits(text, marker!, marker!.end + 1)).toBe(false);
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
    expect(moved.text).toBe(`one two ${img(1)}`);
    expect(moved.caret).toBe(moved.text.length);
  });

  test("a drop inside a word lands at its nearer edge", () => {
    const text = `${img(1)} here`;
    const [marker] = findMarkers(text);
    // "here" starts at 11; 12 is between "h" and "ere": nearer the start
    const start = text.indexOf("here");
    expect(moveMarker(text, marker!, start + 1).text).toBe(`${img(1)} here`);
    // between "her" and "e": nearer the end
    expect(moveMarker(text, marker!, start + 3).text).toBe(`here ${img(1)}`);
  });

  test("dropped against another chip, the two are held apart", () => {
    const text = `${img(1)} word ${img(2)}`;
    const [first] = findMarkers(text);
    expect(moveMarker(text, first!, text.length).text).toBe(`word ${img(2)}   ${img(1)}`);
  });

  test("dropped where it already was, nothing changes", () => {
    const text = `a ${img(1)} b`;
    const [marker] = findMarkers(text);
    expect(moveMarker(text, marker!, marker!.start).text).toBe(text);
  });
});
