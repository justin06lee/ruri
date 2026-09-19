import "./test/dom";
import { afterEach, describe, expect, test } from "bun:test";
import { markdownFromRange } from "./copy";

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

/** Rendered markdown on the page, as the transcript would have it. */
function mount(html: string): HTMLElement {
  host = document.createElement("div");
  host.className = "md";
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

/** Everything inside `el`, selected. */
function all(el: Node): Range {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range;
}

describe("markdownFromRange", () => {
  test("inline marks come back as markdown", () => {
    const el = mount(
      '<p><strong>bold</strong>, <em>it</em>, <del>gone</del>, <code>x()</code> and <a href="https://a.b">a link</a></p>',
    );
    expect(markdownFromRange(all(el))).toBe("**bold**, *it*, ~~gone~~, `x()` and [a link](https://a.b)");
  });

  test("a bare URL is its own label", () => {
    const el = mount('<p><a href="https://a.b">https://a.b</a></p>');
    expect(markdownFromRange(all(el))).toBe("https://a.b");
  });

  test("inline code with a backtick in it gets a longer fence", () => {
    const el = mount("<p><code>a`b</code></p>");
    expect(markdownFromRange(all(el))).toBe("``a`b``");
  });

  test("an ordered list keeps its numbers, counted from its start", () => {
    const el = mount('<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>');
    expect(markdownFromRange(all(el))).toBe("3. three\n4. four");
  });

  test("copying from the middle of a ranked list keeps the ranks it had", () => {
    const el = mount("<ol><li>one</li><li>two</li><li>three</li></ol>");
    const items = el.querySelectorAll("li");
    const range = document.createRange();
    range.setStart(items[1]!.firstChild!, 0);
    range.setEnd(items[2]!.firstChild!, 5);
    expect(markdownFromRange(range)).toBe("2. two\n3. three");
  });

  test("a nested list sits under its item's text", () => {
    const el = mount("<ul><li>outer<ul><li>inner</li></ul></li></ul>");
    expect(markdownFromRange(all(el))).toBe("- outer\n  - inner");
  });

  test("a code block comes back fenced with its language, without the copy button", () => {
    const el = mount(
      '<div class="codeblock"><div class="codeblock-bar"><span class="code-lang">ts</span><button class="code-copy">Copy</button></div><pre><code class="hljs">const a = 1;\n  indented\n</code></pre></div>',
    );
    expect(markdownFromRange(all(el))).toBe("```ts\nconst a = 1;\n  indented\n```");
  });

  test("headings, quotes and rules", () => {
    const el = mount("<h2>Title</h2><blockquote><p>quoted</p></blockquote><hr><p>after</p>");
    expect(markdownFromRange(all(el))).toBe("## Title\n\n> quoted\n\n---\n\nafter");
  });

  test("a table gets its header rule, and a pipe in a cell is escaped", () => {
    const el = mount(
      "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1|2</td><td>3</td></tr></tbody></table>",
    );
    expect(markdownFromRange(all(el))).toBe("| a | b |\n| --- | --- |\n| 1\\|2 | 3 |");
  });

  test("a selection inside one text node is just that text", () => {
    const el = mount("<p>hello world</p>");
    const text = el.querySelector("p")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 6);
    range.setEnd(text, 11);
    expect(markdownFromRange(range)).toBe("world");
  });

  test("the source's layout whitespace does not leak into the copy", () => {
    const el = mount("<p>one\n   two</p>\n\n\n<p>three</p>");
    expect(markdownFromRange(all(el))).toBe("one two\n\nthree");
  });
});
