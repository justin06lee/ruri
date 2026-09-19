import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";
import { isMissing, warn } from "./log.js";
import { IMAGE_MIME, mimeOf } from "./mime.js";

/** How many of each are kept. Both grew for the life of the process — every
 *  image every session ever read — so past this the oldest entry goes. A
 *  picture that old is off every screen; if a transcript asks again, its
 *  events are re-registered on the way out (allowArchived). */
const READABLE_MAX = 5_000;

const MD_IMAGE = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;

/**
 * The local images a transcript may ask the HTTP server for. The agent can
 * read anything, but the server hands back nothing that a recorded event
 * did not already name — GET /readfile?p=… serves only what is registered
 * here.
 */
export class ReadableImages {
  /** Images a Read tool event pointed at, and so the only local paths the
   *  transcript may ask for. */
  private readonly readable = new Set<string>();
  /**
   * A picture a reply pointed at, by the path it wrote (which is what the
   * page asks for — see markdown.tsx) → the file that is. A relative path
   * is the project's; "~" is home. The last reply to write a given path
   * wins.
   */
  private readonly pictured = new Map<string, string>();

  /** @param base Where a channel's relative paths start from. */
  constructor(private readonly base: (channelId: string) => string | undefined) {}

  /** Register a whole snapshot's worth of transcripts, then hand them back. */
  allowArchived(transcripts: Record<string, TranscriptEvent[]>): Record<string, TranscriptEvent[]> {
    for (const [channelId, events] of Object.entries(transcripts)) {
      this.allowReadImages(channelId, events);
    }
    return transcripts;
  }

  /** Register any image paths carried by these events (fresh or archived):
   *  what a Read showed, and what a reply drew by path in its markdown. */
  allowReadImages(channelId: string, events: TranscriptEvent[]): void {
    const base = this.base(channelId);
    for (const event of events) {
      if (event.kind === "tool" && event.image) {
        const p = new URL(event.image.url, "http://localhost").searchParams.get("p");
        if (p) this.remember(p);
        continue;
      }
      if (event.kind !== "assistant") continue;
      for (const match of event.text.matchAll(MD_IMAGE)) {
        const raw = match[1]!;
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("/readfile?")) continue;
        const expanded = raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
        const abs = path.isAbsolute(expanded) ? expanded : base ? path.resolve(base, expanded) : undefined;
        if (!abs) continue;
        this.remember(abs);
        this.rememberPicture(raw, abs);
      }
    }
  }

  /** Sets and Maps iterate in insertion order, so the first key is the oldest. */
  private remember(key: string): void {
    if (this.readable.has(key)) this.readable.delete(key);
    this.readable.add(key);
    if (this.readable.size > READABLE_MAX) this.readable.delete(this.readable.keys().next().value!);
  }

  private rememberPicture(raw: string, abs: string): void {
    if (this.pictured.has(raw)) this.pictured.delete(raw);
    this.pictured.set(raw, abs);
    if (this.pictured.size > READABLE_MAX) this.pictured.delete(this.pictured.keys().next().value!);
  }

  /** Serve one image a tool event read. Anything unregistered is a 403. */
  serveReadFile(req: http.IncomingMessage, res: http.ServerResponse): void {
    const asked = new URL(req.url ?? "/", "http://localhost").searchParams.get("p") ?? "";
    const filePath = this.readable.has(asked) ? asked : this.pictured.get(asked);
    if (!asked || !filePath) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": mimeOf(filePath, IMAGE_MIME),
        "content-length": stat.size,
        // the file can be overwritten in place between reads
        "cache-control": "no-cache",
      });
      fs.createReadStream(filePath).pipe(res);
    } catch (err) {
      if (!isMissing(err)) warn("server", err, "serveReadFile");
      res.writeHead(404);
      res.end();
    }
  }
}
