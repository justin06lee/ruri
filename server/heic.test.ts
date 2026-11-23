import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { AttachmentUpload, TranscriptEvent } from "../shared/protocol.js";
import { drawable, isHeic, isHeicUpload, jpegName, jpegOf } from "./heic.js";
import { ReadableImages } from "./readable.js";
import { modelPayload, serveUpload, storeAttachments, storeUpload } from "./uploads.js";

let saved: string | undefined;
let dir: string;
/** A real HEIC, when this machine can make one (a Mac: sips writes them). */
let heic: Buffer | undefined;

beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-heic-test-"));
  process.env["RURI_CONFIG_DIR"] = dir;
  if (process.platform !== "darwin") return;
  try {
    const made = path.join(dir, "made.heic");
    const png = path.join(import.meta.dir, "..", "assets", "dragon", "calm.png");
    execFileSync("sips", ["-s", "format", "heic", png, "--out", made], { stdio: "ignore", timeout: 20_000 });
    heic = fs.readFileSync(made);
  } catch {
    heic = undefined;
  }
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (over: Partial<AttachmentUpload>): AttachmentUpload => ({
  id: "7b1d0c55",
  kind: "image",
  mediaType: "image/heic",
  name: "IMG_0042.HEIC",
  n: 1,
  data: heic?.toString("base64") ?? "",
  ...over,
});

const isJpeg = (bytes: Buffer): boolean => bytes[0] === 0xff && bytes[1] === 0xd8;

/** Width and height, as sips reads them. */
function sides(file: string): number[] {
  const out = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], { encoding: "utf8" });
  return [...out.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map((m) => Number(m[1]));
}

/** One GET against a handler, on a server of its own. */
async function get(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  url: string,
): Promise<{ status: number; type: string | null; body: Buffer }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${url}`);
    return {
      status: res.status,
      type: res.headers.get("content-type"),
      body: Buffer.from(await res.arrayBuffer()),
    };
  } finally {
    server.close();
  }
}

describe("telling a HEIC", () => {
  test("by its name, however it is cased", () => {
    expect(isHeic("IMG_0042.HEIC")).toBe(true);
    expect(isHeic("/tmp/photo.heif")).toBe(true);
    expect(isHeic("photo.jpg")).toBe(false);
    expect(isHeic("heic.png")).toBe(false);
  });

  test("by its type, or by its name when a picker gave it none", () => {
    expect(isHeicUpload({ mediaType: "image/heic", name: "photo" })).toBe(true);
    expect(isHeicUpload({ mediaType: "image/heif-sequence", name: "live" })).toBe(true);
    expect(isHeicUpload({ mediaType: "application/octet-stream", name: "IMG_1.heic" })).toBe(true);
    expect(isHeicUpload({ mediaType: "image/png", name: "shot.png" })).toBe(false);
  });

  test("its JPEG keeps its name", () => {
    expect(jpegName("IMG_0042.HEIC")).toBe("IMG_0042.jpg");
    expect(jpegName("photo")).toBe("photo.jpg");
  });
});

describe("an upload on its way in", () => {
  test("anything that is no HEIC is handed back as it came", () => {
    const png = upload({ mediaType: "image/png", name: "shot.png", data: "UE5H" });
    expect(drawable(png)).toBe(png);
  });

  test("a HEIC that is not one inside is handed back as it came", () => {
    const fake = upload({ data: "UE5H" });
    expect(drawable(fake)).toBe(fake);
  });

  test("a HEIC becomes the JPEG of it, the rest as it was", () => {
    if (!heic) return;
    const given = upload({});
    const out = drawable(given);
    expect(out.mediaType).toBe("image/jpeg");
    expect(out.name).toBe("IMG_0042.jpg");
    expect(isJpeg(Buffer.from(out.data, "base64"))).toBe(true);
    expect({ id: out.id, kind: out.kind, n: out.n }).toEqual({ id: "7b1d0c55", kind: "image", n: 1 });
    // asked again (stored, then sent to the model), it is not converted again
    expect(drawable(given)).toBe(out);
  });

  test("a small picture stays the size it was", () => {
    if (!heic) return;
    const made = path.join(dir, "made.heic");
    const { filePath } = storeUpload(upload({ id: "5a5a5a5a" }));
    expect(sides(filePath)).toEqual(sides(made));
  });

  test("it is archived and sent to the model as that JPEG", () => {
    if (!heic) return;
    const given = upload({});
    const [stored] = storeAttachments([given]);
    expect(stored).toEqual({
      id: "7b1d0c55",
      kind: "image",
      mediaType: "image/jpeg",
      name: "IMG_0042.jpg",
      n: 1,
      url: "/uploads/7b1d0c55-IMG_0042.jpg",
    });
    expect(isJpeg(fs.readFileSync(path.join(dir, "uploads", "7b1d0c55-IMG_0042.jpg")))).toBe(true);
    const out = modelPayload("what is in [image #1]?", [given]);
    expect(out.text).toBe("what is in [image #1]?");
    expect(out.images).toHaveLength(1);
    expect(out.images[0]!.mediaType).toBe("image/jpeg");
    expect(isJpeg(Buffer.from(out.images[0]!.data, "base64"))).toBe(true);
  });

  test("one a picker called a file goes to the model as the JPEG's path", () => {
    if (!heic) return;
    const given = upload({ id: "0f0f0f0f", kind: "file", mediaType: "application/octet-stream" });
    const [stored] = storeAttachments([given]);
    expect(stored!.url).toBe("/uploads/0f0f0f0f-IMG_0042.jpg");
    const out = modelPayload("open [file #1]", [given]);
    expect(out.images).toEqual([]);
    expect(out.text).toBe(`open ${path.join(dir, "uploads", "0f0f0f0f-IMG_0042.jpg")}`);
  });
});

describe("a file on its way out", () => {
  test("anything that is no HEIC, or is not there, has no JPEG", async () => {
    expect(await jpegOf(path.join(dir, "shot.png"))).toBeUndefined();
    expect(await jpegOf(path.join(dir, "gone.heic"))).toBeUndefined();
  });

  test("a HEIC that is not one inside has none either", async () => {
    const fake = path.join(dir, "fake.heic");
    fs.writeFileSync(fake, "not a picture");
    expect(await jpegOf(fake)).toBeUndefined();
  });

  test("a HEIC's JPEG is made once and kept until the file is written again", async () => {
    if (!heic) return;
    const file = path.join(dir, "kept.heic");
    fs.writeFileSync(file, heic);
    const [first, second] = await Promise.all([jpegOf(file), jpegOf(file)]);
    expect(first).toBeDefined();
    expect(second).toBe(first);
    expect(first!.startsWith(path.join(dir, "heic"))).toBe(true);
    expect(isJpeg(fs.readFileSync(first!))).toBe(true);
    expect(await jpegOf(file)).toBe(first);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    expect(await jpegOf(file)).not.toBe(first);
  });

  test("an upload kept as a HEIC is served as its JPEG", async () => {
    if (!heic) return;
    fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(dir, "uploads", "old-IMG_0001.heic"), heic);
    const res = await get((req, res) => serveUpload(req, res), "/uploads/old-IMG_0001.heic");
    expect(res.status).toBe(200);
    expect(res.type).toBe("image/jpeg");
    expect(isJpeg(res.body)).toBe(true);
  });

  test("one nothing could convert is served as it is", async () => {
    fs.mkdirSync(path.join(dir, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(dir, "uploads", "bad-IMG_0002.heic"), "not a picture");
    const res = await get((req, res) => serveUpload(req, res), "/uploads/bad-IMG_0002.heic");
    expect(res.status).toBe(200);
    expect(res.type).toBe("image/heic");
    expect(res.body.toString()).toBe("not a picture");
  });

  test("a HEIC a tool read is served as its JPEG", async () => {
    if (!heic) return;
    const file = path.join(dir, "read.heic");
    fs.writeFileSync(file, heic);
    const images = new ReadableImages(() => dir);
    const event = {
      kind: "tool",
      image: { url: `/readfile?p=${encodeURIComponent(file)}`, name: "read.heic" },
    } as unknown as TranscriptEvent;
    images.allowReadImages("chat", [event]);
    const res = await get(
      (req, res) => images.serveReadFile(req, res),
      `/readfile?p=${encodeURIComponent(file)}`,
    );
    expect(res.status).toBe(200);
    expect(res.type).toBe("image/jpeg");
    expect(isJpeg(res.body)).toBe(true);
  });
});
