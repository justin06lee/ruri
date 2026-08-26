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

/** Where an upload lands on disk (pure — storeUpload does the writing). */
function uploadPath(upload: AttachmentUpload): string {
  // arbitrary files keep their own extension (browsers often report no or
  // bogus MIME types for source files), sanitized down to alphanumerics
  const nameExt = path.extname(upload.name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  const ext = EXT[upload.mediaType] ?? (nameExt || "bin");
  return path.join(uploadsDir(), `${upload.id}.${ext}`);
}

/** Persist one upload; returns its serving URL and absolute file path. */
export function storeUpload(upload: AttachmentUpload): { url: string; filePath: string } {
  fs.mkdirSync(uploadsDir(), { recursive: true });
  const filePath = uploadPath(upload);
  fs.writeFileSync(filePath, Buffer.from(upload.data, "base64"));
  return { url: `/uploads/${path.basename(filePath)}`, filePath };
}

/** Persist every upload; returns the archived attachment list (small URLs). */
export function storeAttachments(uploads: AttachmentUpload[]): Attachment[] {
  return uploads.map((upload) => {
    const { url } = storeUpload(upload);
    const { data: _data, regions: _regions, ...meta } = upload;
    return { ...meta, url };
  });
}

/**
 * The model-facing form of a prompt: images to send along, plus text
 * additions for what the model can't see directly (region crops become their
 * own images; videos and other files are referenced by their stored path —
 * call storeAttachments first so those paths exist).
 */
export function modelPayload(
  text: string,
  uploads: AttachmentUpload[],
): { text: string; images: Array<{ data: string; mediaType?: string }> } {
  const images: Array<{ data: string; mediaType?: string }> = [];
  let outText = text;
  for (const upload of uploads) {
    if (upload.kind === "image") {
      images.push({ data: upload.data, mediaType: upload.mediaType });
      (upload.regions ?? []).forEach((region, i) => {
        images.push({ data: region.data, mediaType: region.mediaType });
        outText += `\n[image #${upload.n}, region ${i + 1} — attached as its own image: the numbered white box marks the exact region, with surrounding context around it] ${region.note}`;
      });
    } else if (upload.kind === "video") {
      outText += `\n[video #${upload.n}] saved at ${uploadPath(upload)} — inspect it with tools if needed.`;
    } else {
      outText += `\n[file #${upload.n}: ${upload.name}] saved at ${uploadPath(upload)} — read it with tools if needed.`;
    }
  }
  return { text: outText, images };
}

/** Store + payload in one go — the plain non-split send path. */
export function processAttachments(
  text: string,
  uploads: AttachmentUpload[],
): { text: string; images: Array<{ data: string; mediaType?: string }>; attachments: Attachment[] } {
  const attachments = storeAttachments(uploads);
  return { ...modelPayload(text, uploads), attachments };
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
