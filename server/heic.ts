import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AttachmentUpload } from "../shared/protocol.js";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/**
 * HEIC, what an iPhone's camera writes: a picture to the user, and one
 * neither the window (Chromium has no decoder for it) nor the model will
 * take. So ruri turns one into a JPEG wherever it meets it — an upload on
 * its way in, a file on its way out to a window — with the system's own
 * converter: `sips` on a Mac, `heif-convert` or ImageMagick elsewhere.
 * Where none of them is there, or the file is not what its name says, the
 * original goes on as it is, the way it always did.
 */

/** Nothing is drawn wider or taller than this: a 48-megapixel photo as a
 *  JPEG is more than a prompt should carry, and the model would only
 *  shrink it again. */
const LONGEST = 4096;
const TIMEOUT_MS = 20_000;
/** How many converted files are kept for serving back. */
const CACHE_MAX = 300;

/** A HEIC or HEIF, by its name. */
export function isHeic(name: string): boolean {
  return /\.hei[cf]$/i.test(name);
}

/** A HEIC or HEIF, by the type it was sent with or by its name (a file
 *  picker often reports no type at all for one). */
export function isHeicUpload(upload: { mediaType: string; name: string }): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(upload.mediaType) || isHeic(upload.name);
}

/** The JPEG's name for a HEIC's. */
export function jpegName(name: string): string {
  return isHeic(name) ? name.replace(/\.hei[cf]$/i, ".jpg") : `${name}.jpg`;
}

type Command = [bin: string, args: string[]];

/** By its full path: an app opened from the Finder has little on its PATH,
 *  and this is where every Mac keeps it. */
const SIPS = "/usr/bin/sips";

/** sips' -Z would also blow a small picture up to the size it names, so it
 *  is only asked for when the picture is over it. */
function sipsOversized(src: string): boolean {
  try {
    const out = execFileSync(SIPS, ["-g", "pixelWidth", "-g", "pixelHeight", src], {
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sides = [...out.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]));
    return sides.some((side) => side > LONGEST);
  } catch {
    return false;
  }
}

/** The commands worth trying on this system, in order. */
function commands(src: string, dest: string): Command[] {
  if (process.platform === "darwin") {
    const fit = sipsOversized(src) ? ["-Z", String(LONGEST)] : [];
    return [[SIPS, ["-s", "format", "jpeg", "-s", "formatOptions", "85", ...fit, src, "--out", dest]]];
  }
  return [
    ["heif-convert", ["-q", "85", src, dest]],
    ["magick", [src, "-auto-orient", "-resize", `${LONGEST}x${LONGEST}>`, "-quality", "85", dest]],
  ];
}

/** True when `file` is there and starts the way a JPEG does. A converter
 *  that could not read its input can still leave an empty file behind. */
function isJpegFile(file: string): boolean {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const head = Buffer.alloc(2);
      return fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0xff && head[1] === 0xd8;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Convert one file, waiting for it. False when nothing here could. */
function convertSync(src: string, dest: string): boolean {
  for (const [bin, args] of commands(src, dest)) {
    try {
      execFileSync(bin, args, { timeout: TIMEOUT_MS, stdio: "ignore" });
      if (isJpegFile(dest)) return true;
    } catch (err) {
      // not installed is the ordinary case off a Mac: try the next one
      if (!isMissing(err)) warn("heic", err, bin);
    }
    fs.rmSync(dest, { force: true });
  }
  return false;
}

/** Convert one file without holding the server up. */
async function convert(src: string, dest: string): Promise<boolean> {
  for (const [bin, args] of commands(src, dest)) {
    const ran = await new Promise<boolean>((resolve) => {
      execFile(bin, args, { timeout: TIMEOUT_MS }, (err) => {
        if (err && !isMissing(err)) warn("heic", err, bin);
        resolve(!err);
      });
    });
    if (ran && isJpegFile(dest)) return true;
    fs.rmSync(dest, { force: true });
  }
  return false;
}

/* ── an upload on its way in ─────────────────────────────────────── */

/** The same upload asked about twice (stored, then sent to the model) is
 *  converted once. */
const converted = new WeakMap<AttachmentUpload, AttachmentUpload>();

/**
 * An upload as something a window can draw and the model can see: a HEIC
 * comes back as the JPEG of it (its type and name changed to match, the
 * rest as it was), anything else — and a HEIC nothing here could convert —
 * comes back untouched.
 */
export function drawable(upload: AttachmentUpload): AttachmentUpload {
  if (!isHeicUpload(upload)) return upload;
  const known = converted.get(upload);
  if (known) return known;
  let out = upload;
  let dir: string | undefined;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-heic-"));
    const src = path.join(dir, "in.heic");
    const dest = path.join(dir, "out.jpg");
    fs.writeFileSync(src, Buffer.from(upload.data, "base64"));
    if (convertSync(src, dest)) {
      out = {
        ...upload,
        mediaType: "image/jpeg",
        name: jpegName(upload.name),
        data: fs.readFileSync(dest).toString("base64"),
      };
    }
  } catch (err) {
    warn("heic", err, "drawable");
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
  converted.set(upload, out);
  return out;
}

/* ── a file on its way out ───────────────────────────────────────── */

function cacheDir(): string {
  return configPath("heic");
}

/** Past CACHE_MAX the oldest converted files go: each can be made again. */
function trimCache(): void {
  try {
    const dir = cacheDir();
    const files = fs.readdirSync(dir).filter((name) => name.endsWith(".jpg"));
    if (files.length <= CACHE_MAX) return;
    const aged = files
      .map((name) => ({ file: path.join(dir, name), at: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const { file } of aged.slice(0, aged.length - CACHE_MAX)) fs.rmSync(file, { force: true });
  } catch (err) {
    if (!isMissing(err)) warn("heic", err, "trimCache");
  }
}

/** One conversion per file at a time: a transcript drawn in two windows
 *  asks for the same picture twice at once. */
const running = new Map<string, Promise<string | undefined>>();
/** What could not be converted, so a picture a transcript keeps asking for
 *  is tried once, not at every draw. */
const failed = new Set<string>();

/**
 * The JPEG of a HEIC file on disk, for serving in its place: made once and
 * kept (under the config folder's heic/) for as long as the file is not
 * written again. Undefined when it is no HEIC, or nothing here could
 * convert it — the caller serves the original then.
 */
export async function jpegOf(filePath: string): Promise<string | undefined> {
  if (!isHeic(filePath)) return undefined;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  const key = createHash("sha256")
    .update(`${filePath}\n${stat.mtimeMs}\n${stat.size}`)
    .digest("hex")
    .slice(0, 32);
  const dest = path.join(cacheDir(), `${key}.jpg`);
  if (failed.has(dest)) return undefined;
  if (isJpegFile(dest)) return dest;
  const going = running.get(dest);
  if (going) return going;
  const work = (async () => {
    try {
      fs.mkdirSync(cacheDir(), { recursive: true });
      // made beside its place and moved in, so a half-written one is never served
      const part = `${dest}.${process.pid}.part.jpg`;
      if (!(await convert(filePath, part))) {
        if (failed.size > 1_000) failed.clear();
        failed.add(dest);
        return undefined;
      }
      fs.renameSync(part, dest);
      trimCache();
      return dest;
    } catch (err) {
      warn("heic", err, "jpegOf");
      return undefined;
    } finally {
      running.delete(dest);
    }
  })();
  running.set(dest, work);
  return work;
}
