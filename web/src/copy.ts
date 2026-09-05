/**
 * Copying out of the transcript, with the shape still on it.
 *
 * A reply is markdown that has been turned into HTML, and the browser's own
 * plain-text copy walks that HTML collecting text nodes. Everything that
 * was never a text node in the first place is therefore lost: an ordered
 * list's numbers are drawn by CSS from the `<ol>`, not written anywhere, so
 * seven ranked items paste as seven unlabelled sentences and the ranking
 * they were about is gone. Bold, italics, inline code and link targets go
 * the same way, and a code block pastes with the language tag and the word
 * on its copy button mixed into the code.
 *
 * So a copy out of rendered markdown puts markdown back on the clipboard —
 * the same text the model wrote. It reads correctly as plain text and it
 * lands correctly in anything that understands markdown, which is where
 * this mostly goes: another model, a note, an issue.
 *
 * text/html is left as the browser wrote it, so pasting into a rich editor
 * still arrives styled rather than as asterisks.
 */

/** Elements that are furniture around the content, never part of it. */
const FURNITURE = ".codeblock-bar, .code-copy, .code-lang";

interface Ctx {
  range: Range;
  /** Inside a <pre>, where nothing is marked up and whitespace is content. */
  pre: boolean;
}

/** Containers whose children are blocks: the whitespace between those
 *  children is the HTML source being readable, not content. */
const LAYOUT = new Set(["UL", "OL", "TABLE", "THEAD", "TBODY", "TFOOT", "TR"]);

/** The part of a text node that is inside the selection. */
function textIn(node: Text, range: Range): string {
  const start = node === range.startContainer ? range.startOffset : 0;
  const end = node === range.endContainer ? range.endOffset : node.data.length;
  return node.data.slice(start, end);
}

/** Children of `el` that the selection reaches at all. */
function selected(el: Element, range: Range): ChildNode[] {
  return [...el.childNodes].filter((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      // a collapsed edge still "intersects"; a text node the range only
      // touches at its far end contributes nothing
      return textIn(child as Text, range).length > 0 || range.intersectsNode(child);
    }
    return range.intersectsNode(child);
  });
}

/** Everything selected inside `node`, run together. */
function inner(node: Element, ctx: Ctx): string {
  return selected(node, ctx.range)
    .map((child) => convert(child, ctx))
    .join("");
}

/** Blocks are separated by a blank line; the marks around them collapse. */
function block(text: string): string {
  return text.trim() ? `\n\n${text.trim()}\n\n` : "";
}

/** The marker an item wears: "- " in a bullet list, "3. " in a numbered
 *  one — counted from the list's own start, so copying from the middle of
 *  a ranked list keeps the ranks it had. */
function bullet(li: Element): string {
  const list = li.parentElement;
  if (!list || list.tagName !== "OL") return "- ";
  const own = li.getAttribute("value");
  if (own) return `${own}. `;
  const items = [...list.children].filter((child) => child.tagName === "LI");
  const start = Number(list.getAttribute("start") ?? "1");
  return `${start + items.indexOf(li)}. `;
}

function convert(node: ChildNode, ctx: Ctx): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = textIn(node as Text, ctx.range);
    // rendered HTML is full of newlines and runs of spaces that are only
    // there to make the source readable; inside a code block they are the
    // content
    if (ctx.pre) return text;
    if (!text.trim() && LAYOUT.has(node.parentElement?.tagName ?? "")) return "";
    return text.replace(/\s+/g, " ");
  }
  if (!(node instanceof Element)) return "";
  if (node.matches(FURNITURE)) return "";

  const tag = node.tagName;
  switch (tag) {
    case "BR":
      return "\n";
    case "HR":
      return block("---");
    case "STRONG":
    case "B": {
      const text = inner(node, ctx);
      return text.trim() ? `**${text.trim()}**` : text;
    }
    case "EM":
    case "I": {
      const text = inner(node, ctx);
      return text.trim() ? `*${text.trim()}*` : text;
    }
    case "DEL":
    case "S": {
      const text = inner(node, ctx);
      return text.trim() ? `~~${text.trim()}~~` : text;
    }
    case "CODE": {
      if (ctx.pre) return inner(node, ctx);
      const text = inner(node, ctx).trim();
      // a backtick inside the code needs a longer fence around it
      const fence = "`".repeat(Math.max(...[...text.matchAll(/`+/g)].map((m) => m[0].length), 0) + 1);
      return text ? `${fence}${text}${fence}` : "";
    }
    case "A": {
      const text = inner(node, ctx).trim();
      const href = node.getAttribute("href") ?? "";
      // a bare URL is its own label; "[url](url)" is noise
      if (!href || href === text) return text;
      return text ? `[${text}](${href})` : href;
    }
    case "IMG": {
      const src = node.getAttribute("src") ?? "";
      return src ? `![${node.getAttribute("alt") ?? ""}](${src})` : "";
    }
    case "PRE": {
      const body = inner(node, { ...ctx, pre: true }).replace(/\n+$/, "");
      if (!body.trim()) return "";
      const lang = node.closest(".codeblock")?.querySelector(".code-lang")?.textContent ?? "";
      const fence = "`".repeat(Math.max(3, ...[...body.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
      return `\n\n${fence}${lang}\n${body}\n${fence}\n\n`;
    }
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return block(`${"#".repeat(Number(tag[1]))} ${inner(node, ctx).trim()}`);
    case "BLOCKQUOTE": {
      const body = inner(node, ctx).trim();
      if (!body) return "";
      return block(body.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n"));
    }
    case "LI": {
      const body = inner(node, ctx).trim();
      if (!body) return "";
      const mark = bullet(node);
      const [first, ...rest] = body.split("\n");
      // Everything after the item's first line sits under its marker, not
      // under its bullet — which is also all the nesting a sub-list needs:
      // it arrives here as continuation lines and gets pushed in with them.
      const pad = " ".repeat(mark.length);
      return `\n${[mark + first, ...rest.map((line) => (line ? pad + line : line))].join("\n")}`;
    }
    case "UL":
    case "OL": {
      const body = inner(node, ctx).trim();
      return body ? `\n${body}\n` : "";
    }
    case "TR": {
      const cells = [...node.children]
        .filter((cell) => ctx.range.intersectsNode(cell))
        .map((cell) => convert(cell, ctx).trim().replace(/\|/g, "\\|"));
      if (cells.length === 0) return "";
      const row = `| ${cells.join(" | ")} |`;
      // the rule under the header, which markdown needs and HTML doesn't
      const head = node.parentElement?.tagName === "THEAD";
      return head ? `${row}\n| ${cells.map(() => "---").join(" | ")} |\n` : `${row}\n`;
    }
    case "TABLE":
      return block(inner(node, ctx).trim());
    case "P":
    case "DIV":
    case "SECTION":
    case "ARTICLE":
      return block(inner(node, ctx));
    default:
      return inner(node, ctx);
  }
}

/**
 * The selection, as markdown. Walks the live DOM rather than a clone of the
 * selected fragment, because a clone has forgotten where it came from: an
 * `<li>` lifted out of its list no longer knows it was the fourth one.
 */
export function markdownFromRange(range: Range): string {
  const root = range.commonAncestorContainer;
  const text =
    root.nodeType === Node.TEXT_NODE
      ? textIn(root as Text, range)
      : inner(root as Element, { range, pre: false });
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Whether this selection actually reaches rendered markdown. A selection
 *  that merely shares an ancestor with some — a drag across the ideas board
 *  while a reply sits elsewhere in the pane — is left to the browser. */
function inMarkdown(range: Range): boolean {
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return false;
  if (el.closest(".md")) return true;
  return [...el.querySelectorAll(".md")].some((md) => range.intersectsNode(md));
}

/** Put the markdown-aware copy on the document. Called once, at startup. */
export function installCopy(): void {
  document.addEventListener("copy", (e: ClipboardEvent) => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (!inMarkdown(range)) return;
    let markdown: string;
    try {
      markdown = markdownFromRange(range);
    } catch {
      // anything unexpected in the tree: leave the browser's copy alone
      return;
    }
    if (!markdown) return;
    const data = e.clipboardData;
    if (!data) return;
    // html as the browser would have written it, so a rich target still
    // pastes styled rather than as asterisks
    const holder = document.createElement("div");
    holder.append(range.cloneContents());
    e.preventDefault();
    data.setData("text/plain", markdown);
    data.setData("text/html", holder.innerHTML);
  });
}
