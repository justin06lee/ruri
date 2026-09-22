import { useEffect, useState, useSyncExternalStore } from "react";
import { type Band, defaultBand, MAX_PICTURE_BYTES, MAX_PICTURES, parseBand } from "./lib/peekBand";
import { getPref, setPref, watchPref } from "./prefs";
import { HTTP_BASE, send } from "./store";

export * from "./lib/peekBand";

/**
 * The peek band — the strip of pictures across the top of the sidebar —
 * as the user has set it up in Settings.
 *
 * It used to be five hand-cut heads placed in the tuner and baked into the
 * build (peek.ts). Those five are still what a fresh install shows, but the
 * band is the user's now: any pictures, any number up to MAX_PICTURES,
 * each placed by dragging it, each with its own hover — a motion, a second
 * picture to swap in, a GIF that plays only while the pointer is on it.
 * What a band is lives in lib/peekBand.ts; this is the window's copy of it.
 *
 * Kept as one preference (server/prefs.ts) holding a small JSON list; the
 * pictures themselves are uploads (/uploads/<file>), which the upload sweep
 * keeps for as long as the preference mentions them.
 */

const KEY = "ruri-band";

/* ── the one copy the window holds ───────────────────────────────── */

/** Read on first use, not as the module loads: this module and store.ts
 *  import each other, and the preferences are not there to read until
 *  every module in that loop has finished loading. */
let band: Band | null = null;
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function notify(): void {
  for (const listener of listeners) listener();
}

/** The band as it stands, for a handler that must not hold a stale copy. */
export function getBand(): Band {
  if (!band) {
    band = parseBand(getPref(KEY));
    // another window changed it (or the machine's copy arrived after the cache)
    watchPref(KEY, (value) => {
      band = parseBand(value);
      notify();
    });
  }
  return band;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The band as it stands, re-rendering whoever reads it when it changes. */
export function useBand(): Band {
  return useSyncExternalStore(subscribe, getBand);
}

/**
 * Change the band. On screen at once — the sidebar follows a drag in the
 * editor as it happens — and kept a moment after the last change, so a
 * drag is one write to disk rather than one per pixel.
 */
export function setBand(next: Band): void {
  getBand();
  const kept = { pictures: next.pictures.slice(0, MAX_PICTURES) };
  band = kept;
  notify();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => setPref(KEY, JSON.stringify(kept)), 400);
}

/** Back to the five heads — by forgetting the preference, which is what
 *  "default" means for one. */
export function resetBand(): void {
  getBand();
  clearTimeout(saveTimer);
  band = defaultBand();
  notify();
  setPref(KEY, "");
}

/* ── the pictures themselves ─────────────────────────────────────── */

/**
 * A picture fetched once and kept: its bytes (so a GIF can be started over
 * from its first frame by giving it a fresh URL), whether it moves, and a
 * still of its first frame for when it must not.
 */
export interface Loaded {
  blob: Blob;
  /** A URL for the bytes held here — nothing is fetched twice. */
  url: string;
  animated: boolean;
  /** The first frame, for an animated picture. */
  still?: string;
}

/** The slice of WebCodecs' ImageDecoder this needs; not every DOM lib
 *  TypeScript ships with knows it. */
interface FrameDecoder {
  tracks: { ready: Promise<void>; selectedTrack: { animated: boolean } | null };
  decode(options: {
    frameIndex: number;
  }): Promise<{ image: CanvasImageSource & { close(): void; displayWidth: number; displayHeight: number } }>;
  close(): void;
}
interface FrameDecoderClass {
  new (init: { data: ArrayBuffer; type: string }): FrameDecoder;
  isTypeSupported(type: string): Promise<boolean>;
}

async function inspect(blob: Blob): Promise<Pick<Loaded, "animated" | "still">> {
  const Decoder = (window as unknown as { ImageDecoder?: FrameDecoderClass }).ImageDecoder;
  if (!Decoder || !blob.type || !(await Decoder.isTypeSupported(blob.type))) {
    // no decoder to ask: a GIF is taken to move, and nothing can hold it still
    return { animated: blob.type === "image/gif" };
  }
  const decoder = new Decoder({ data: await blob.arrayBuffer(), type: blob.type });
  try {
    await decoder.tracks.ready;
    if (!decoder.tracks.selectedTrack?.animated) return { animated: false };
    const { image } = await decoder.decode({ frameIndex: 0 });
    const canvas = document.createElement("canvas");
    canvas.width = image.displayWidth;
    canvas.height = image.displayHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    image.close();
    const still = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    return { animated: true, ...(still ? { still: URL.createObjectURL(still) } : {}) };
  } catch {
    return { animated: blob.type === "image/gif" };
  } finally {
    decoder.close();
  }
}

const loads = new Map<string, Promise<Loaded | null>>();

/** Where a picture is fetched from: an upload lives on the server, which the
 *  dev page reaches on a port of its own; the built-in heads are the page's. */
export function pictureUrl(src: string): string {
  return src.startsWith("/uploads/") ? HTTP_BASE + src : src;
}

export function loadPicture(src: string): Promise<Loaded | null> {
  let load = loads.get(src);
  if (!load) {
    load = fetch(pictureUrl(src))
      .then((res) => (res.ok ? res.blob() : null))
      .then(async (blob) =>
        blob ? { blob, url: URL.createObjectURL(blob), ...(await inspect(blob)) } : null,
      )
      .catch(() => null);
    loads.set(src, load);
  }
  return load;
}

/** A picture, once it has loaded — null until then, or if it can't. */
export function usePicture(src: string | undefined): Loaded | null {
  const [loaded, setLoaded] = useState<{ src: string; value: Loaded | null } | null>(null);
  useEffect(() => {
    if (!src) return;
    let live = true;
    void loadPicture(src).then((value) => {
      if (live) setLoaded({ src, value });
    });
    return () => {
      live = false;
    };
  }, [src]);
  return src && loaded?.src === src ? loaded.value : null;
}

/* ── putting one in ──────────────────────────────────────────────── */

const waiting = new Map<string, (url: string | null) => void>();

/** The server's answer to a band_picture (store.ts hands it here). */
export function pictureStored(id: string, url: string | null): void {
  waiting.get(id)?.(url);
  waiting.delete(id);
}

/** An SVG is drawn out to a PNG first: a picture served back as SVG from
 *  the app's own origin would be a page, not a picture. */
async function rasterize(file: File): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = Math.max(1, 512 / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round((img.naturalWidth || 256) * scale);
    canvas.height = Math.round((img.naturalHeight || 256) * scale);
    canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("could not draw it");
    return png;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error ?? new Error("could not read it"));
    reader.readAsDataURL(blob);
  });
}

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/apng": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

/**
 * Keep a picture the user picked, and answer with the URL it is served
 * from. Throws, with something to say, when it can't be used.
 */
export async function storePicture(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not a picture`);
  if (file.size > MAX_PICTURE_BYTES) throw new Error(`${file.name} is over 25 MB`);
  const blob = file.type === "image/svg+xml" ? await rasterize(file) : file;
  const ext = EXT[blob.type];
  if (!ext) throw new Error(`${file.name} is not a kind of picture the band can show`);
  const id = crypto.randomUUID();
  const data = await base64(blob);
  const url = await new Promise<string | null>((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => pictureStored(id, null), 60_000);
    // a short name keeps the stored URL — and so the preference — small
    send({
      type: "band_picture",
      upload: { id, kind: "image", mediaType: blob.type, name: `band.${ext}`, n: 0, data },
    });
  });
  if (!url) throw new Error(`${file.name} could not be kept`);
  return url;
}
