/**
 * Markdown to HTML, the way a reply is shown: marked with ruri's own code,
 * image and link renderers, then DOMPurify over the lot — model output is
 * untrusted text, and what comes out of here goes into innerHTML. Kept
 * apart from the components (../markdown.tsx) so it can be tested, and so
 * that file exports only components.
 */
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import { Marked, type MarkedExtension, type TokenizerAndRendererExtension, type Tokens } from "marked";
import { highlightNow, known, want, worthAWorker } from "./highlighter";
import { HTTP_BASE } from "../store";

/** Fresh every time: two Marked instances must not share one options
 *  object, since each binds the renderer in it to itself. */
const options = (): MarkedExtension => ({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      // hljs is still asked which languages it knows — a registry lookup,
      // not work — but the highlighting itself goes through lib/highlighter.ts,
      // which remembers what it has done and hands the long blocks to a worker
      const language = lang && hljs.getLanguage(lang) ? lang : undefined;
      let body: string;
      let mark = "";
      if (language === undefined) {
        body = escapeHtml(text);
      } else {
        const ready = known(language, text);
        if (ready !== undefined) body = ready;
        else if (worthAWorker(text)) {
          // the plain text goes up now and is replaced where it stands the
          // moment the worker answers; until then this render is unfinished,
          // so it must not be kept as the final HTML for this reply
          mark = ` data-hl="${want(language, text)}"`;
          body = escapeHtml(text);
          partial = true;
        } else body = highlightNow(language, text);
      }
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
        `<pre><code class="hljs"${mark}>${body}</code></pre>` +
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

/**
 * A prompt's [image #1] markers, drawn as the chips the composer draws
 * them as, so a prompt reads the same once it is sent as it did while you
 * were writing it (components/Markers.tsx draws the composer's).
 *
 * An inline extension rather than a pass over the text or the HTML: marked
 * hands it only the places a marker can be a marker, so one inside a code
 * fence or a link's address stays the words it is, and everything around
 * it is escaped as it always was. The kind and number ride along on the
 * chip, for the click that opens what it stands for (../markdown.tsx).
 */
const MARKER = /^\[(image|video|file|region)[ \u00a0]#(\d+)\]/;

interface MarkerToken extends Tokens.Generic {
  kind: string;
  n: number;
}

const markerChip: TokenizerAndRendererExtension = {
  name: "marker",
  level: "inline",
  start: (src) => src.indexOf("["),
  tokenizer(src) {
    const match = MARKER.exec(src);
    if (!match) return undefined;
    return { type: "marker", raw: match[0], kind: match[1]!, n: Number(match[2]) } as MarkerToken;
  },
  renderer(token) {
    const { kind, n } = token as MarkerToken;
    // brackets kept, and made invisible, exactly as the composer's mirror
    // keeps them: they are the pill's padding, and a prompt copied out of
    // the transcript comes back with its markers whole.
    return (
      `<span class="marker-chip sent" data-kind="${kind}" data-n="${n}">` +
      `<span class="marker-bracket">[</span>${kind}\u00a0#${n}` +
      `<span class="marker-bracket">]</span></span>`
    );
  },
};

const marked = new Marked(options());
const markedWithChips = new Marked(options(), { extensions: [markerChip] });

/**
 * Set by the code renderer above while a parse leaves a block waiting on a
 * worker. Such a render is not the reply's finished HTML — the block in it
 * is plain text under a name the highlighting will be dropped into — so it
 * must not be kept as though it were. The next render of the same text
 * finds the highlighting already done and is finished, and is kept then.
 */
let partial = false;

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

export function renderMarkdown(text: string, chips = false): string {
  // the same prompt reads differently with its markers drawn as chips
  const key = chips ? `\u0000chips${text}` : text;
  const hit = cache.get(key);
  if (hit !== undefined) {
    // touch it, so the cap sheds what nobody has looked at in a while
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const html = markdownHtml(text, chips);
  if (partial) return html;
  cache.set(key, html);
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
export function markdownHtml(text: string, chips = false): string {
  // DOMPurify without a working DOM hands its input back untouched. That
  // never happens in the window, but "sanitised" must not quietly mean
  // "raw model output" anywhere this runs: fail closed, as escaped text.
  partial = false;
  if (!DOMPurify.isSupported) return `<p>${escapeHtml(text)}</p>`;
  const html = (chips ? markedWithChips : marked).parse(text, { async: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ["target"] });
}

/* ── a reply as it is being written ──────────────────────────────────── */

/**
 * A line that is blank as far as markdown is concerned.
 */
const BLANK = /^[ \t]*$/;

/** A fence opening a top-level code block: at the margin, three or more. */
const OPENS = /^(`{3,}|~{3,})/;

/**
 * Markdown that reaches backwards past a blank line — a link reference
 * definition, which anything earlier may point at, and a raw HTML block,
 * which can swallow what follows it. Neither can be rendered a piece at a
 * time, so a reply containing one is rendered whole from then on.
 */
const REACHES_BACK = /^ {0,3}(\[[^\]\n]*\]:|<)/;

/** Where a scan of a reply has got to, and what it found. */
interface Scan {
  /** How much of the text has been read. */
  at: number;
  /** Just past the blank line that closed the last top-level fence — the
   *  furthest point nothing later can change. */
  boundary: number;
  /** The fence of the block being read, while inside one. */
  fence: string | undefined;
  /** The line before was blank (or there was none). */
  afterBlank: boolean;
  /** A fence has just closed; a blank line now makes a boundary. */
  justClosed: boolean;
  /** Something that reaches backwards was seen: no more caching. */
  plain: boolean;
}

function freshScan(): Scan {
  return { at: 0, boundary: 0, fence: undefined, afterBlank: true, justClosed: false, plain: false };
}

/** Whether `line` closes `fence` — the same character, at least as many. */
function closes(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
}

/**
 * Read the complete lines of `text` that the scan has not seen yet.
 *
 * Only whole lines are read: the last one is still being written, so it is
 * left to be read again next time. What the scan is looking for is the end
 * of a fenced code block at the margin followed by a blank line — past that
 * point markdown has no construct left that can reach backwards, so
 * everything before it is finished and can be rendered once and kept.
 */
function advance(scan: Scan, text: string): void {
  const end = text.lastIndexOf("\n") + 1;
  let from = scan.at;
  while (from < end) {
    const stop = text.indexOf("\n", from);
    const line = text.slice(from, stop);
    const next = stop + 1;
    const blank = BLANK.test(line);
    if (scan.fence !== undefined) {
      if (closes(line, scan.fence)) {
        scan.fence = undefined;
        scan.justClosed = true;
      }
    } else if (scan.justClosed && blank) {
      scan.boundary = next;
      scan.justClosed = false;
    } else {
      scan.justClosed = false;
      const opening = scan.afterBlank ? OPENS.exec(line) : null;
      if (opening) scan.fence = opening[1]!;
      else if (REACHES_BACK.test(line)) {
        scan.plain = true;
        scan.at = end;
        return;
      }
    }
    scan.afterBlank = blank;
    from = next;
  }
  scan.at = end;
}

/**
 * A renderer for one reply as it is written, which does not render what it
 * has already rendered.
 *
 * The server lets a reply through a finished paragraph at a time
 * (server/paragraphs.ts), and every one of those used to re-parse the whole
 * reply, re-highlight every code block in it and sanitise the lot — so a
 * reply of n paragraphs cost n², and the code blocks near its start were
 * highlighted once for every paragraph that came after them.
 *
 * Here the finished part is rendered once. A closed fence at the margin
 * followed by a blank line is a point nothing later can reach back past, so
 * the HTML up to there is kept and only what has arrived since is rendered
 * and appended. Each piece is a whole number of top-level blocks, sanitised
 * on its own, so the result is the same HTML the whole-text render gives.
 *
 * Text that stops extending what was rendered (a rewind, an edit) starts
 * the renderer over, and a reply holding something that reaches backwards
 * is rendered whole from that moment on.
 */
export function createStreamingMarkdown(): (text: string) => string {
  /** The text already rendered into `html`. */
  let source = "";
  let html = "";
  let scan = freshScan();

  return (text: string): string => {
    if (!text.startsWith(source)) {
      source = "";
      html = "";
      scan = freshScan();
    }
    if (scan.plain) return markdownHtml(text);
    // A carriage return can still turn out to be half of a CRLF, and a byte
    // order mark at a boundary would be stripped from a piece though it sits
    // inside the whole. Neither is worth a special case.
    const tail = text.slice(source.length);
    if (tail.includes("\r") || tail.includes("﻿")) {
      scan.plain = true;
      return markdownHtml(text);
    }
    advance(scan, text);
    if (scan.plain) {
      // whatever reaches backwards may reach into what was kept
      source = "";
      html = "";
      return markdownHtml(text);
    }
    if (scan.boundary > source.length) {
      const piece = markdownHtml(text.slice(source.length, scan.boundary));
      // a piece still waiting on a worker is not kept: keeping it would
      // write the plain block back over the highlighting when the next
      // paragraph arrives. It is rendered again below, and kept next time,
      // by which point the highlighting is known.
      if (!partial) {
        html += piece;
        source = text.slice(0, scan.boundary);
      }
    }
    return html + markdownHtml(text.slice(source.length));
  };
}
