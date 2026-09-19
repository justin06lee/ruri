/// <reference lib="webworker" />
/**
 * Syntax highlighting, off the window's own thread.
 *
 * highlight.js walks a code block character by character against a pile of
 * regular expressions, which for a long block is milliseconds the window
 * spends doing nothing else — and a reply full of code pays it for every
 * block at once, in the middle of a turn, while a dragon is animating and
 * a transcript is scrolling. Here it is somebody else's thread.
 *
 * The answer is the inner HTML of the <code> element, exactly what
 * `hljs.highlight().value` gives, for lib/highlighter.ts to put in place.
 */
import hljs from "highlight.js/lib/common";

export interface HighlightAsk {
  id: string;
  language: string;
  code: string;
}

export interface HighlightAnswer {
  id: string;
  /** Empty when the block could not be highlighted: the escaped text the
   *  window already has on screen stays. */
  html: string;
}

self.onmessage = (event: MessageEvent<HighlightAsk>) => {
  const { id, language, code } = event.data;
  let html = "";
  try {
    html = hljs.highlight(code, { language }).value;
  } catch {
    // an unknown language, a block that trips the grammar: leave it plain
  }
  (self as unknown as Worker).postMessage({ id, html } satisfies HighlightAnswer);
};
