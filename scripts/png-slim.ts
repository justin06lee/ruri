/**
 * Re-deflate the PNGs the app ships, losslessly.
 *
 * The art was exported at whatever compression the painting program felt
 * like; zlib at its top setting takes an eighth off the bytes without
 * touching a pixel — the filtered scanlines are inflated and deflated
 * again, byte for byte the same in between. Text and timestamp chunks
 * (editor metadata) are dropped; colour chunks (iCCP, sRGB, gAMA, pHYs)
 * stay, since browsers read them.
 *
 *   bun scripts/png-slim.ts web/public/hero/*.png ...
 *
 * A file is only rewritten when the result is smaller, and every rewrite
 * is checked by inflating it back and comparing to the original.
 */
import * as fs from "node:fs";
import * as zlib from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Ancillary chunks nobody renders. */
const DROP = new Set(["tEXt", "iTXt", "zTXt", "tIME"]);

const TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) crc = TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface Chunk {
  type: string;
  data: Buffer;
}

function chunksOf(png: Buffer): Chunk[] {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error("not a PNG");
  const out: Chunk[] = [];
  let at = 8;
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    out.push({ type, data: png.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return out;
}

function idatOf(chunks: Chunk[]): Buffer {
  return zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === "IDAT").map((c) => c.data)));
}

function encode(chunks: Chunk[]): Buffer {
  const parts: Buffer[] = [SIGNATURE];
  for (const chunk of chunks) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(chunk.data.length);
    const typed = Buffer.concat([Buffer.from(chunk.type, "ascii"), chunk.data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed));
    parts.push(length, typed, crc);
  }
  return Buffer.concat(parts);
}

function slim(file: string): [number, number] {
  const before = fs.readFileSync(file);
  const chunks = chunksOf(before);
  const raw = idatOf(chunks);
  const packed = zlib.deflateSync(raw, { level: 9, memLevel: 9 });
  const kept: Chunk[] = [];
  let placed = false;
  for (const chunk of chunks) {
    if (DROP.has(chunk.type)) continue;
    if (chunk.type !== "IDAT") {
      kept.push(chunk);
      continue;
    }
    if (placed) continue;
    placed = true;
    kept.push({ type: "IDAT", data: packed });
  }
  const after = encode(kept);
  if (after.length >= before.length) return [before.length, before.length];
  if (!idatOf(chunksOf(after)).equals(raw)) throw new Error(`${file}: round trip differs`);
  fs.writeFileSync(file, after);
  return [before.length, after.length];
}

let was = 0;
let now = 0;
for (const file of process.argv.slice(2)) {
  const [b, a] = slim(file);
  was += b;
  now += a;
  if (a < b) console.log(`${file}: ${b} → ${a}`);
}
console.log(`${was} → ${now} bytes (${((1 - now / was) * 100).toFixed(1)}% smaller)`);
