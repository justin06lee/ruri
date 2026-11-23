/**
 * Markdown for a terminal: a reply's text as lines no wider than the pane,
 * styled with ANSI. Blocks are laid out here (headings, lists, quotes,
 * code, tables, rules); the words inside them are wrapped by wrap-ansi,
 * which counts a CJK character as the two columns it takes.
 */
import { marked, type Token, type Tokens } from "marked";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { paint } from "./theme";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const plain = (text: string) => text.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

/** A line cut to fit, its styles closed. */
export function wrap(text: string, width: number, hard = true): string[] {
  if (width <= 0) return [];
  return wrapAnsi(text, width, { hard, trim: true }).split("\n");
}

/** Preformatted text: nothing trimmed, long lines broken where they must. */
function wrapCode(text: string, width: number): string[] {
  return text
    .split("\n")
    .flatMap((line) =>
      line === "" ? [""] : wrapAnsi(line, width, { hard: true, trim: false, wordWrap: false }).split("\n"),
    );
}

function inline(tokens: Token[] | undefined): string {
  if (!tokens) return "";
  return tokens
    .map((token): string => {
      switch (token.type) {
        case "strong":
          return paint.bold(inline((token as Tokens.Strong).tokens));
        case "em":
          return paint.italic(inline((token as Tokens.Em).tokens));
        case "del":
          return paint.strike(inline((token as Tokens.Del).tokens));
        case "codespan":
          return paint.code(plain((token as Tokens.Codespan).text));
        case "br":
          return "\n";
        case "link": {
          const link = token as Tokens.Link;
          const text = inline(link.tokens);
          const bare = link.href.replace(/^mailto:/, "");
          return text === bare || text === link.href
            ? paint.underline(text)
            : `${paint.underline(text)} ${paint.soft(`(${link.href})`)}`;
        }
        case "image":
          return paint.soft(`[image: ${(token as Tokens.Image).text || (token as Tokens.Image).href}]`);
        case "text": {
          const text = token as Tokens.Text;
          return text.tokens ? inline(text.tokens) : plain(text.text);
        }
        case "escape":
          return plain((token as Tokens.Escape).text);
        default:
          return plain("raw" in token ? String(token.raw) : "");
      }
    })
    .join("");
}

function table(token: Tokens.Table, width: number): string[] {
  const head = token.header.map((cell) => inline(cell.tokens));
  const body = token.rows.map((row) => row.map((cell) => inline(cell.tokens)));
  const widths = head.map((cell, i) =>
    Math.max(stringWidth(cell), ...body.map((row) => stringWidth(row[i] ?? ""))),
  );
  const total = widths.reduce((sum, w) => sum + w, 0) + (widths.length - 1) * 3;
  // too wide to stand as columns: each row as its own short list
  if (total > width) {
    return body.flatMap((row, r) => [
      ...(r > 0 ? [""] : []),
      ...row.flatMap((cell, i) => wrap(`${paint.soft(`${head[i] ?? ""}:`)} ${cell}`, width)),
    ]);
  }
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell + " ".repeat(Math.max(0, widths[i]! - stringWidth(cell))))
      .join(paint.soft(" │ "));
  return [
    line(head.map((cell) => paint.bold(cell))),
    paint.soft(widths.map((w) => "─".repeat(w)).join("─┼─")),
    ...body.map(line),
  ];
}

function blocks(tokens: Token[], width: number, tight = false): string[] {
  const out: string[] = [];
  /** One blank line between blocks, never two, never one at the top; none
   *  at all inside a tight list's item. */
  const gap = () => {
    if (!tight && out.length > 0 && out[out.length - 1] !== "") out.push("");
  };
  for (const token of tokens) {
    switch (token.type) {
      case "space":
      case "checkbox":
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        gap();
        const text = paint.bold(inline(heading.tokens));
        out.push(...wrap(heading.depth <= 2 ? paint.accent(text) : text, width));
        break;
      }
      case "paragraph":
        gap();
        out.push(...wrap(inline((token as Tokens.Paragraph).tokens), width));
        break;
      case "text": {
        // a list item's own line: no gap of its own
        const text = token as Tokens.Text;
        out.push(...wrap(text.tokens ? inline(text.tokens) : plain(text.text), width));
        break;
      }
      case "code": {
        gap();
        const code = token as Tokens.Code;
        if (code.lang) out.push(paint.soft(`┌ ${code.lang}`));
        out.push(
          ...wrapCode(code.text, Math.max(1, width - 2)).map(
            (line) => `${paint.soft("│")} ${paint.code(line)}`,
          ),
        );
        break;
      }
      case "blockquote":
        gap();
        out.push(
          ...blocks((token as Tokens.Blockquote).tokens, Math.max(1, width - 2)).map(
            (line) => `${paint.soft("▎")} ${paint.soft(line)}`,
          ),
        );
        break;
      case "list": {
        const list = token as Tokens.List;
        gap();
        const start = typeof list.start === "number" ? list.start : 1;
        list.items.forEach((item, i) => {
          const bullet = item.task ? (item.checked ? "☑" : "☐") : list.ordered ? `${start + i}.` : "•";
          const pad = " ".repeat(stringWidth(bullet) + 1);
          const lines = blocks(item.tokens, Math.max(1, width - pad.length), !list.loose);
          // a loose list keeps its gaps inside an item, not before its first line
          while (lines[0] === "") lines.shift();
          lines.forEach((line, n) =>
            out.push(n === 0 ? `${paint.soft(bullet)} ${line}` : line && `${pad}${line}`),
          );
        });
        break;
      }
      case "hr":
        gap();
        out.push(paint.soft("─".repeat(Math.min(width, 40))));
        break;
      case "table":
        gap();
        out.push(...table(token as Tokens.Table, width));
        break;
      default:
        gap();
        out.push(...wrap(plain("raw" in token ? String(token.raw).trimEnd() : ""), width));
    }
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out;
}

/** A reply's markdown as terminal lines, `width` columns at most. */
export function markdownLines(text: string, width: number): string[] {
  if (!text.trim()) return [];
  return blocks(marked.lexer(text), Math.max(8, width));
}
