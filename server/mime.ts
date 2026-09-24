import * as path from "node:path";

/**
 * Every content type ruri serves, in one place. Four files each kept a
 * table of their own; the image list in particular was written twice and
 * had drifted once. Keys carry the dot, as path.extname gives them.
 */

/** The built web UI's files (serveStatic). */
export const STATIC_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

/** Pictures a tool read or a reply drew (serveReadFile, sessions.ts). */
export const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
};

/** The extensions that count as an image, by the table above. */
export const IMAGE_EXTS: ReadonlySet<string> = new Set(Object.keys(IMAGE_MIME));

/* Chromium (Electron) ships proprietary codecs, so AAC/MP3 play everywhere;
   Opus/Vorbis/FLAC/WAV come free. */
export const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".webm": "audio/webm",
};

/** What an upload is saved as, by the type the composer sent it with. */
export const UPLOAD_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

/** How an upload is served back, by the extension it was saved with. A
 *  picture saved under its own name's extension (its type was one the table
 *  above lacks) is still served as one: as octet-stream it would not draw. */
export const UPLOAD_MIME: Record<string, string> = {
  ...IMAGE_MIME,
  ...Object.fromEntries(Object.entries(UPLOAD_EXT).map(([mime, ext]) => [`.${ext}`, mime])),
  // preview types for common "file" attachments; anything else streams as
  // octet-stream (the viewer fetches text previews itself, so that's fine)
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
};

/** A file's content type from one of the tables, or octet-stream. */
export function mimeOf(file: string, table: Record<string, string>): string {
  return table[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}
