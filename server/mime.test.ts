import { describe, expect, test } from "bun:test";
import { AUDIO_MIME, IMAGE_EXTS, IMAGE_MIME, STATIC_MIME, UPLOAD_EXT, UPLOAD_MIME, mimeOf } from "./mime.js";

describe("mimeOf", () => {
  test("answers from the table it is given", () => {
    expect(mimeOf("/tmp/shot.png", IMAGE_MIME)).toBe("image/png");
    expect(mimeOf("index.html", STATIC_MIME)).toBe("text/html; charset=utf-8");
    expect(mimeOf("song.mp3", AUDIO_MIME)).toBe("audio/mpeg");
  });

  test("does not care how the extension is cased", () => {
    expect(mimeOf("PHOTO.JPG", IMAGE_MIME)).toBe("image/jpeg");
    expect(mimeOf("Track.FLAC", AUDIO_MIME)).toBe("audio/flac");
  });

  test("falls back to octet-stream for anything the table lacks", () => {
    expect(mimeOf("archive.tar.gz", IMAGE_MIME)).toBe("application/octet-stream");
    expect(mimeOf("noext", STATIC_MIME)).toBe("application/octet-stream");
    // a dotfile has no extension, whatever its name looks like
    expect(mimeOf(".png", IMAGE_MIME)).toBe("application/octet-stream");
  });

  test("one table never answers for another's extensions", () => {
    expect(mimeOf("song.mp3", IMAGE_MIME)).toBe("application/octet-stream");
    expect(mimeOf("shot.png", AUDIO_MIME)).toBe("application/octet-stream");
  });
});

describe("the tables", () => {
  test("every key carries its dot, as path.extname gives them", () => {
    for (const table of [STATIC_MIME, IMAGE_MIME, AUDIO_MIME, UPLOAD_MIME]) {
      for (const key of Object.keys(table)) expect(key.startsWith(".")).toBe(true);
    }
  });

  test("IMAGE_EXTS is exactly the image table's keys", () => {
    expect([...IMAGE_EXTS].sort()).toEqual(Object.keys(IMAGE_MIME).sort());
  });

  test("an upload saved by its type is served back as that type", () => {
    for (const [mime, ext] of Object.entries(UPLOAD_EXT)) {
      expect(mimeOf(`upload.${ext}`, UPLOAD_MIME)).toBe(mime);
    }
  });

  test("text previews are served as text, the rest as octet-stream", () => {
    expect(mimeOf("notes.md", UPLOAD_MIME)).toBe("text/plain; charset=utf-8");
    expect(mimeOf("data.csv", UPLOAD_MIME)).toBe("text/csv; charset=utf-8");
    expect(mimeOf("blob.bin", UPLOAD_MIME)).toBe("application/octet-stream");
  });
});
