import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { pickEncoding, serveStatic } from "./staticFiles.js";

/*
 * The built page over the network: compressed where the window takes it,
 * answered "not modified" when it already has it — and this computer's own
 * window sent plain bytes, as ever.
 */

let dir: string;
let server: http.Server;
let base: string;
const bundle = `console.log(${JSON.stringify("ruri ".repeat(20_000))});`;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-static-"));
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><script src=/assets/app.js></script>");
  fs.writeFileSync(path.join(dir, "assets", "app.js"), bundle);
  server = http.createServer((req, res) => serveStatic(dir, req, res, req.headers["x-network"] === "1"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A raw GET — fetch would undo the encoding it is testing. */
function get(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    // the path as written, not tidied up by a URL parser on the way out
    const { hostname, port } = new URL(base);
    http
      .get({ hostname, port, path: url, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      })
      .on("error", reject);
  });
}

describe("the page over the network", () => {
  test("goes brotli-compressed to a window that takes it, and is the same script unpacked", async () => {
    const res = await get("/assets/app.js", {
      "x-network": "1",
      "accept-encoding": "gzip, deflate, br, zstd",
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("br");
    expect(res.headers["vary"]).toBe("accept-encoding");
    expect(res.body.length).toBeLessThan(bundle.length / 10);
    expect(zlib.brotliDecompressSync(res.body).toString()).toBe(bundle);
  });

  test("goes gzip to a window that only takes gzip", async () => {
    const res = await get("/assets/app.js", { "x-network": "1", "accept-encoding": "gzip" });
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(zlib.gunzipSync(res.body).toString()).toBe(bundle);
  });

  test("a page it already has is answered 'not modified', with nothing in the body", async () => {
    const first = await get("/", { "x-network": "1", "accept-encoding": "br" });
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-cache");
    const again = await get("/", {
      "x-network": "1",
      "accept-encoding": "br",
      "if-none-match": first.headers.etag!,
    });
    expect(again.status).toBe(304);
    expect(again.body.length).toBe(0);
  });

  test("a rebuilt page is a new tag: the old one is not 'not modified'", async () => {
    const first = await get("/", {});
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><p>rebuilt, and longer than before</p>");
    const again = await get("/", { "if-none-match": first.headers.etag! });
    expect(again.status).toBe(200);
    expect(again.body.toString()).toContain("rebuilt");
  });
});

describe("this computer's own window", () => {
  test("is sent the file as it is, whatever it says it takes", async () => {
    const res = await get("/assets/app.js", { "accept-encoding": "br, gzip" });
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body.toString()).toBe(bundle);
    expect(res.headers["cache-control"]).toContain("immutable");
  });

  test("and nothing outside the build is served", async () => {
    expect((await get("/../../etc/passwd", {})).status).toBe(403);
    expect((await get("/assets/missing.js", {})).status).toBe(404);
  });
});

describe("which encoding", () => {
  test("brotli first, gzip next, and a q=0 is a no", () => {
    expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(pickEncoding("gzip;q=1.0, br;q=0")).toBe("gzip");
    expect(pickEncoding("identity")).toBeUndefined();
    expect(pickEncoding(undefined)).toBeUndefined();
  });
});
