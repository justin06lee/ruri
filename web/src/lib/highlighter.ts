/**
 * Who highlights a code block, and where.
 *
 * Highlighting used to happen inline, on the window's own thread, every
 * time a reply was rendered — so a transcript of a dozen code-heavy replies
 * re-ran highlight.js over every block each time it was drawn, and a long
 * block in a streaming reply was re-highlighted for every paragraph that
 * followed it.
 *
 * Two things fix that. A block that has been highlighted once is remembered,
 * keyed by its language and its text, which never change once written — so
 * the second render of a block is a map lookup. And a block long enough for
 * the work to be felt is sent to a worker (lib/highlight.worker.ts) instead
 * of being done here; the window shows the plain text it already has and the
 * highlighting is dropped in when it comes back, usually within a frame.
 *
 * Short blocks stay inline: a worker round trip costs more than highlighting
 * forty characters, and a flash of unstyled code is worse than paying for it.
 */
import hljs from "highlight.js/lib/common";

/** Blocks shorter than this are highlighted here and now. */
const INLINE_MAX = 2_000;

/** Blocks remembered. A transcript's worth of code, several times over. */
const CACHE_LIMIT = 600;

/** A worker with nothing to do for this long is let go — it is a thread and
 *  a copy of highlight.js, and a chat nobody is typing in needs neither. */
const IDLE_MS = 30_000;

/** The highlighted inner HTML of each block, by key. */
const done = new Map<string, string>();
/** Blocks asked for and not yet answered, by the name they were asked
 *  under — which is what comes back. */
const asked = new Map<string, { key: string; language: string; code: string }>();
/** A short name for each block, which is what goes in the markup: the key
 *  itself is the whole code block, too long to put in an attribute. */
const names = new Map<string, string>();
let minted = 0;

/** A block's name to itself: its language and its text, told apart by a
 *  length so no code can spell another block's key. */
function keyOf(language: string, code: string): string {
  return `${language.length}:${language}${code}`;
}

/** The highlighted HTML of this block, if it is already known. */
export function known(language: string, code: string): string | undefined {
  const key = keyOf(language, code);
  const hit = done.get(key);
  if (hit === undefined) return undefined;
  // touch it, so the cap sheds what nobody has looked at in a while
  done.delete(key);
  done.set(key, hit);
  return hit;
}

/** Highlight this block here, now, and remember it. */
export function highlightNow(language: string, code: string): string {
  let html: string;
  try {
    html = hljs.highlight(code, { language }).value;
  } catch {
    return escapeHtml(code);
  }
  remember(keyOf(language, code), html);
  return html;
}

/**
 * Ask for this block to be highlighted elsewhere, and give back the name to
 * mark it with. The escaped text goes on screen under that name, and is
 * replaced the moment the answer arrives.
 */
export function want(language: string, code: string): string {
  const key = keyOf(language, code);
  let name = names.get(key);
  if (name === undefined) {
    name = `h${(minted += 1)}`;
    names.set(key, name);
  }
  if (done.has(key) || asked.has(name)) return name;
  asked.set(name, { key, language, code });
  send(name, language, code);
  return name;
}

/** Whether a block this long should be sent away rather than done here. */
export function worthAWorker(code: string): boolean {
  return code.length >= INLINE_MAX && pool() !== undefined;
}

function remember(key: string, html: string): void {
  done.set(key, html);
  if (done.size > CACHE_LIMIT) {
    const oldest = done.keys().next().value;
    if (oldest !== undefined) {
      done.delete(oldest);
      names.delete(oldest);
    }
  }
}

/** An answer back: keep it, and put it on screen wherever it belongs. */
function arrived(id: string, html: string): void {
  const ask = asked.get(id);
  if (ask === undefined) return;
  asked.delete(id);
  // an empty answer is a block highlight.js would not take: the escaped
  // text already on screen is the right thing to leave there
  if (html === "") return;
  remember(ask.key, html);
  place(id, html);
}

/**
 * Into every copy of this block that is on screen.
 *
 * The markdown around it is already in the document as HTML (markdown.tsx
 * sets it with innerHTML), so there is nothing to re-render: the <code>
 * elements carrying this name have their contents replaced, and the same
 * block appearing in two places — a reply and the exchange it was forked
 * into — is filled in both.
 */
function place(id: string, html: string): void {
  if (typeof document === "undefined") return;
  for (const node of document.querySelectorAll(`code[data-hl="${id}"]`)) {
    node.innerHTML = html;
  }
}

/* ── the workers ─────────────────────────────────────────────────────── */

interface Pool {
  workers: Worker[];
  next: number;
  idle: number | undefined;
}

let workers: Pool | undefined | null;

/** The pool, started on first use — or undefined where there are no
 *  workers to be had (a test, an older engine), which sends every block
 *  back to being highlighted inline. */
function pool(): Pool | undefined {
  if (workers === null) return undefined;
  if (workers !== undefined) return workers;
  if (typeof Worker === "undefined") {
    workers = null;
    return undefined;
  }
  let made: Worker[];
  try {
    const cores = typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 2;
    const size = Math.max(1, Math.min(3, Math.floor(cores / 4)));
    made = Array.from({ length: size }, () => {
      const worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), {
        type: "module",
      });
      worker.onmessage = (event: MessageEvent<{ id: string; html: string }>) =>
        arrived(event.data.id, event.data.html);
      // a worker that has failed is not asked again: the next block is
      // highlighted here instead, which is slower and always works
      worker.onerror = () => retire();
      return worker;
    });
  } catch {
    workers = null;
    return undefined;
  }
  workers = { workers: made, next: 0, idle: undefined };
  return workers;
}

function send(id: string, language: string, code: string): void {
  const live = pool();
  if (live === undefined) {
    // nowhere to send it: do it here, and put it in place as an answer would
    asked.delete(id);
    place(id, highlightNow(language, code));
    return;
  }
  live.workers[live.next % live.workers.length]!.postMessage({ id, language, code });
  live.next += 1;
  restIdle(live);
}

/** Let the pool go once nothing has been asked of it for a while. */
function restIdle(live: Pool): void {
  if (live.idle !== undefined) clearTimeout(live.idle);
  live.idle = window.setTimeout(() => {
    if (workers !== live) return;
    for (const worker of live.workers) worker.terminate();
    workers = undefined;
  }, IDLE_MS);
}

function retire(): void {
  const live = workers;
  workers = null;
  if (!live) return;
  if (live.idle !== undefined) clearTimeout(live.idle);
  for (const worker of live.workers) worker.terminate();
  // whatever was in the air is redone here, so nothing is left plain
  for (const [id, ask] of asked) {
    asked.delete(id);
    place(id, highlightNow(ask.language, ask.code));
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
