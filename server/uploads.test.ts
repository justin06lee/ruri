import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AttachmentUpload } from "../shared/protocol.js";
import { modelPayload, storeAttachments } from "./uploads.js";

let saved: string | undefined;
let dir: string;
beforeAll(() => {
  saved = process.env["RURI_CONFIG_DIR"];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-uploads-"));
  process.env["RURI_CONFIG_DIR"] = dir;
});
afterAll(() => {
  if (saved === undefined) delete process.env["RURI_CONFIG_DIR"];
  else process.env["RURI_CONFIG_DIR"] = saved;
  fs.rmSync(dir, { recursive: true, force: true });
});

const upload = (over: Partial<AttachmentUpload>): AttachmentUpload => ({
  id: "c8e23d9f",
  kind: "image",
  mediaType: "image/png",
  name: "shot.png",
  n: 1,
  data: "UE5H",
  ...over,
});

describe("modelPayload", () => {
  test("a picture the model takes goes as it is, marker kept", () => {
    const out = modelPayload("look at [image #1]", [upload({})]);
    expect(out.images).toEqual([{ data: "UE5H", mediaType: "image/png" }]);
    expect(out.text).toBe("look at [image #1]");
  });

  test("an SVG is shown as its PNG, with the original's path", () => {
    const svg = upload({ mediaType: "image/svg+xml", name: "logo.svg", data: "PHN2Zz4=", picture: "iVBOR" });
    const out = modelPayload("make [image #1] an app icon", [svg]);
    expect(out.images).toEqual([{ data: "iVBOR", mediaType: "image/png" }]);
    expect(out.text.startsWith("make [image #1] an app icon\n[image #1: logo.svg]")).toBe(true);
    expect(out.text).toContain(path.join(dir, "uploads", "c8e23d9f-logo.svg"));
  });

  test("its region crops still ride along after the PNG", () => {
    const svg = upload({
      mediaType: "image/svg+xml",
      name: "logo.svg",
      picture: "iVBOR",
      regions: [{ n: 1, data: "crop", mediaType: "image/png" }],
    });
    expect(modelPayload("[image #1] [region #1]", [svg]).images).toEqual([
      { data: "iVBOR", mediaType: "image/png" },
      { data: "crop", mediaType: "image/png" },
    ]);
  });

  test("a picture nothing could draw goes as a file, never as a broken image", () => {
    const heic = upload({ mediaType: "image/heic", name: "IMG_0001.HEIC" });
    const out = modelPayload("what is in [image #1]?", [heic]);
    expect(out.images).toEqual([]);
    expect(out.text).toBe(`what is in ${path.join(dir, "uploads", "c8e23d9f-IMG_0001.heic")}?`);
  });
});

describe("storeAttachments", () => {
  test("the PNG drawn for the model is not archived with the attachment", () => {
    const [stored] = storeAttachments([
      upload({ mediaType: "image/svg+xml", name: "logo.svg", data: "PHN2Zz4=", picture: "iVBOR" }),
    ]);
    expect(stored).toEqual({
      id: "c8e23d9f",
      kind: "image",
      mediaType: "image/svg+xml",
      name: "logo.svg",
      n: 1,
      url: "/uploads/c8e23d9f-logo.svg",
    });
    expect(fs.readFileSync(path.join(dir, "uploads", "c8e23d9f-logo.svg"), "utf8")).toBe("<svg>");
  });
});
