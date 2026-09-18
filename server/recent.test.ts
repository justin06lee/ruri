import { describe, expect, test } from "bun:test";
import { codexText, codexTool, humanText, titleOf } from "./recent.js";

describe("humanText", () => {
  test("takes the harness's leading tag blocks off", () => {
    expect(humanText("<system-reminder>be nice</system-reminder>\n\nfix the bug")).toBe("fix the bug");
    expect(humanText('<command-name a="1">/x</command-name><command-args></command-args>  do it')).toBe("do it");
  });

  test("only leading blocks: a tag in the middle is what the user wrote", () => {
    expect(humanText("use <b>bold</b> here")).toBe("use <b>bold</b> here");
  });

  test("a block and nothing else is nothing of the user's", () => {
    expect(humanText("<summary>everything so far</summary>")).toBe("");
    expect(humanText("   ")).toBe("");
  });

  test("a block that never closes is left as written", () => {
    expect(humanText("<open>no end")).toBe("<open>no end");
  });
});

describe("titleOf", () => {
  test("the first thing said, whitespace flattened", () => {
    expect(titleOf("<system-reminder>x</system-reminder>fix   the\n\nheader")).toBe("fix the header");
  });

  test("cut at 90 characters with an ellipsis", () => {
    const title = titleOf("word ".repeat(40));
    expect(title.length).toBe(90);
    expect(title.endsWith("…")).toBe(true);
    expect(titleOf("x".repeat(90))).toBe("x".repeat(90));
  });
});

describe("codexText", () => {
  test("joins the input and output text blocks, skipping the rest", () => {
    expect(
      codexText([
        { type: "input_text", text: "one" },
        { type: "image", url: "x" },
        { type: "output_text", text: "two" },
        null,
        { type: "input_text" },
      ]),
    ).toBe("one\ntwo");
  });

  test("a bare string is itself; anything else is empty", () => {
    expect(codexText("plain")).toBe("plain");
    expect(codexText(42)).toBe("");
    expect(codexText(undefined)).toBe("");
  });
});

describe("codexTool", () => {
  test("the exec tools are Bash, and the command is read out of the script", () => {
    expect(codexTool({ name: "exec_command", arguments: '{"cmd":"ls -la\\n  src"}' })).toEqual({ name: "Bash", summary: "ls -la src" });
    expect(codexTool({ name: "shell", arguments: JSON.stringify({ command: ["git", "status"] }) })).toEqual({
      name: "Bash",
      summary: "git status",
    });
  });

  test("other tools keep their name; unparseable input is shown as it is", () => {
    expect(codexTool({ name: "apply_patch", input: "*** Begin Patch" })).toEqual({ name: "apply_patch", summary: "*** Begin Patch" });
    expect(codexTool({ input: 3 })).toEqual({ name: "tool", summary: "" });
  });

  test("a long summary is cut at 200 characters", () => {
    const { summary } = codexTool({ name: "exec", input: JSON.stringify({ cmd: "echo " + "a".repeat(400) }) });
    expect(summary.length).toBe(200);
    expect(summary.endsWith("…")).toBe(true);
  });
});
