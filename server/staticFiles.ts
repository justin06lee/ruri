/**
 * The built page, served: to this computer's window as it is, and to a
 * window on another device compressed.
 *
 * Every file goes with an ETag, so a page that already has it is answered
 * "not modified" in a few bytes — index.html above all, which is asked for
 * fresh at every launch (it names the bundle) and used to come down whole
 * every time. Over the network each file also goes compressed, brotli where
 * the window takes it and gzip where it does not: the bundle is most of a
 * megabyte of script and comes down to about a quarter of that, which is
 * the difference between a window onto another computer opening at once
 * and opening after a pause on a slow link. Each file is compressed once
 * per build and kept; this computer's own window is never sent anything
 * compressed, since zipping bytes to send over loopback only spends time.
 */
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { promisify } from "node:util";
import { mimeOf, STATIC_MIME } from "./mime.js";

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** What is worth compressing: text. Pictures and fonts are packed already. */
const COMPRESSIBLE = /\.(?:js|mjs|css|html|json|svg|map|txt|wasm)$/i;

/** One built file's compressed forms, against the copy they were made from
 *  — a rebuild under the same name (index.html) makes them again. */
interface Packed {
  stamp: string;
  br?: Promise<Buffer>;
  gzip?: Promise<Buffer>;
}
const packed = new Map<string, Packed>();

/** The file as it stands: its size and last change, which is all a build
 *  that rewrites it changes — cheaper than hashing a megabyte per request. */
function stampOf(stat: fs.Stats): string {
  return `${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}`;
}

/** Which encoding the window takes, of the two worth making. */
export function pickEncoding(accept: string | string[] | undefined): "br" | "gzip" | undefined {
  const header = (Array.isArray(accept) ? accept.join(",") : (accept ?? "")).toLowerCase();
  const takes = (name: string) =>
    header.split(",").some((part) => {
      const [token, ...params] = part.trim().split(";");
      if (token?.trim() !== name) return false;
      // "br;q=0" is a window saying no
      return !params.some((p) => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(p));
    });
  if (takes("br")) return "br";
  if (takes("gzip")) return "gzip";
  return undefined;
}

function compressed(file: string, stamp: string, data: Buffer, encoding: "br" | "gzip"): Promise<Buffer> {
  let entry = packed.get(file);
  if (entry?.stamp !== stamp) {
    entry = { stamp };
    packed.set(file, entry);
  }
  if (encoding === "br") {
    // quality 9: most of what 11 saves at a fraction of its time, made once
    entry.br ??= brotli(data, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
      },
    });
    return entry.br;
  }
  entry.gzip ??= gzip(data, { level: 9 });
  return entry.gzip;
}

/**
 * GET a built file. `network`: the request came through sharing, from a
 * window on another device — compressed, where that is worth it.
 */
export function serveStatic(
  staticDir: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  network = false,
): void {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.resolve(staticDir, rel);
  if (
    !file.startsWith(path.resolve(staticDir) + path.sep) &&
    file !== path.resolve(staticDir, "index.html")
  ) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(file, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stamp = stampOf(stat);
    const encoding =
      network && COMPRESSIBLE.test(file) ? pickEncoding(req.headers["accept-encoding"]) : undefined;
    // one tag per form of the file: a cache holding the gzip copy must not
    // be told it has the brotli one
    const etag = `"${stamp}${encoding ? `-${encoding}` : ""}"`;
    const headers: http.OutgoingHttpHeaders = {
      "content-type": mimeOf(file, STATIC_MIME),
      // the build names every asset by its contents, so one never changes
      // under its name: kept, the window's next launch takes the bundle
      // from the cache and V8 the code it compiled from it last time,
      // rather than parsing and compiling a megabyte of script again. The
      // page that names them is asked about every time — and answered
      // "not modified" when it is the same page.
      "cache-control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
      etag,
      ...(network && COMPRESSIBLE.test(file) ? { vary: "accept-encoding" } : {}),
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (!encoding) {
        res.writeHead(200, { ...headers, "content-length": data.length });
        res.end(req.method === "HEAD" ? undefined : data);
        return;
      }
      compressed(file, stamp, data, encoding).then(
        (body) => {
          res.writeHead(200, { ...headers, "content-encoding": encoding, "content-length": body.length });
          res.end(req.method === "HEAD" ? undefined : body);
        },
        () => {
          // compression failing is no reason not to serve the file
          res.writeHead(200, { ...headers, etag: `"${stamp}"`, "content-length": data.length });
          res.end(req.method === "HEAD" ? undefined : data);
        },
      );
    });
  });
}
