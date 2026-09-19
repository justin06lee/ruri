/**
 * Markdown to HTML, the way a reply is shown: marked with ruri's own code,
 * image and link renderers, then DOMPurify over the lot — model output is
 * untrusted text, and what comes out of here goes into innerHTML. Kept
 * apart from the components (../markdown.tsx) so it can be tested, and so
 * that file exports only components.
 */
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked } from "marked";
import { HTTP_BASE } from "../store";

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      const body = language ? hljs.highlight(text, { language }).value : escapeHtml(text);
      const label = language ? `<span class="code-lang">${language}</span>` : "";
      const svgAttrs =
        `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ` +
        `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;
      const copyButton =
        `<button type="button" class="code-copy" title="Copy code" aria-label="Copy code">` +
        `<svg class="ic-copy" ${svgAttrs}><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>` +
        `<svg class="ic-check" ${svgAttrs}><path d="M20 6L9 17l-5-5"/></svg>` +
        `</button>`;
      return (
        `<div class="codeblock">` +
        `<div class="codeblock-bar">${label}${copyButton}</div>` +
        `<pre><code class="hljs">${body}</code></pre>` +
        `</div>`
      );
    },
    // A picture the model points at by path — the icon it just drew, a
    // screenshot it took — is a file on this machine, which a page cannot
    // open by itself: it goes through the server's /read, which serves the
    // paths a reply has named (server.ts allowReadImages) and nothing else.
    // Relative paths are the project's; the server resolves them.
    image({ href, title, text }) {
      const local = !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("/readfile?");
      const src = local ? `${HTTP_BASE}/readfile?p=${encodeURIComponent(href)}` : href;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${titleAttr}${local ? ' class="md-local"' : ""}>`;
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

/**
 * Rendered markdown, kept across mounts.
 *
 * Parsing and highlighting a reply costs a few milliseconds, and a session
 * switch used to pay it again for every message on screen — the useMemo
 * below only lives as long as the component does, and switching sessions
 * unmounts all of them. Transcript text never changes once written, so the
 * text itself is the key: coming back to a session you've already read
 * re-renders from strings that are already HTML.
 */
const CACHE_LIMIT = 1200;
const cache = new Map<string, string>();

export function renderMarkdown(text: string): string {
  const hit = cache.get(text);
  if (hit !== undefined) {
    // touch it, so the cap sheds what nobody has looked at in a while
    cache.delete(text);
    cache.set(text, hit);
    return hit;
  }
  const html = markdownHtml(text);
  cache.set(text, html);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return html;
}

/**
 * Render ahead of being asked, while the app has nothing better to do — the
 * work lands in the cache and the switch that needs it is already paid for.
 */
export function prewarmMarkdown(text: string): void {
  if (text && !cache.has(text)) renderMarkdown(text);
}

/**
 * Markdown as sanitised HTML, uncached — for a reply still being written,
 * whose half-finished versions must not push finished ones out of the
 * cache. Everything that renders markdown goes through here.
 */
export function markdownHtml(text: string): string {
  // DOMPurify without a working DOM hands its input back untouched. That
  // never happens in the window, but "sanitised" must not quietly mean
  // "raw model output" anywhere this runs: fail closed, as escaped text.
  if (!DOMPurify.isSupported) return `<p>${escapeHtml(text)}</p>`;
  return DOMPurify.sanitize(marked.parse(text, { async: false }), { ADD_ATTR: ["target"] });
}
