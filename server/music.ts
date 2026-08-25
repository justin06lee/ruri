/**
 * Music library: a directory of folders, where each folder is a playlist and
 * loose files at the top level are "Unsorted" — no playlist file format, no
 * state to corrupt. Ported from justin06lee/home (src/main/music.ts); ruri
 * serves tracks over its own HTTP server instead of a Electron protocol,
 * which keeps everything same-origin (see /music/* in server.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Playlist, Track } from "../shared/protocol.js";

/* Chromium (Electron) ships proprietary codecs, so AAC/MP3 play everywhere;
   Opus/Vorbis/FLAC/WAV come free. */
const AUDIO_EXT = new Set([
  ".mp3", ".m4a", ".mp4", ".aac", ".flac", ".wav", ".ogg", ".oga", ".opus", ".webm",
]);

export const MIME: Record<string, string> = {
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

export function musicDir(): string {
  return process.env["RURI_MUSIC_DIR"] ?? path.join(os.homedir(), "Music", "ruri");
}

/** Only files under the music dir are ever served. */
export function isAllowed(target: string): boolean {
  const rel = path.relative(path.resolve(musicDir()), path.resolve(target));
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
  } catch {
    return [];
  }
  const tracks: Track[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    if (name.startsWith(".")) continue;
    if (!AUDIO_EXT.has(path.extname(name).toLowerCase())) continue;
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
    } catch {
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

export function scan(): Playlist[] {
  const root = musicDir();
  try {
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(root, "README.txt"), README);
    }
  } catch {
    return [];
  }

  const playlists: Playlist[] = [];

  const loose = tracksIn(root);
  if (loose.length) playlists.push({ id: root, name: "Unsorted", tracks: loose });

  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return playlists;
  }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".")) continue;
    const full = path.join(root, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const tracks = tracksIn(full);
    if (tracks.length) playlists.push({ id: full, name: name.replace(/_/g, " "), tracks });
  }
  return playlists;
}
