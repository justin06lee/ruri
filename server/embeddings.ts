import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { configPath } from "./configDir.js";
import { isMissing, warn } from "./log.js";

/**
 * Meaning, as numbers: each exchange, memory line and prompt as an
 * embedding, from a model running on this machine — so "the gauge reads
 * wrong after a rewind" finds the exchange that said "context occupancy
 * restored to the kept turn", which shares none of its words.
 *
 * Only a local model, and only one already there: Ollama on its usual
 * port, with an embedding model pulled (`ollama pull nomic-embed-text`;
 * RURI_EMBED_MODEL names another, RURI_EMBED_URL another server). ruri
 * never downloads one, and with none every search is the lexical one it
 * always was (server/retrieval.ts).
 *
 * Asking for an embedding takes milliseconds but is still a request, and
 * a prompt's brief is put together without waiting on anything — so what
 * will be searched is embedded ahead: each exchange as its turn finishes,
 * each memory line as it changes, and the prompt being written from its
 * draft. The vectors are kept on disk (embeddings/<model>.jsonl) by a hash
 * of their text, and a search reads only what is already there.
 */

const BASE = process.env["RURI_EMBED_URL"] || "http://127.0.0.1:11434";
const MODEL = process.env["RURI_EMBED_MODEL"] || "nomic-embed-text";
/** How long the answer "is there a model?" holds. */
const AVAILABLE_FOR_MS = 10 * 60_000;
/** What one text is cut to before it is embedded. */
const TEXT_CHARS = 2_000;
const BATCH = 32;

export type Purpose = "query" | "document";

/** What the model is told a text is for, where it wants telling. */
function prefixed(text: string, purpose: Purpose): string {
  if (!/nomic/i.test(MODEL)) return text;
  return `${purpose === "query" ? "search_query" : "search_document"}: ${text}`;
}

function keyOf(text: string, purpose: Purpose): string {
  return createHash("sha1")
    .update(`${MODEL}\u0000${purpose}\u0000${text.slice(0, TEXT_CHARS)}`)
    .digest("base64url")
    .slice(0, 22);
}

function encode(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

function decode(text: string): Float32Array {
  const bytes = Buffer.from(text, "base64");
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Each text's vector, kept, and asked for in the background. */
export class Embedder {
  private readonly vectors = new Map<string, Float32Array>();
  private loaded = false;
  private ready: { ok: boolean; at: number } | undefined;
  private readonly waiting = new Map<string, { text: string; purpose: Purpose }>();
  private flushing: Promise<void> | undefined;

  constructor(
    readonly model = MODEL,
    private readonly file = () => configPath("embeddings", `${MODEL.replace(/[^\w.-]+/g, "_")}.jsonl`),
  ) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    let text: string;
    try {
      text = fs.readFileSync(this.file(), "utf8");
    } catch (err) {
      if (!isMissing(err)) warn("embeddings", err, "load");
      return;
    }
    for (const row of text.split("\n")) {
      const at = row.indexOf("\t");
      if (at <= 0) continue;
      try {
        this.vectors.set(row.slice(0, at), decode(row.slice(at + 1)));
      } catch {
        // a torn row is skipped
      }
    }
  }

  /** Whether a model is there to ask — answered from the last time asked,
   *  and asked again (in the background) when that is old. */
  usable(): boolean {
    if (!this.ready || Date.now() - this.ready.at > AVAILABLE_FOR_MS) void this.check();
    return this.ready?.ok ?? false;
  }

  /** Ask Ollama whether it has the model. */
  async check(): Promise<boolean> {
    try {
      const res = await fetch(`${BASE}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const body = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
      const ok = (body.models ?? []).some((m) =>
        [m.name, m.model].some((name) => name === MODEL || name?.startsWith(`${MODEL}:`)),
      );
      this.ready = { ok, at: Date.now() };
    } catch {
      this.ready = { ok: false, at: Date.now() };
    }
    return this.ready.ok;
  }

  /** A text's vector, if it was embedded already. Never waits. */
  cached(text: string, purpose: Purpose = "document"): Float32Array | undefined {
    this.load();
    return this.vectors.get(keyOf(text, purpose));
  }

  /** Have these embedded soon, in the background. */
  warm(texts: string[], purpose: Purpose = "document"): void {
    if (!this.usable()) return;
    this.load();
    for (const text of texts) {
      if (!text.trim()) continue;
      const key = keyOf(text, purpose);
      if (!this.vectors.has(key)) this.waiting.set(key, { text, purpose });
    }
    this.flushing ??= this.flush().finally(() => {
      this.flushing = undefined;
    });
  }

  /** Embed these now (the ones not kept yet), and answer their vectors —
   *  undefined for any the model couldn't give. */
  async embed(texts: string[], purpose: Purpose = "document"): Promise<Array<Float32Array | undefined>> {
    this.load();
    if (!(this.ready?.ok ?? (await this.check()))) return texts.map(() => undefined);
    const missing = texts.filter((text) => text.trim() && !this.vectors.has(keyOf(text, purpose)));
    for (let i = 0; i < missing.length; i += BATCH) await this.request(missing.slice(i, i + BATCH), purpose);
    return texts.map((text) => this.vectors.get(keyOf(text, purpose)));
  }

  private async flush(): Promise<void> {
    // let a burst gather
    await new Promise((resolve) => setTimeout(resolve, 50));
    while (this.waiting.size) {
      const batch = [...this.waiting.entries()].slice(0, BATCH);
      for (const [key] of batch) this.waiting.delete(key);
      for (const purpose of ["query", "document"] as Purpose[]) {
        const texts = batch.filter(([, w]) => w.purpose === purpose).map(([, w]) => w.text);
        if (texts.length) await this.request(texts, purpose);
      }
    }
  }

  private async request(texts: string[], purpose: Purpose): Promise<void> {
    try {
      const res = await fetch(`${BASE}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          input: texts.map((text) => prefixed(text.slice(0, TEXT_CHARS), purpose)),
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`ollama answered ${res.status}`);
      const body = (await res.json()) as { embeddings?: number[][] };
      const rows: string[] = [];
      (body.embeddings ?? []).forEach((values, i) => {
        const text = texts[i];
        if (!text || !Array.isArray(values)) return;
        const key = keyOf(text, purpose);
        const vector = Float32Array.from(values);
        this.vectors.set(key, vector);
        rows.push(`${key}\t${encode(vector)}`);
      });
      // a prompt's vector is wanted once, in this run: only what will be
      // searched again is kept on disk
      if (rows.length && purpose === "document") {
        fs.mkdirSync(path.dirname(this.file()), { recursive: true });
        fs.appendFileSync(this.file(), `${rows.join("\n")}\n`);
      }
    } catch (err) {
      warn("embeddings", err, "request");
      this.ready = { ok: false, at: Date.now() };
    }
  }
}
