import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * Small copies of the component library's pictures, for its cards.
 *
 * A library's pictures are screenshots, most of them whole windows at twice
 * the screen's pixels, and a card shows one 236px wide. Loaded as they are,
 * a library of three hundred decoded some 270 million pixels and fetched
 * 23MB to draw its cards. So each is drawn small once, here, and the small
 * one is kept in the browser's cache under the picture's own address. An
 * upload never changes under its name (server/uploads.ts), so a copy made
 * once stays good.
 *
 * A picture whose file is gone answers null, and is remembered as gone, so
 * the page can say "picture missing" rather than "no picture yet", and
 * count it with the ones that need taking.
 */

/** The cache's name; a new one if the size or format below ever changes. */
const CACHE = "ruri-thumbs-1";

/** Twice a card's width, so it is sharp on a retina screen. */
const WIDTH = 560;

/** Pictures being drawn small at once. Each is a full decode. */
const AT_ONCE = 3;

/** Each picture's small copy, or null for a picture that is gone. */
const known = new Map<string, Promise<string | null>>();

/** Pictures found gone — a new set each time one more is, so whatever
 *  was made from the last one is made again — and who wants to hear. */
let gone: ReadonlySet<string> = new Set<string>();
const listeners = new Set<() => void>();

let running = 0;
const waiting: Array<() => void> = [];

async function inTurn<T>(work: () => Promise<T>): Promise<T> {
  if (running >= AT_ONCE) await new Promise<void>((go) => waiting.push(go));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function markGone(src: string): void {
  if (gone.has(src)) return;
  gone = new Set([...gone, src]);
  for (const listener of listeners) listener();
}

async function openCache(): Promise<Cache | undefined> {
  // only a secure page has one: a window on another device over plain
  // http makes its copies afresh each time it is opened
  if (typeof caches === "undefined") return undefined;
  try {
    return await caches.open(CACHE);
  } catch {
    return undefined;
  }
}

/** The picture at `src`, small enough for a card. */
async function shrink(src: string): Promise<Blob | null> {
  const res = await fetch(src);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status}`);
  const full = await res.blob();
  try {
    const bitmap = await createImageBitmap(full);
    try {
      if (bitmap.width <= WIDTH) return full;
      const height = Math.max(1, Math.round((bitmap.height * WIDTH) / bitmap.width));
      const canvas = new OffscreenCanvas(WIDTH, height);
      const pen = canvas.getContext("2d");
      if (!pen) return full;
      pen.imageSmoothingQuality = "high";
      pen.drawImage(bitmap, 0, 0, WIDTH, height);
      return await canvas.convertToBlob({ type: "image/webp", quality: 0.86 });
    } finally {
      bitmap.close();
    }
  } catch {
    // a picture the browser can't draw on a canvas (an svg without a size)
    // is shown as it is
    return full;
  }
}

async function make(src: string): Promise<string | null> {
  const cache = await openCache();
  const hit = await cache?.match(src).catch(() => undefined);
  if (hit) return URL.createObjectURL(await hit.blob());
  const small = await inTurn(() => shrink(src));
  if (!small) {
    markGone(src);
    return null;
  }
  void cache
    ?.put(src, new Response(small, { headers: { "content-type": small.type || "image/png" } }))
    .catch(() => undefined);
  return URL.createObjectURL(small);
}

/**
 * The small copy of the picture at `src`, as an address an <img> can show,
 * or null when the picture is gone. Made once per picture per window. A
 * failure that isn't the picture being gone (the server restarting, say) is
 * forgotten, so the next card to ask tries again.
 */
export function thumbOf(src: string): Promise<string | null> {
  let made = known.get(src);
  if (!made) {
    made = make(src).catch(() => {
      known.delete(src);
      return null;
    });
    known.set(src, made);
  }
  return made;
}

/** Pictures already asked after by probe(). */
const probed = new Set<string>();

/**
 * Ask after every picture in `srcs` — only whether its file is there, not
 * its bytes — so a library's counts of what needs a picture are right
 * before its cards have been scrolled to. A handful at a time, each asked
 * once per window.
 */
export async function probe(srcs: string[]): Promise<void> {
  const ask = srcs.filter((src) => !probed.has(src) && !known.has(src));
  for (const src of ask) probed.add(src);
  let next = 0;
  const one = async (): Promise<void> => {
    while (next < ask.length) {
      const src = ask[next++]!;
      try {
        const res = await fetch(src, { method: "HEAD" });
        if (res.status === 404) markGone(src);
      } catch {
        // not reachable just now: the card will find out for itself
        probed.delete(src);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, ask.length) }, one));
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The pictures (by address) found gone so far in this window. */
export function useGone(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => gone);
}

/**
 * The first of `srcs` that is still there, drawn small: undefined while it
 * is being looked for (or until `wanted`), null when none of them is. Its
 * index says which it was, so a card showing an older picture can say so.
 */
export function useThumb(srcs: string[], wanted: boolean): { src: string | null | undefined; index: number } {
  const key = srcs.join("\n");
  const [found, setFound] = useState<{ key: string; src: string | null; index: number }>();
  useEffect(() => {
    if (!wanted || !key) return;
    let live = true;
    void (async () => {
      const list = key.split("\n");
      for (let i = 0; i < list.length; i += 1) {
        const src = await thumbOf(list[i]!);
        if (!live) return;
        if (src) {
          setFound({ key, src, index: i });
          return;
        }
      }
      if (live) setFound({ key, src: null, index: -1 });
    })();
    return () => {
      live = false;
    };
  }, [key, wanted]);
  if (!key) return { src: null, index: -1 };
  if (found?.key !== key) return { src: undefined, index: -1 };
  return { src: found.src, index: found.index };
}
