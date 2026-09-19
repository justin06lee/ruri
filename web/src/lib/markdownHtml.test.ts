import "../test/dom";
import { describe, expect, test } from "bun:test";

// Dynamically, after the window exists: DOMPurify binds to `window` as it
// loads, and without one its sanitize() returns its input untouched.
const DOMPurify = (await import("dompurify")).default;
const { markdownHtml, renderMarkdown } = await import("./markdownHtml");

test("DOMPurify has a window to work with (or every check below is moot)", () => {
  expect(DOMPurify.isSupported).toBe(true);
});

/** The rendered HTML, parsed back, for asking about what is really in it. */
function parsed(html: string): HTMLElement {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  return holder;
}

/** Every attribute on every element, as "tag@name=value". */
function attributes(html: string): string[] {
  return [...parsed(html).querySelectorAll("*")].flatMap((el) =>
    [...el.attributes].map((a) => `${el.tagName.toLowerCase()}@${a.name}=${a.value}`),
  );
}

// Model output is untrusted: a reply can carry markdown or raw HTML meant
// to run script in ruri's window, which holds the server token.
describe("sanitising model output", () => {
  test("a javascript: link loses its href, and keeps its text", () => {
    for (const md of ["[click me](javascript:alert(1))", "[click me](JavaScript:alert(document.cookie))", '<a href="javascript:alert(1)">click me</a>']) {
      const html = markdownHtml(md);
      expect(html).toContain("click me");
      expect(html.toLowerCase()).not.toContain("javascript:");
    }
  });

  test("an <img onerror> keeps nothing that runs", () => {
    for (const md of ['<img src="x" onerror="alert(1)">', "<img src=x onerror=alert(1)>", "![pic](x.png)<img src=y onerror=alert(2)>"]) {
      const html = markdownHtml(md);
      expect(html).not.toContain("onerror");
      expect(attributes(html).some((a) => a.includes("@on"))).toBe(false);
    }
  });

  test("script, iframe and inline handlers are removed", () => {
    const html = markdownHtml('<script>alert(1)</script><iframe src="https://evil"></iframe><p onclick="x()">hi</p><svg onload="alert(1)"></svg>');
    const dom = parsed(html);
    expect(dom.querySelector("script, iframe")).toBeNull();
    expect(attributes(html).some((a) => a.includes("@on"))).toBe(false);
    expect(dom.textContent).toContain("hi");
  });

  test("a data: or vbscript: URL in a link is not kept", () => {
    for (const md of ["[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)", "[x](vbscript:msgbox(1))"]) {
      expect(parsed(markdownHtml(md)).querySelector("a")?.getAttribute("href") ?? null).toBeNull();
    }
  });

  test("the cached path is sanitised the same way", () => {
    const md = "cached [bad](javascript:alert(1)) <img src=x onerror=alert(1)>";
    for (const html of [renderMarkdown(md), renderMarkdown(md)]) {
      expect(html.toLowerCase()).not.toContain("javascript:");
      expect(html).not.toContain("onerror");
    }
  });
});

describe("what legitimate markdown keeps", () => {
  test("an ordinary link opens in a new window, without a referrer", () => {
    const a = parsed(markdownHtml("[docs](https://example.com/a?b=1)")).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://example.com/a?b=1");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noreferrer");
  });

  test("a local picture goes through the server's /readfile; a remote one does not", () => {
    const local = parsed(markdownHtml("![icon](./out/icon.png)")).querySelector("img")!;
    expect(local.getAttribute("src")).toContain("/readfile?p=.%2Fout%2Ficon.png");
    expect(local.getAttribute("class")).toBe("md-local");
    const remote = parsed(markdownHtml("![logo](https://example.com/logo.png)")).querySelector("img")!;
    expect(remote.getAttribute("src")).toBe("https://example.com/logo.png");
    expect(remote.hasAttribute("class")).toBe(false);
  });

  test("a code block is highlighted, labelled, and has a copy button", () => {
    const dom = parsed(markdownHtml("```ts\nconst a = 1;\n```"));
    expect(dom.querySelector(".codeblock .code-lang")?.textContent).toBe("ts");
    expect(dom.querySelector(".code-copy")).not.toBeNull();
    expect(dom.querySelector("pre code.hljs")?.textContent).toBe("const a = 1;");
  });

  test("code in an unknown language is escaped, not interpreted", () => {
    const dom = parsed(markdownHtml("```nosuchlang\n<b onclick=x>not bold</b>\n```"));
    expect(dom.querySelector("pre b")).toBeNull();
    expect(dom.querySelector("pre code")?.textContent).toBe("<b onclick=x>not bold</b>");
    expect(dom.querySelector(".code-lang")).toBeNull();
  });

  test("single line breaks are kept (gfm breaks)", () => {
    expect(parsed(markdownHtml("one\ntwo")).querySelector("br")).not.toBeNull();
  });
});
