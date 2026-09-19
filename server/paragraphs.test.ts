import { describe, expect, test } from "bun:test";
import { ParagraphGate } from "./paragraphs.js";

/** Stream `reply` through a gate `chunk` characters at a time; what came out, in order. */
function stream(reply: string, chunk: number): string[] {
  const gate = new ParagraphGate();
  const out: string[] = [];
  for (let i = 0; i < reply.length; i += chunk) {
    const piece = gate.push(reply.slice(i, i + chunk));
    if (piece) out.push(piece);
  }
  const rest = gate.flush();
  if (rest) out.push(rest);
  return out;
}

describe("ParagraphGate", () => {
  test("releases a paragraph at its blank line and keeps the rest", () => {
    const gate = new ParagraphGate();
    expect(gate.push("First para")).toBe("");
    expect(gate.push("graph.\n")).toBe("");
    expect(gate.push("\nSecond")).toBe("First paragraph.\n\n");
    expect(gate.flush()).toBe("Second");
  });

  test("nothing is lost, whatever the chunk size", () => {
    const reply = "One.\n\nTwo, over\ntwo lines.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nThree.";
    for (const chunk of [1, 3, 7, 64, 10_000]) {
      expect(stream(reply, chunk).join("")).toBe(reply);
    }
  });

  test("a blank line inside a code block does not split the block", () => {
    const reply = "```\nline\n\nline\n```\n\nafter";
    for (const chunk of [1, 4, 100]) {
      const out = stream(reply, chunk);
      // the whole block arrives in one piece, never cut at its inner blank line
      expect(out[0]).toStartWith("```\nline\n\nline\n```\n");
      expect(out.join("")).toBe(reply);
    }
  });

  test("a closing fence must match the opening one", () => {
    const gate = new ParagraphGate();
    // a shorter run of backticks is content, not a close
    expect(gate.push("````\n``\n\n")).toBe("");
    expect(gate.push("````\n")).toBe("````\n``\n\n````\n");
  });

  test("a tilde fence is closed only by tildes", () => {
    const gate = new ParagraphGate();
    expect(gate.push("~~~\ncode\n```\n\n")).toBe("");
    expect(gate.push("~~~\n")).toBe("~~~\ncode\n```\n\n~~~\n");
  });

  test("a lone blank line after a code block waits for the next paragraph", () => {
    const gate = new ParagraphGate();
    expect(gate.push("```\nx\n```\n")).toBe("```\nx\n```\n");
    expect(gate.push("\n")).toBe("");
    expect(gate.push("tail\n\n")).toBe("\ntail\n\n");
  });

  test("flush returns whatever was held and resets", () => {
    const gate = new ParagraphGate();
    gate.push("```\nopen block");
    expect(gate.flush()).toBe("```\nopen block");
    expect(gate.flush()).toBe("");
    // the fence state is gone with the flush: a new blank line releases
    expect(gate.push("a\n\n")).toBe("a\n\n");
  });
});
