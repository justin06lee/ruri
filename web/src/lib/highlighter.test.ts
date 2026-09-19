import "../test/dom";
import { describe, expect, test } from "bun:test";

const { highlightNow, known, want, worthAWorker } = await import("./highlighter");
const { markdownHtml } = await import("./markdownHtml");

const CODE = "const answer: number = 42;\nfunction go() {\n  return answer;\n}\n";

describe("the highlighter", () => {
  test("a block is remembered once it has been highlighted", () => {
    expect(known("ts", CODE)).toBeUndefined();
    const html = highlightNow("ts", CODE);
    expect(html).toContain("hljs-");
    expect(known("ts", CODE)).toBe(html);
  });

  test("the same code in two languages is two blocks", () => {
    highlightNow("ts", "x = 1\n");
    expect(known("python", "x = 1\n")).toBeUndefined();
  });

  test("one block's key cannot be spelled by another", () => {
    // a length-prefixed key, so no language name and code can be split two
    // ways onto the same string
    highlightNow("js", "abc");
    expect(known("j", "sabc")).toBeUndefined();
  });

  test("a block highlight.js chokes on comes back as escaped text", () => {
    const html = highlightNow("not-a-language", "<script>x</script>");
    expect(html).toBe("&lt;script&gt;x&lt;/script&gt;");
  });

  test("a short block is never worth a worker", () => {
    expect(worthAWorker("x = 1\n")).toBe(false);
  });

  test("a block asked for is highlighted, wherever that happens", async () => {
    const code = "let waiting = true;\n" + "const x: number = 1;\n".repeat(200);
    want("ts", code);
    // a worker answers, or — where there is none to answer — it was done
    // here as the ask was made; either way it ends up known
    for (let tries = 0; tries < 200 && known("ts", code) === undefined; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(known("ts", code)).toContain("hljs-");
  });
});

describe("markdown using it", () => {
  test("a fenced block comes out highlighted", () => {
    const html = markdownHtml("```ts\n" + CODE + "```\n");
    expect(html).toContain("hljs-");
    expect(html).toContain('<span class="code-lang">ts</span>');
  });

  test("a block in no language is escaped, not highlighted", () => {
    const html = markdownHtml("```\n<b>&</b>\n```\n");
    expect(html).toContain("&lt;b&gt;&amp;&lt;/b&gt;");
    expect(html).not.toContain("hljs-");
  });

  test("rendering the same block twice gives the same HTML", () => {
    const text = "```ts\n" + CODE + "```\n";
    expect(markdownHtml(text)).toBe(markdownHtml(text));
  });

  test("the second render of a block costs nothing to highlight", () => {
    const long = "```ts\n" + "const x: number = 1;\n".repeat(400) + "```\n";
    markdownHtml(long);
    const cold = () => {
      const started = performance.now();
      markdownHtml(long);
      return performance.now() - started;
    };
    // both of these are cache hits now; what is being asserted is that a
    // repeat render is fast in absolute terms, not that it beats a miss
    expect(cold()).toBeLessThan(50);
  });
});
