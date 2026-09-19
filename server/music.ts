/**
 * Music library: a directory of folders, where each folder is a playlist and
 * loose files at the top level are "Unsorted" — no playlist file format, no
 * state to corrupt. Ported from justin06lee/home (src/main/music.ts); ruri
 * serves tracks over its own HTTP server instead of a Electron protocol,
 * which keeps everything same-origin (see /music/* in routes.ts).
 */
import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Playlist, Track } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";
import { AUDIO_MIME, mimeOf } from "./mime.js";

/** What counts as a track: whatever the server knows how to serve. */
const AUDIO_EXT: ReadonlySet<string> = new Set(Object.keys(AUDIO_MIME));

/** Where the library lives when the user hasn't pointed it elsewhere. */
export function defaultMusicDir(): string {
  return process.env["RURI_MUSIC_DIR"] ?? path.join(os.homedir(), "Music", "ruri");
}

/** Only files under the music dir are ever served. */
export function isAllowed(target: string, root: string = defaultMusicDir()): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Strip leading track numbers and separators: "03 - Rain.mp3" -> "Rain". */
function prettyTitle(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, "")
    .replace(/[_]+/g, " ")
    .trim();
}

function tracksIn(dir: string): Track[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (!isMissing(err)) warn("music", err, "tracksIn");
    return [];
  }
  const tracks: Track[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (name.startsWith(".")) continue;
    if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch (err) {
      if (!isMissing(err)) warn("music", err, "tracksIn");
      continue;
    }
    tracks.push({
      id: full,
      title: prettyTitle(name),
      filename: name,
      url: `/music/track?p=${encodeURIComponent(full)}`,
    });
  }
  return tracks;
}

const README = `Drop music in here.

Each folder in this directory becomes a playlist in ruri's music player.
Files sitting loose at the top level are grouped as "Unsorted".

    ruri/
      Rain/
        01 - Distant Thunder.mp3
        02 - Window.mp3
      Piano/
        Nocturne.m4a

Supported: mp3, m4a, mp4, aac, flac, wav, ogg, opus, webm.
`;

export function scan(root: string = defaultMusicDir()): Playlist[] {
  try {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "README.txt"), README);
    }
  } catch (err) {
    warn("music", err, "scan");
    return [];
  }

  const playlists: Playlist[] = [];

  const loose = tracksIn(root);
  if (loose.length) playlists.push({ id: root, name: "Unsorted", tracks: loose });

  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    if (!isMissing(err)) warn("music", err, "scan");
    return playlists;
  }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    const full = path.join(root, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch (err) {
      if (!isMissing(err)) warn("music", err, "scan");
      continue;
    }
    const tracks = tracksIn(full);
    if (tracks.length) playlists.push({ id: full, name: name.replace(/_/g, " "), tracks });
  }
  return playlists;
}

/**
 * The desktop app is same-origin, but the vite dev server (:5173) is not —
 * and a cross-origin MediaElementSource without CORS taints the Web Audio
 * graph into silence (crossfading needs gain nodes). Permissive headers on
 * the music routes keep dev mode working.
 */
export const MUSIC_CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "Content-Length, Content-Range, Accept-Ranges",
};

/**
 * Streams one audio file, honouring Range requests so seeking in a long track
 * is instant. Only paths inside the music dir are served (isAllowed).
 */
export function serveTrack(req: http.IncomingMessage, res: http.ServerResponse, root: string): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const filePath = url.searchParams.get("p") ?? "";
  if (!filePath || !isAllowed(filePath, root)) {
    res.writeHead(403, MUSIC_CORS);
    res.end();
    return;
  }
  let size: number;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    size = stat.size;
  } catch (err) {
    if (!isMissing(err)) warn("server", err, "serveTrack");
    res.writeHead(404, MUSIC_CORS);
    res.end();
    return;
  }

  const type = mimeOf(filePath, AUDIO_MIME);
  const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range?.trim() ?? "");

  if (match && (match[1] !== "" || match[2] !== "")) {
    let start: number;
    let end: number;
    if (match[1] !== "") {
      start = Number(match[1]);
      end = match[2] !== "" ? Math.min(Number(match[2]), size - 1) : size - 1;
    } else {
      start = Math.max(0, size - Number(match[2])); // suffix form: bytes=-500
      end = size - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { ...MUSIC_CORS, "content-range": `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...MUSIC_CORS,
      "content-type": type,
      "content-length": end - start + 1,
      "content-range": `bytes ${start}-${end}/${size}`,
      "accept-ranges": "bytes",
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...MUSIC_CORS, "content-type": type, "content-length": size, "accept-ranges": "bytes" });
  fs.createReadStream(filePath).pipe(res);
}
