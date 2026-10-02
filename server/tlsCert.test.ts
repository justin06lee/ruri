import { describe, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import * as https from "node:https";
import * as tls from "node:tls";
import { fingerprint, identityHolds, makeIdentity, pemBody } from "./tlsCert.js";

describe("the sharing certificate", () => {
  const identity = makeIdentity();
  const cert = new X509Certificate(identity.cert);

  test("is a sound self-signed X.509 certificate", () => {
    expect(cert.subject).toBe("CN=ruri");
    expect(cert.issuer).toBe("CN=ruri");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.ca).toBe(false);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 10 * 365 * 86_400_000);
  });

  test("its fingerprint is the SHA-256 of the DER, base64url", () => {
    const hex = createHash("sha256").update(pemBody(identity.cert)).digest("hex");
    expect(Buffer.from(fingerprint(identity.cert), "base64url").toString("hex")).toBe(hex);
    expect(cert.fingerprint256.replace(/:/g, "").toLowerCase()).toBe(hex);
  });

  test("key and certificate are known to belong together", () => {
    expect(identityHolds(identity)).toBe(true);
    expect(identityHolds({ key: makeIdentity().key, cert: identity.cert })).toBe(false);
    expect(identityHolds({ key: "nonsense", cert: identity.cert })).toBe(false);
  });

  test("serves TLS, and the client sees the very certificate pinned", async () => {
    const server = https.createServer(identity, (_req, res) => res.end("ok"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const seen = await new Promise<string>((resolve, reject) => {
      const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
        resolve(socket.getPeerCertificate().fingerprint256);
        socket.end();
      });
      socket.on("error", reject);
    });
    server.close();
    expect(seen).toBe(cert.fingerprint256);
  });
});
