import { BrowserWindow, type NativeImage } from "electron";
import type { ShotTarget } from "../server/shots.js";

/**
 * Photographing another project.
 *
 * The half of the component sweep a server cannot do: the server knows
 * which class name a component sets, and only a browser knows where that
 * lands on screen. This loads the project's own page in a window nobody
 * sees, finds each selector, and captures the rectangle around it.
 *
 * The other half — starting the project's dev server and finding the
 * address it prints — is in server/shots.ts, which wraps this.
 *
 * Two things keep it honest. It refuses a picture of nothing: an element
 * that is on the page but collapsed, empty, or off in a corner captures as
 * a flat rectangle of background, and an entry with a blank screenshot
 * pinned to it is worse than one with none. And when a selector isn't on
 * the page the app boots to, it walks the app's own links looking for it —
 * links only, never buttons, because clicking unknown buttons in someone's
 * running app is how you find out what their delete confirmation looks
 * like. Anything a click reveals gets photographed when the entry says
 * which click (the page's "on screen" field takes a whole path).
 */

/** The window the pictures are taken in. Big enough that a desktop layout
 *  lays itself out as one, and never shown. */
const PREVIEW_SIZE = { width: 1440, height: 900 };
/** How long a freshly loaded page gets to settle before it is photographed. */
const PREVIEW_SETTLE_MS = 1400;
/** Room left around a component, so it isn't cropped to its own edge. */
const SHOT_PAD = 10;
/** How many of the app's own pages to look through for what wasn't on the
 *  first one. */
const CRAWL_PAGES = 8;
/** A capture this uniform is a picture of a background, not of a thing. */
const FLAT_RATIO = 0.985;
/** A page that hasn't loaded by now is not going to. */
const LOAD_TIMEOUT_MS = 20_000;
/** The whole pass, at the outside. A sweep that never finishes holds the
 *  project's dev server open behind it, so this has an end. */
const BUDGET_MS = 5 * 60_000;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Find one thing on the page and say where it is, in the coordinates
 * capturePage wants. Runs inside the project's page, so it says nothing
 * about ruri and can assume nothing about the project.
 */
function locateScript(selector: string): string {
  return `(async () => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    try { await document.fonts.ready; } catch {}
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return null;
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  })()`;
}

/** The app's own pages, as it links to them itself. */
const LINKS_SCRIPT = `(() => {
  const here = location.origin;
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    let url;
    try { url = new URL(a.getAttribute("href"), location.href); } catch { continue; }
    if (url.origin !== here) continue;
    if (url.pathname === location.pathname) continue;
    seen.add(url.origin + url.pathname);
  }
  return [...seen];
})()`;

/** Whether a capture is all one colour — a picture of nothing. */
function isFlat(image: NativeImage): boolean {
  const { width, height } = image.getSize();
  if (width < 8 || height < 8) return true;
  const bitmap = image.toBitmap();
  const pixels = Math.floor(bitmap.length / 4);
  if (pixels === 0) return true;
  // every 37th pixel: enough of a spread to catch a page of text, cheap
  // enough to run on a full-window capture
  const step = Math.max(1, Math.floor(pixels / 1200));
  const first = bitmap.readUInt32LE(0);
  let same = 0;
  let looked = 0;
  for (let at = 0; at < pixels; at += step) {
    looked += 1;
    if (bitmap.readUInt32LE(at * 4) === first) same += 1;
  }
  return same / looked >= FLAT_RATIO;
}

/** Photograph one selector on the page as it stands. */
async function shoot(win: BrowserWindow, selector: string): Promise<string | undefined> {
  let rect: Rect | null = null;
  try {
    rect = (await win.webContents.executeJavaScript(locateScript(selector), true)) as Rect | null;
  } catch {
    return undefined;
  }
  if (!rect) return undefined;
  const x = Math.max(0, Math.floor(rect.x - SHOT_PAD));
  const y = Math.max(0, Math.floor(rect.y - SHOT_PAD));
  const box = {
    x,
    y,
    width: Math.min(PREVIEW_SIZE.width - x, Math.ceil(rect.width + SHOT_PAD * 2)),
    height: Math.min(PREVIEW_SIZE.height - y, Math.ceil(rect.height + SHOT_PAD * 2)),
  };
  if (box.width < 8 || box.height < 8) return undefined;
  try {
    const image = await win.webContents.capturePage(box);
    if (image.isEmpty() || isFlat(image)) return undefined;
    return image.toPNG().toString("base64");
  } catch {
    // the page navigated under us — the next target reloads anyway
    return undefined;
  }
}

/** Load a page and give it a moment. A load that hangs — a dev server that
 *  accepted the connection and then thought about it — gives up rather than
 *  holding the sweep open behind it. */
async function open(win: BrowserWindow, href: string): Promise<boolean> {
  try {
    const loaded = await Promise.race([
      win.loadURL(href).then(() => true),
      sleep(LOAD_TIMEOUT_MS).then(() => false),
    ]);
    if (!loaded) return false;
  } catch {
    return false;
  }
  await sleep(PREVIEW_SETTLE_MS);
  return true;
}

/**
 * Load a project's own page in a window nobody sees and photograph the
 * elements ruri was given selectors for. Answers component id to base64
 * PNG, with nothing at all for the ones it couldn't find.
 */
export async function captureTargets(url: string, targets: ShotTarget[]): Promise<Record<string, string>> {
  const win = new BrowserWindow({
    ...PREVIEW_SIZE,
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  const shots: Record<string, string> = {};
  const missing = new Map(targets.map((target) => [target.id, target]));
  const until = Date.now() + BUDGET_MS;
  try {
    let loaded: string | undefined;
    let dirty = false;
    for (const target of targets) {
      if (Date.now() > until) break;
      const href = target.route ? new URL(target.route, url).toString() : url;
      // a target that clicked its way on screen left the page somewhere
      // else; the next one starts from a page that has just loaded
      if (href !== loaded || dirty) {
        if (!(await open(win, href))) continue;
        loaded = href;
        dirty = false;
      }
      for (const click of target.clicks ?? []) {
        dirty = true;
        try {
          await win.webContents.executeJavaScript(
            `document.querySelector(${JSON.stringify(click)})?.click()`,
            true,
          );
          await sleep(400);
        } catch {
          // a click that misses just means the thing may not be up
        }
      }
      const shot = await shoot(win, target.selector);
      if (!shot) continue;
      shots[target.id] = shot;
      missing.delete(target.id);
    }

    // Whatever the app's front page didn't hold, look for on the pages the
    // app links to. Cheap: one load each, then every outstanding selector
    // checked against it.
    if (missing.size > 0) {
      if (loaded !== url) await open(win, url);
      let links: string[] = [];
      try {
        links = ((await win.webContents.executeJavaScript(LINKS_SCRIPT, true)) as string[]).slice(
          0,
          CRAWL_PAGES,
        );
      } catch {
        links = [];
      }
      for (const link of links) {
        if (missing.size === 0 || Date.now() > until) break;
        if (!(await open(win, link))) continue;
        for (const [id, target] of [...missing]) {
          const shot = await shoot(win, target.selector);
          if (!shot) continue;
          shots[id] = shot;
          missing.delete(id);
        }
      }
    }
  } finally {
    win.destroy();
  }
  return shots;
}
