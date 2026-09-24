import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Animate } from "./lib/effects";
import { isAwake, subscribeAwake } from "./lib/awake";
import { HTTP_BASE, send } from "./store";

/**
 * The user's own pictures, wherever the app shows them — the peek band
 * (band.ts): kept as uploads, fetched once, and
 * known to move or not, with a still of the first frame for one that does.
 * And which of its frames a picture should be showing: moving, held still,
 * or started over from the top because the pointer just arrived.
 */

/** A picture bigger than this is not an ornament. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;

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

/** The server's answer to a store_picture (store.ts hands it here). */
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
 * from. `kind` names the file (band.gif) — short, since the URL
 * lands in a preference. Throws, with something to say, when it can't be
 * used.
 */
export async function storePicture(file: File, kind: "band"): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error(`${file.name} is not a picture`);
  if (file.size > MAX_PICTURE_BYTES) throw new Error(`${file.name} is over 25 MB`);
  const blob = file.type === "image/svg+xml" ? await rasterize(file) : file;
  const ext = EXT[blob.type];
  if (!ext) throw new Error(`${file.name} is not a kind of picture ruri can show`);
  const id = crypto.randomUUID();
  const data = await base64(blob);
  const url = await new Promise<string | null>((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => pictureStored(id, null), 60_000);
    send({
      type: "store_picture",
      upload: { id, kind: "image", mediaType: blob.type, name: `${kind}.${ext}`, n: 0, data },
    });
  });
  if (!url) throw new Error(`${file.name} could not be kept`);
  return url;
}

/* ── which frame to show ─────────────────────────────────────────── */

export function useAwake(): boolean {
  return useSyncExternalStore(subscribeAwake, isAwake);
}

/** A fresh URL for a picture's bytes while `on` — a new URL is a new
 *  image, so a GIF given one starts again from its first frame. */
function usePlay(loaded: Loaded | null, on: boolean): string | undefined {
  const url = useMemo(() => (on && loaded ? URL.createObjectURL(loaded.blob) : undefined), [on, loaded]);
  // let go of the last one as soon as it is off the screen
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

/**
 * What a picture shows right now: itself; the hover picture while `hot`,
 * played from its first frame if it moves; for one that moves, its first
 * frame while it is set to hold still, waiting for the pointer, or the
 * window is out of use (nothing on it moves then — lib/awake.ts).
 */
export function useShown(
  picture: { src: string; hoverSrc?: string; animate: Animate },
  hot: boolean,
): string {
  const awake = useAwake();
  const art = usePicture(picture.src);
  const swap = usePicture(picture.hoverSrc);
  const playing =
    hot &&
    (picture.hoverSrc ? Boolean(swap?.animated) : Boolean(art?.animated) && picture.animate === "hover");
  const played = usePlay(picture.hoverSrc ? swap : art, playing);
  if (hot && picture.hoverSrc) return played ?? swap?.url ?? pictureUrl(picture.hoverSrc);
  if (playing) return played ?? art?.url ?? pictureUrl(picture.src);
  if (art?.animated && art.still && (picture.animate !== "always" || !awake)) return art.still;
  return art?.url ?? pictureUrl(picture.src);
}

/** A picture held still, whatever it is: a thumbnail, a ghost. */
export function useStill(src: string): string {
  const art = usePicture(src);
  return art?.still ?? art?.url ?? pictureUrl(src);
}
