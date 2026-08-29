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

/**
 * Where an upload lands on disk (pure — storeUpload does the writing).
 *
 * The id keeps it unique; the file's own name rides along so the path the
 * model is handed says what it is opening. Anything awkward in the name is
 * flattened to a dash, and it is trimmed, because this ends up in a prompt.
 */
function uploadPath(upload: AttachmentUpload): string {
  // arbitrary files keep their own extension (browsers often report no or
  // bogus MIME types for source files), sanitized down to alphanumerics
  const nameExt = path.extname(upload.name).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  const ext = EXT[upload.mediaType] ?? (nameExt || "bin");
  const stem = path
    .basename(upload.name, path.extname(upload.name))
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return path.join(uploadsDir(), `${upload.id}${stem ? `-${stem}` : ""}.${ext}`);
}

/** Absolute on-disk path of a stored upload, from its /uploads/<file> URL. */
export function storedFilePath(url: string): string {
  return path.join(uploadsDir(), path.basename(url));
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
 * The two forms of a prompt: the one the model reads and the one the user
 * wrote.
 *
 * Images (and the region crops cut from them) travel as pictures, so their
 * [image #1] marker is a reference to something the model can see and both
 * forms keep it. A video or any other file travels as a path — the model
 * only ever gets to open it — so in the model's copy the marker IS that
 * path, sitting in the sentence where it was written rather than as a
 * footnote under it. The user's copy keeps the marker, with the attachment
 * shown beneath the prompt as always. (Call storeAttachments first so the
 * paths exist.)
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
      // a region rides as its own image with its number drawn on it, so the
      // [region #n] the user wrote needs no explaining in their own prompt
      for (const region of upload.regions ?? []) {
        images.push({ data: region.data, mediaType: region.mediaType });
      }
      continue;
    }
    const marker = `[${upload.kind} #${upload.n}]`;
    const filePath = uploadPath(upload);
    if (outText.includes(marker)) {
      outText = outText.replaceAll(marker, filePath);
    } else {
      // the marker was edited away (or never typed): the file still has to
      // be findable, so it goes at the end the way it always did
      const verb = upload.kind === "video" ? "inspect" : "read";
      outText += `\n[${upload.kind} #${upload.n}: ${upload.name}] saved at ${filePath} — ${verb} it with tools if needed.`;
    }
  }
  return { text: outText, images };
}

/** Store + payload in one go — the plain non-split send path. The user's own
 *  wording comes back untouched as `display`, for the transcript. */
export function processAttachments(
  text: string,
  uploads: AttachmentUpload[],
): {
  text: string;
  display: string;
  images: Array<{ data: string; mediaType?: string }>;
  attachments: Attachment[];
} {
  const attachments = storeAttachments(uploads);
  return { ...modelPayload(text, uploads), display: text, attachments };
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
