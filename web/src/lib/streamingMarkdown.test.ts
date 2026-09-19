import "../test/dom";
import { describe, expect, test } from "bun:test";

// after the window exists, as markdownHtml.test.ts does: DOMPurify binds to
// `window` as it loads, and without one its sanitize() hands back its input
const { createStreamingMarkdown, markdownHtml } = await import("./markdownHtml");

/** Every prefix of `text` that ends a line, then the whole thing — a reply
 *  arriving the way the server lets one through (server/paragraphs.ts). */
function arrivals(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") out.push(text.slice(0, i + 1));
  if (out.at(-1) !== text) out.push(text);
  return out;
}

/**
 * The thing that has to be true of every reply: rendered a piece at a time,
 * it ends up as exactly the HTML rendering it whole would give — at every
 * step along the way, not only at the end.
 */
function agreesAllTheWayThrough(text: string): void {
  const render = createStreamingMarkdown();
  for (const so_far of arrivals(text)) {
    expect(render(so_far)).toBe(markdownHtml(so_far));
  }
}

const FENCED = `Here is the plan.

\`\`\`ts
const answer = 42;
function go(): number {
  return answer;
}
\`\`\`

And then some prose about it.

\`\`\`sh
echo hello
\`\`\`

Done.
`;

describe("createStreamingMarkdown", () => {
  test("a plain reply renders as the whole-text render does", () => {
    agreesAllTheWayThrough("One paragraph.\n\nAnd a second one.\n\n- a\n- b\n");
  });

  test("a reply with code blocks agrees at every step", () => {
    agreesAllTheWayThrough(FENCED);
  });

  test("a reply of nothing but a fence agrees", () => {
    agreesAllTheWayThrough("```\nplain\n```\n\nafter\n");
  });

  test("tilde fences agree too", () => {
    agreesAllTheWayThrough("~~~py\nprint(1)\n~~~\n\ndone\n");
  });

  test("a fence inside a list is not taken for a boundary", () => {
    agreesAllTheWayThrough("- one\n\n  ```\n  code\n  ```\n\n- two\n\nafter\n");
  });

  test("headings, tables and quotes after a fence agree", () => {
    agreesAllTheWayThrough(
      "```\nx\n```\n\n## Heading\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quoted\n\nend\n",
    );
  });

  test("it does keep what it has rendered", () => {
    const render = createStreamingMarkdown();
    const upTo = "intro\n\n```ts\nconst a = 1;\n```\n\n";
    render(upTo);
    const first = render(upTo + "next paragraph.\n");
    const second = render(upTo + "next paragraph.\n\nand another.\n");
    // the kept prefix is a literal prefix of what comes out, every time
    const prefix = markdownHtml(upTo);
    expect(first.startsWith(prefix)).toBe(true);
    expect(second.startsWith(prefix)).toBe(true);
    expect(second).toBe(markdownHtml(upTo + "next paragraph.\n\nand another.\n"));
  });

  test("text that stops extending what came before starts over", () => {
    const render = createStreamingMarkdown();
    render("```\na\n```\n\nfirst version of the reply\n");
    // a rewind, an edit: nothing of the old text survives
    expect(render("something else entirely\n")).toBe(markdownHtml("something else entirely\n"));
    expect(render("something else entirely\n\nwith more\n")).toBe(
      markdownHtml("something else entirely\n\nwith more\n"),
    );
  });

  test("a link reference definition falls back to rendering the whole reply", () => {
    const text = "```\nx\n```\n\nSee [the docs][d].\n\n[d]: https://example.com\n";
    agreesAllTheWayThrough(text);
    // and the reference really did resolve, rather than being left as text
    const html = createStreamingMarkdown()(text);
    expect(html).toContain('href="https://example.com"');
  });

  test("a definition that arrives after the link it feeds still resolves", () => {
    const render = createStreamingMarkdown();
    const body = "```\nx\n```\n\nSee [the docs][d].\n";
    expect(render(body)).not.toContain("https://example.com");
    const whole = body + "\n[d]: https://example.com\n";
    expect(render(whole)).toBe(markdownHtml(whole));
    expect(render(whole)).toContain('href="https://example.com"');
  });

  test("raw HTML falls back rather than being split across pieces", () => {
    agreesAllTheWayThrough("```\nx\n```\n\n<div>\n\nstill inside?\n\n</div>\n\nafter\n");
  });

  test("a carriage return falls back", () => {
    const text = "```\nx\n```\r\n\r\nafter\r\n";
    expect(createStreamingMarkdown()(text)).toBe(markdownHtml(text));
  });

  test("rendering the same text again changes nothing", () => {
    const render = createStreamingMarkdown();
    const text = "```\nx\n```\n\nafter\n";
    const once = render(text);
    expect(render(text)).toBe(once);
    expect(render(text)).toBe(markdownHtml(text));
  });

  test("an empty reply is empty", () => {
    const render = createStreamingMarkdown();
    expect(render("")).toBe(markdownHtml(""));
  });

  test("it stops re-rendering what it has already rendered", () => {
    // the point of the whole thing: a long reply's early code blocks are
    // parsed and highlighted once, not once per paragraph that follows
    const block = "```ts\n" + "const x = 1;\n".repeat(30) + "```\n\n";
    const text = block.repeat(24);
    // the server lets a reply through a paragraph at a time, so that is the
    // granularity the two are compared at
    const arrival = text
      .split("\n\n")
      .map((_, index, parts) => parts.slice(0, index + 1).join("\n\n"))
      .filter((so_far) => so_far.length > 0);

    const whole = () => {
      const started = performance.now();
      for (const so_far of arrival) markdownHtml(so_far);
      return performance.now() - started;
    };
    const piecewise = () => {
      const render = createStreamingMarkdown();
      const started = performance.now();
      for (const so_far of arrival) render(so_far);
      return performance.now() - started;
    };
    // warm both paths so neither pays for first-call compilation
    whole();
    piecewise();
    // whole-text rendering is quadratic in the number of paragraphs and
    // this is linear, so the gap widens with the length of the reply; a
    // third is a floor this clears comfortably at two dozen code blocks
    expect(piecewise()).toBeLessThan(whole() / 3);
  });
});
