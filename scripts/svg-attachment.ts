/**
 * A picture the model cannot take as it is still reaches it.
 *
 * An SVG attached to a prompt used to go to the model as an image of type
 * image/svg+xml, which no harness takes — the model answered that the
 * picture failed to load — and its thumbnail was served as octet-stream, so
 * the transcript showed a broken frame. Now the composer sends a PNG drawn
 * from it, the model is shown that and handed the original's path, and the
 * upload is served as the picture it is. A type nothing could draw (HEIC)
 * goes to the model as a file path instead of as a broken image.
 *
 * One tiny real turn on Haiku against the real server — run manually:
 * bun run svg-attachment-test
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import WebSocket from "ws";
import { bootServer, wsUrl } from "./lib/server.js";
import type { ClientMessage, ServerMessage } from "../shared/protocol.js";

const PORT = Number(process.env["RURI_PORT"] ?? 7884);
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-svgatt-config-"));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-svgatt-project-"));

/** A solid-colour PNG, as the composer's canvas would have drawn the SVG. */
function solidPng(size: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3).map((_, i) => [r, g, b][i % 3]!)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: size }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#e11"/></svg>';

const server = bootServer({ port: PORT, configDir, stdio: ["ignore", "ignore", "inherit"] });

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}
function cleanup(code: number): never {
  server.kill("SIGINT");
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(projectDir, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.error("SVG-ATTACHMENT FAIL: timed out");
  cleanup(1);
}, 180_000).unref();

async function connect(url: string): Promise<WebSocket> {
  const start = Date.now();
  for (;;) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const sock = new WebSocket(url);
        sock.once("open", () => resolve(sock));
        sock.once("error", reject);
      });
    } catch {
      if (Date.now() - start > 60_000) {
        console.error("SVG-ATTACHMENT FAIL: could not connect");
        cleanup(1);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

let projectId: string | undefined;
let reply = "";
let result: { ok: boolean; error?: string } | undefined;
let stored: Array<{ url?: string; mediaType: string }> = [];
const waiters = new Set<() => void>();
const ws = await connect(wsUrl(PORT));
const send = (msg: ClientMessage) => ws.send(JSON.stringify(msg));
ws.on("message", (raw) => {
  const msg = JSON.parse(String(raw)) as ServerMessage;
  if (msg.type === "projects" && !projectId && msg.projects.length > 0) {
    projectId = msg.projects[msg.projects.length - 1]!.sessions[0]!.id;
  }
  if (msg.type === "event" && msg.projectId === projectId) {
    if (msg.event.kind === "user") stored = msg.event.attachments ?? [];
    if (msg.event.kind === "assistant") reply += msg.event.text;
    if (msg.event.kind === "result") result = msg.event;
  }
  for (const waiter of [...waiters]) waiter();
});
function until(what: string, ok: () => boolean, ms: number): Promise<void> {
  if (ok()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const look = () => {
      if (!ok()) return;
      clearTimeout(timer);
      waiters.delete(look);
      resolve();
    };
    const timer = setTimeout(() => {
      waiters.delete(look);
      console.log(`    (gave up waiting for ${what})`);
      resolve();
    }, ms);
    waiters.add(look);
  });
}

send({ type: "add_project", name: "svgatt", path: projectDir });
await until("the project", () => Boolean(projectId), 30_000);
if (!projectId) {
  console.error("SVG-ATTACHMENT FAIL: no project");
  cleanup(1);
}
send({ type: "set_model", projectId, model: "haiku" });
await new Promise((r) => setTimeout(r, 300));
send({
  type: "send",
  projectId,
  text:
    "Without using any tools, answer in exactly two lines. Line 1: the one colour word that fills [image #1]. " +
    "Line 2: the file extension (lowercase, no dot) of the file named in this sentence: [image #2]",
  attachments: [
    {
      id: "5f0c1a2b-0000-4000-8000-000000000001",
      kind: "image",
      mediaType: "image/svg+xml",
      name: "mark.svg",
      n: 1,
      data: Buffer.from(SVG).toString("base64"),
      picture: solidPng(64, [238, 17, 17]).toString("base64"),
    },
    {
      id: "5f0c1a2b-0000-4000-8000-000000000002",
      kind: "image",
      mediaType: "image/heic",
      name: "IMG_0001.HEIC",
      n: 2,
      data: Buffer.from("not really a heic").toString("base64"),
    },
  ],
});
await until("the reply", () => result !== undefined, 120_000);
check("the turn ends well", result?.ok === true, result);
check("the model sees the SVG's picture", /\bred\b/i.test(reply), reply);
check("and is handed the undrawable one as a file", /\bheic\b/i.test(reply), reply);
check("no picture failed to load", !/fail|unable|couldn'?t|cannot|can't/i.test(reply), reply);

const svgUrl = stored.find((att) => att.mediaType === "image/svg+xml")?.url;
const served = svgUrl ? await fetch(`http://127.0.0.1:${PORT}${svgUrl}`) : undefined;
check("the SVG's thumbnail is served as a picture", served?.headers.get("content-type") === "image/svg+xml", {
  url: svgUrl,
  type: served?.headers.get("content-type"),
});
check(
  "the PNG drawn for the model is not in the archive",
  !JSON.stringify(stored).includes("picture"),
  stored,
);

console.log(failed === 0 ? "\nall good" : `\n${failed} failed`);
cleanup(failed === 0 ? 0 : 1);
