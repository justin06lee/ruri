import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { useMemo } from "react";

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const body = language
        ? hljs.highlight(text, { language }).value
        : escapeHtml(text);
      const label = language ? `<span class="code-lang">${language}</span>` : "";
      return (
        `<div class="codeblock">` +
        `<div class="codeblock-bar">${label}<button type="button" class="code-copy">Copy</button></div>` +
        `<pre><code class="hljs">${body}</code></pre>` +
        `</div>`
      );
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noreferrer">${text}</a>`;
    },
  },
});

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function render(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }), {
    ADD_ATTR: ["target"],
  });
}

/** Copy-button delegation: one handler for every code block in the subtree. */
function onClick(e: React.MouseEvent<HTMLDivElement>): void {
  const button = (e.target as HTMLElement).closest(".code-copy");
  if (!(button instanceof HTMLButtonElement)) return;
  const code = button.closest(".codeblock")?.querySelector("code")?.textContent ?? "";
  void navigator.clipboard.writeText(code).then(() => {
    button.textContent = "Copied";
    button.classList.add("copied");
    setTimeout(() => {
      button.textContent = "Copy";
      button.classList.remove("copied");
    }, 1200);
  });
}

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => render(text), [text]);
  // eslint-disable-next-line react/no-danger -- sanitized via DOMPurify above
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
