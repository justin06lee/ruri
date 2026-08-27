import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TranscriptEvent } from "../shared/protocol.js";

/**
 * The Home agent's write-ahead log. Home's chat stays ephemeral, but its
 * activity survives here: every prompt, tool call, and reply is appended
 * programmatically as the events stream — the model never spends a token
 * writing it. Blocks are per Home session, numbered and dated so the model
 * can grep for "SESSION 12" or "2026-08-27" (and it's told to search, not
 * read the whole file).
 */

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** One line, whitespace collapsed, clipped so the log stays greppable. */
function clip(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

function day(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} (${DAYS[d.getDay()]})`;
}

export class HomeLog {
  private readonly file: string;
  /** Whether the current Home chat already has its SESSION header. */
  private open = false;
  private nextSession: number;

  constructor() {
    this.file = path.join(
      process.env["RURI_CONFIG_DIR"] ?? path.join(os.homedir(), ".config", "ruri"),
      "home-log.md",
    );
    let last = 0;
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      for (const match of raw.matchAll(/^SESSION (\d+) /gm)) {
        last = Math.max(last, Number(match[1]));
      }
    } catch {
      // no log yet — numbering starts at 1
    }
    this.nextSession = last + 1;
  }

  path(): string {
    return this.file;
  }

  /** The Home chat was reset — the next event opens a fresh SESSION block. */
  endSession(): void {
    this.open = false;
  }

  /** Append one transcript event's line (results and info are noise — skipped). */
  observe(event: TranscriptEvent): void {
    let line: string;
    switch (event.kind) {
      case "user":
        line = `- ${clock(event.ts)} user: ${clip(event.text)}`;
        break;
      case "tool":
        line = `- ${clock(event.ts)} tool ${event.name}: ${clip(event.summary)}`;
        break;
      case "assistant":
        line = `- ${clock(event.ts)} ruri: ${clip(event.text)}`;
        break;
      default:
        return;
    }
    let out = `${line}\n`;
    if (!this.open) {
      this.open = true;
      out = `\nSESSION ${this.nextSession++} — ${day(event.ts)} ${clock(event.ts)}\n${out}`;
    }
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, out);
    } catch {
      // the log is a nicety; losing a line never breaks the turn
    }
  }
}
