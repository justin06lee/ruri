/**
 * An invite: six words, shown on the computer being shared, typed on the
 * device that wants in (server/sharing.ts, desktop/remote.ts).
 *
 * The words are a secret both sides hold and neither sends. Pairing proves
 * them instead: the device sends a fresh number, the host answers with a
 * MAC of the words over its own certificate's fingerprint and both numbers,
 * and the device checks it against the certificate it actually sees — a
 * computer in the middle, showing a certificate of its own, cannot make
 * that MAC without the words. Then the device proves the words the same
 * way and is given its key. Six of BIP39's 2048 words are 66 bits; the key
 * is stretched with scrypt, so even a MAC caught on the wire cannot be
 * worked back to the words while the invite lasts, and an invite lasts
 * fifteen minutes and pairs one device.
 *
 * Imports nothing but node:crypto and the list, so the desktop shell's
 * bundle stays light.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { WORDS } from "./words.js";

/** How many words an invite is. */
export const INVITE_WORDS = 6;

const INDEX = new Map(WORDS.map((word, i) => [word, i]));
/** BIP39's words are unique in their first four letters. */
const BY_PREFIX = new Map(WORDS.map((word) => [word.slice(0, 4), word]));

/** Six fresh words: 11 bits each, from the system's randomness. */
export function makeWords(): string[] {
  const bytes = randomBytes(9);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  const words: string[] = [];
  for (let i = 0; i < INVITE_WORDS; i++) {
    words.push(WORDS[Number((bits >> BigInt(i * 11)) & 2047n)]!);
  }
  return words;
}

/**
 * The words in what someone typed — any case, any spacing or punctuation
 * between them, a word known by its first four letters — or what is wrong
 * with it.
 */
export function readWords(text: string): { words: string[] } | { error: string } {
  const typed = text
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  if (typed.length !== INVITE_WORDS) {
    return {
      error: `That is ${typed.length} word${typed.length === 1 ? "" : "s"} — an invite is ${INVITE_WORDS}.`,
    };
  }
  const words: string[] = [];
  for (const word of typed) {
    const known = INDEX.has(word) ? word : word.length >= 4 ? BY_PREFIX.get(word.slice(0, 4)) : undefined;
    if (!known) return { error: `"${word}" isn't one of the invite's words — check its spelling.` };
    words.push(known);
  }
  return { words };
}

/** The key the words stand for: scrypt, slow on purpose (~100 ms). */
export function wordsKey(words: readonly string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      words.join(" "),
      "ruri pairing 1",
      32,
      { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** One side's proof of the words, bound to the host's certificate and to
 *  both sides' numbers for this pairing. */
export function pairMac(
  key: Buffer,
  side: "host" | "device",
  fingerprint: string,
  deviceNonce: string,
  hostNonce: string,
): string {
  return createHmac("sha256", key)
    .update(["ruri", side, fingerprint, deviceNonce, hostNonce].join("\n"))
    .digest("base64url");
}

/** A fresh number for one pairing. */
export function nonce(): string {
  return randomBytes(16).toString("base64url");
}

/** Two MACs compared in constant time. */
export function macsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** An address as it goes in a URL: an IPv6 one in brackets. */
export function urlHost(address: string): string {
  return address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
}
