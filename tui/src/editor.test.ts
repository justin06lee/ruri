import { describe, expect, test } from "bun:test";
import * as editor from "./editor";

const typed = (text: string) => editor.insert(editor.EMPTY, text);

describe("the prompt box", () => {
  test("typing, and taking it back", () => {
    let e = typed("hello");
    e = editor.backspace(e);
    expect(e).toEqual({ text: "hell", caret: 4 });
    e = editor.insert(editor.left(editor.left(e)), "X");
    expect(e.text).toBe("heXll");
  });

  test("backspace joins two lines", () => {
    const e = editor.backspace(editor.home(typed("one\ntwo")));
    expect(e).toEqual({ text: "onetwo", caret: 3 });
  });

  test("a whole character goes at once: an emoji, a syllable", () => {
    expect(editor.backspace(typed("a👍🏽")).text).toBe("a");
    expect(editor.backspace(typed("한국")).text).toBe("한");
    expect(editor.left(typed("a👍🏽")).caret).toBe(1);
  });

  test("words", () => {
    const e = typed("alpha beta  gamma");
    expect(editor.wordLeft(e).caret).toBe(12);
    expect(editor.deleteWord(e).text).toBe("alpha beta  ");
    expect(editor.wordRight({ ...e, caret: 0 }).caret).toBe(5);
  });

  test("a line's ends, and all before the caret gone", () => {
    const e = { text: "one\ntwo three", caret: 8 };
    expect(editor.home(e).caret).toBe(4);
    expect(editor.end(e).caret).toBe(13);
    expect(editor.killToStart(e)).toEqual({ text: "one\nthree", caret: 4 });
  });

  test("pasted text keeps its lines, on one kind of newline", () => {
    expect(typed("a\r\nb\rc\td").text).toBe("a\nb\nc  d");
  });

  test("it wraps by columns, and a wide character is two", () => {
    const lay = editor.layout(typed("abcdefgh"), 5);
    expect(lay.lines).toEqual(["abcde", "fgh"]);
    expect(lay).toMatchObject({ row: 1, col: 3 });
    const wide = editor.layout(typed("한국어입니다"), 6);
    expect(wide.lines).toEqual(["한국어", "입니다"]);
    expect(wide).toMatchObject({ row: 1, col: 6 });
  });

  test("an empty box is one empty line, and a trailing newline a new one", () => {
    expect(editor.layout(editor.EMPTY, 10)).toEqual({ lines: [""], row: 0, col: 0 });
    expect(editor.layout(typed("a\n"), 10)).toEqual({ lines: ["a", ""], row: 1, col: 0 });
  });

  test("up and down keep the column, and say when there is no such row", () => {
    const e = typed("abcdef\nxy\nlonger line");
    const up = editor.vertical(e, 20, -1)!;
    expect(up.caret).toBe(9); // the end of "xy": as near as that row has
    const top = editor.vertical(up, 20, -1)!;
    expect(top.caret).toBe(2);
    expect(editor.vertical(top, 20, -1)).toBeUndefined();
    expect(editor.vertical(e, 20, 1)).toBeUndefined();
  });
});
