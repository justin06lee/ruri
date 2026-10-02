/**
 * A certificate of ruri's own, for the door other devices come in by
 * (server/sharing.ts).
 *
 * No authority vouches for it, and none needs to: the invite a device is
 * paired with carries the certificate's fingerprint, and the device trusts
 * that one certificate and nothing else for that computer (desktop/remote.ts).
 * So the line is encrypted end to end on any network — a café's, a LAN, a
 * mesh — and nothing in the middle can stand in for the host.
 *
 * Node can make the key but not the certificate around it, and a library
 * for one is a megabyte of someone else's ASN.1. A self-signed certificate
 * is a few nested sequences, so they are written out here: ECDSA P-256,
 * signed with SHA-256, the subject "ruri".
 */
import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";

/** A DER element: tag, length, contents. */
function der(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const n = body.length;
  let length: Buffer;
  if (n < 0x80) length = Buffer.from([n]);
  else if (n < 0x100) length = Buffer.from([0x81, n]);
  else length = Buffer.from([0x82, n >> 8, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, body]);
}

const seq = (...parts: Buffer[]) => der(0x30, ...parts);
const set = (...parts: Buffer[]) => der(0x31, ...parts);

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [a * 40 + b];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

/** A positive INTEGER from big-endian bytes. */
function integer(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return der(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
}

/** UTCTime through 2049, GeneralizedTime after — as X.509 asks. */
function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? der(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : der(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function name(common: string): Buffer {
  return seq(set(seq(oid("2.5.4.3"), der(0x0c, Buffer.from(common, "utf8")))));
}

/** A key and the certificate for it, both PEM. */
export interface TlsIdentity {
  key: string;
  cert: string;
}

/** A fresh key and a self-signed certificate for it, good for `years`. */
export function makeIdentity(years = 20): TlsIdentity {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const now = new Date();
  // an hour's grace either side of the clock, for a device whose clock is behind
  const notBefore = new Date(now.getTime() - 60 * 60_000);
  const notAfter = new Date(now);
  notAfter.setUTCFullYear(now.getUTCFullYear() + years);
  const serial = randomBytes(16);
  serial[0]! &= 0x7f;
  const extensions = der(
    0xa3,
    seq(
      // basicConstraints: not an authority
      seq(oid("2.5.29.19"), der(0x01, Buffer.from([0xff])), der(0x04, seq())),
      // subjectAltName: dNSName "ruri" — the name means nothing, the
      // fingerprint is what a device checks; some TLS stacks want one there
      seq(oid("2.5.29.17"), der(0x04, seq(der(0x82, Buffer.from("ruri", "ascii"))))),
    ),
  );
  const tbs = seq(
    der(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_SHA256,
    name("ruri"),
    seq(time(notBefore), time(notAfter)),
    name("ruri"),
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const signature = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const cert = seq(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), signature));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: pem(cert, "CERTIFICATE"),
  };
}

function pem(bytes: Buffer, label: string): string {
  const lines = bytes.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** The DER inside a PEM certificate. */
export function pemBody(text: string): Buffer {
  return Buffer.from(text.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
}

/** What an invite pins: the SHA-256 of the certificate, base64url. The
 *  desktop shell computes the same from what Chromium shows it. */
export function fingerprint(certPem: string): string {
  return createHash("sha256").update(pemBody(certPem)).digest("base64url");
}

/** Whether a key file and a certificate file still belong together — a
 *  half-written pair is made again rather than served. */
export function identityHolds(identity: TlsIdentity): boolean {
  try {
    const probe = Buffer.from("ruri");
    const signature = sign("sha256", probe, createPrivateKey(identity.key));
    return verify("sha256", probe, new X509Certificate(identity.cert).publicKey, signature);
  } catch {
    return false;
  }
}
