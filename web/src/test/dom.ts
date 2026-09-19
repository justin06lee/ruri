/**
 * A window for the web tests that need one (DOMPurify, Range, modules that
 * read `location` or `document` as they load). Import it first. A module
 * that binds to `window` the moment it loads — DOMPurify does — must then
 * be imported dynamically, after this has run: bun evaluates a CommonJS
 * dependency while linking, ahead of the ES module bodies, so a static
 * import would see no window at all. Registering twice is harmless.
 *
 * jsdom, not happy-dom: DOMPurify is tested against jsdom upstream, and
 * under happy-dom it mangles its input (drops <p>, keeps <script>), which
 * would make the sanitiser tests meaningless.
 */
import { JSDOM } from "jsdom";

const g = globalThis as Record<string, unknown>;

if (!g.window) {
  const { window } = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    url: "http://localhost:5173/",
    pretendToBeVisual: true,
  });
  // Everything the window has that this runtime does not — document, the
  // element classes, Range, NodeFilter, DOMParser — made global, the way
  // a module running in the page sees them. `window` is among them.
  for (const key of Object.getOwnPropertyNames(window)) {
    if (key in globalThis) continue;
    Object.defineProperty(globalThis, key, {
      configurable: true,
      get: () => (window as unknown as Record<string, unknown>)[key],
    });
  }
}
