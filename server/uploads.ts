import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Attachment, AttachmentUpload } from "../shared/protocol.js";

/**
 * Prompt attachments: incoming base64 files (images, videos, pdfs, text,
 * anything) are persisted under ~/.config/ruri/uploads and served back over
 * /uploads/<file>, so transcript events carry small URLs instead of
 * megabytes of base64.
 */

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
};

const MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime])),
  // preview types for common "file" attachments; anything else streams as
  // octet-stream (the viewer fetches text previews itself, so that's fine)
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  json: "application/json",
  csv: "text/csv; charset=utf-8",
};

function uploadsDir(): string {
  return path.join(
    process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
    "uploads",
  );
}

/** Persist one upload; returns its serving URL and absolute file path. */
export function storeUpload(upload: AttachmentUpload): { url: string; filePath: string } {
  // arbitrary files keep their own extension (browsers often report no or
  // bogus MIME types for source files), sanitized down to alphanumerics
  const nameExt = path.extname(upload.name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  const ext = EXT[upload.mediaType] ?? (nameExt || "bin");
  const filename = `${upload.id}.${ext}`;
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const filePath = path.join(uploadsDir(), filename);
  fs.writeFileSync(filePath, Buffer.from(upload.data, "base64"));
  return { url: `/uploads/${filename}`, filePath };
}

/**
 * Turn wire uploads into (a) model-visible images, (b) text additions for
 * things the model can't see directly, and (c) the archived attachment list.
 */
export function processAttachments(
  text: string,
  uploads: AttachmentUpload[],
): { text: string; images: Array<{ data: string; mediaType?: string }>; attachments: Attachment[] } {
  const images: Array<{ data: string; mediaType?: string }> = [];
  const attachments: Attachment[] = [];
  let outText = text;

  for (const upload of uploads) {
    const { url, filePath } = storeUpload(upload);
    const { data: _data, regions: _regions, ...meta } = upload;
    attachments.push({ ...meta, url });

    if (upload.kind === "image") {
      images.push({ data: upload.data, mediaType: upload.mediaType });
      (upload.regions ?? []).forEach((region, i) => {
        images.push({ data: region.data, mediaType: region.mediaType });
        outText += `\n[image #${upload.n}, region ${i + 1} — attached as its own image] ${region.note}`;
      });
    } else if (upload.kind === "video") {
      outText += `\n[video #${upload.n}] saved at ${filePath} — inspect it with tools if needed.`;
    } else {
      outText += `\n[file #${upload.n}: ${upload.name}] saved at ${filePath} — read it with tools if needed.`;
    }
  }
  return { text: outText, images, attachments };
}

const CORS: Record<string, string> = { "access-control-allow-origin": "*" };

/** GET /uploads/<file> — attachment payloads for transcript previews. */
export function serveUpload(req: http.IncomingMessage, res: http.ServerResponse): void {
  const name = (req.url ?? "").replace("/uploads/", "").split("?")[0] ?? "";
  const filePath = path.join(uploadsDir(), path.basename(name));
  const ext = path.extname(filePath).slice(1);
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      ...CORS,
      "content-type": MIME[ext] ?? "application/octet-stream",
      "content-length": stat.size,
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, CORS);
    res.end();
  }
}
