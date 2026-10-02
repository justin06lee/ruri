/**
 * Sharing: another device pairs and uses this computer through the door
 * (server/sharing.ts), and nothing without a key gets in.
 *
 *   - an invite is six words and turns sharing on; the door listens over
 *     TLS and answers a LAN's broadcast
 *   - pairing by words: the host proves the words over the certificate it
 *     serves (a MAC over any other certificate is not it), the device proves
 *     them back; wrong words, a replayed hello and a used invite are refused
 *   - pairing over SSH: the local port, with the token, hands a key and the
 *     certificate's fingerprint straight out — never through the door
 *   - every request needs the device's key — header, URL or cookie — and a
 *     page's Origin must be the door's own; the page served with the key in
 *     its URL hands it back as a cookie
 *   - a window come in through the door is marked as that device's: no
 *     folder dialog, no turning sharing off from it, seen online at home
 *   - unpairing closes its windows and its key stops working
 *   - turned off, the port is shut; started again with sharing on, the door
 *     comes back on the same port with the same certificate
 *
 * No harness, no tokens spent. Run: bun run sharing-test
 */
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import * as https from "node:https";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as tls from "node:tls";
import WebSocket from "ws";
import type { ServerMessage, SharingInfo } from "../shared/protocol.js";
import { nonce, pairMac, wordsKey } from "../server/invite.js";
import { startServer } from "../server/server.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  if (!ok) {
    failed += 1;
    if (detail !== undefined) console.log("   ", JSON.stringify(detail));
  }
}

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ruri-sharing-"));
process.env["RURI_CONFIG_DIR"] = configDir;
const staticDir = path.join(configDir, "web");
fs.mkdirSync(staticDir);
fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>ruri</title>");
const PORT = Number(process.env["RURI_PORT"] ?? 7898);
const TOKEN = "token-for-the-sharing-test";
const options = { port: PORT, token: TOKEN, staticDir, updateHarnesses: false };
let running = await startServer(options);

/** The local window's socket, answering every message it is sent. */
function localWindow(): Promise<{ ws: WebSocket; next(type: string): Promise<ServerMessage> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${TOKEN}`);
    const inbox: ServerMessage[] = [];
    const waiters: Array<{ type: string; resolve(m: ServerMessage): void }> = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as ServerMessage;
      const at = waiters.findIndex((w) => w.type === msg.type);
      if (at >= 0) waiters.splice(at, 1)[0]!.resolve(msg);
      else inbox.push(msg);
    });
    const next = (type: string) =>
      new Promise<ServerMessage>((done) => {
        const at = inbox.findIndex((m) => m.type === type);
        if (at >= 0) done(inbox.splice(at, 1)[0]!);
        else waiters.push({ type, resolve: done });
      });
    ws.once("open", () => resolve({ ws, next }));
  });
}

/** One HTTPS request to the door, certificate unchecked — the pin is
 *  checked apart, below, as the desktop shell checks it. */
function door(
  port: number,
  method: string,
  p: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: "127.0.0.1", port, method, path: p, headers, rejectUnauthorized: false, agent: false },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => (text += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** What the door's certificate fingerprints as, base64url SHA-256. */
function servedFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const hex = socket.getPeerCertificate().fingerprint256.replace(/:/g, "");
      socket.end();
      resolve(Buffer.from(hex, "hex").toString("base64url"));
    });
    socket.on("error", reject);
  });
}

/** A window on the other device: "open:<snapshot>" or "http <status>". */
function remoteWindow(
  port: number,
  query: string,
  headers: Record<string, string> = {},
): Promise<{ result: string; ws?: WebSocket; snapshot?: Extract<ServerMessage, { type: "snapshot" }> }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/${query}`, { headers, rejectUnauthorized: false });
    ws.once("message", (raw) => {
      const snapshot = JSON.parse(String(raw)) as Extract<ServerMessage, { type: "snapshot" }>;
      resolve({ result: "open", ws, snapshot });
    });
    ws.once("error", () => {});
    ws.once("unexpected-response", (_req, res) => resolve({ result: `http ${res.statusCode}` }));
  });
}

const portOpen = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });

try {
  const home = await localWindow();
  const first = (await home.next("snapshot")) as Extract<ServerMessage, { type: "snapshot" }>;
  check("off until asked", first.sharing.on === false && first.sharing.devices.length === 0);
  check("the local window is no device", first.remoteDevice === undefined);

  // an invite turns sharing on by itself
  home.ws.send(JSON.stringify({ type: "sharing_invite" }));
  const made = (await home.next("sharing_invite")) as Extract<ServerMessage, { type: "sharing_invite" }>;
  check(
    "an invite is six words",
    made.words.length === 6 && made.words.every((w) => /^[a-z]+$/.test(w)),
    made,
  );
  check("it runs out in about 15 minutes", Math.abs(made.expires - Date.now() - 15 * 60_000) < 5_000);
  const on = ((await home.next("sharing")) as { sharing: SharingInfo }).sharing;
  check("sharing is on, and says where", on.on && on.port > 0 && on.addresses.length > 0, on);
  const port = on.port;
  const print = await servedFingerprint(port);

  const hello = JSON.parse((await door(port, "GET", "/remote/hello")).text) as Record<string, unknown>;
  check(
    "hello says ruri, and nothing more without a key",
    hello["service"] === "ruri" && hello["paired"] === false && !("addresses" in hello),
    hello,
  );

  // the LAN's "is ruri here?"
  const beacon = await new Promise<string>((resolve) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => resolve("no answer"), 2_000);
    socket.on("message", (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(msg.toString());
    });
    socket.send("ruri?1", 7775, "127.0.0.1");
  });
  check(
    "it answers a broadcast with its name and port",
    beacon.includes('"service":"ruri"') && beacon.includes(`"port":${port}`),
    beacon,
  );

  const post = (p: string, body: unknown) =>
    door(port, "POST", p, { "content-type": "application/json" }, JSON.stringify(body)).then((r) => ({
      status: r.status,
      json: JSON.parse(r.text || "{}") as Record<string, unknown>,
    }));
  /** Pair by words, as desktop/remote.ts does; `proof` overrides the
   *  device's MAC, `hostNonce` the number it answers. */
  const pairWords = async (words: string[], over: { proof?: string; hostNonce?: string } = {}) => {
    const key = await wordsKey(words);
    const mine = nonce();
    const hi = await post("/pair/hello", { nonce: mine });
    const theirs = hi.json["nonce"] as string;
    const macs = (hi.json["macs"] as string[] | undefined) ?? [];
    const proved = macs.includes(pairMac(key, "host", print, mine, theirs));
    const proveNonce = over.hostNonce ?? theirs;
    const prove = await post("/pair/prove", {
      nonce: mine,
      hostNonce: proveNonce,
      mac: over.proof ?? pairMac(key, "device", print, mine, proveNonce),
      name: "jetson",
    });
    return { hi, proved, macs, mine, theirs, key, prove };
  };

  const wrong = await pairWords(["abandon", "ability", "able", "about", "above", "absent"]);
  check("the host's proof doesn't fit other words", wrong.hi.status === 200 && !wrong.proved);
  check("and other words pair nothing", wrong.prove.status === 403, wrong.prove);
  const right = await pairWords(made.words);
  check("the host proves the invite's words over its own certificate", right.proved);
  check(
    "a MAC over any other certificate is not that proof",
    !right.macs.includes(pairMac(right.key, "host", "someone-elses-certificate", right.mine, right.theirs)),
  );
  check("the words pair", right.prove.status === 200 && right.prove.json["ok"] === true, right.prove);
  check("and say which certificate to pin", right.prove.json["fingerprint"] === print);
  const replay = await post("/pair/prove", {
    nonce: right.mine,
    hostNonce: right.theirs,
    mac: pairMac(right.key, "device", print, right.mine, right.theirs),
    name: "again",
  });
  check("a hello answers one proof only", replay.status === 403, replay);
  const used = await post("/pair/hello", { nonce: nonce() });
  check("an invite pairs one device", used.status === 404, used);
  const answer = right.prove.json as { ok: boolean; key: string; deviceId: string; name: string };
  const key = answer.key;

  // over SSH: the device's shell, signed in here, asks the local port
  const pairLocal = (headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${PORT}/sharing/pair-local`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ name: "laptop" }),
    });
  check("pair-local without the token is refused", (await pairLocal({})).status === 401);
  const direct = (await (await pairLocal({ "x-ruri-token": TOKEN })).json()) as Record<string, unknown>;
  check(
    "pair-local hands out a key and the certificate to pin",
    direct["ok"] === true && typeof direct["key"] === "string" && direct["fingerprint"] === print,
    direct,
  );
  check(
    "but never through the door",
    (await door(port, "POST", "/sharing/pair-local", { "x-ruri-token": key }, "{}")).status === 403,
  );

  const stored = fs.readFileSync(path.join(configDir, "sharing.json"), "utf8");
  check("the key is kept only as a hash", !stored.includes(key) && stored.includes("keyHash"));
  check(
    "sharing.json is this user's only",
    (fs.statSync(path.join(configDir, "sharing.json")).mode & 0o777) === 0o600,
  );
  check(
    "the door's private key is this user's only",
    (fs.statSync(path.join(configDir, "sharing", "key.pem")).mode & 0o777) === 0o600,
  );

  check("no key, no page", (await door(port, "GET", "/")).status === 401);
  check("a wrong key, no page", (await door(port, "GET", "/?token=nope")).status === 401);
  const page = await door(port, "GET", `/?token=${key}`);
  const cookie = String(page.headers["set-cookie"] ?? "");
  check("the key in the URL gets the page", page.status === 200 && page.text.includes("<title>ruri"));
  check(
    "and hands it back as a secure cookie",
    cookie.includes("ruri_device=") && cookie.includes("Secure") && cookie.includes("HttpOnly"),
    cookie,
  );
  const jar = cookie.split(";")[0]!;
  check(
    "the cookie gets what the page loads",
    (await door(port, "GET", "/healthz", { cookie: jar })).status === 200,
  );
  check("so does the header", (await door(port, "GET", "/healthz", { "x-ruri-token": key })).status === 200);
  check(
    "a page from anywhere else is refused, key or no key",
    (await door(port, "GET", "/healthz", { "x-ruri-token": key, origin: "https://evil.example" })).status ===
      403,
  );
  check(
    "a POST past the door needs no second token",
    (await door(port, "POST", "/anything", { "x-ruri-token": key })).status === 404,
  );
  check(
    "the local token is no key here",
    (await door(port, "GET", "/healthz", { "x-ruri-token": TOKEN })).status === 401,
  );

  check("socket: no key is refused", (await remoteWindow(port, "")).result === "http 401");
  check(
    "socket: a foreign Origin is refused",
    (await remoteWindow(port, `?token=${key}`, { origin: "https://evil.example" })).result === "http 403",
  );
  const remote = await remoteWindow(port, `?token=${key}`, { origin: `https://127.0.0.1:${port}` });
  check("socket: the key and the door's own origin get in", remote.result === "open", remote.result);
  check(
    "it is known as the device it is",
    remote.snapshot?.remoteDevice?.name === "jetson",
    remote.snapshot?.type,
  );
  check("no folder dialog for it", remote.snapshot?.canPickFolder === false);
  let online = ((await home.next("sharing")) as { sharing: SharingInfo }).sharing;
  while (!online.devices.some((d) => d.online)) {
    online = ((await home.next("sharing")) as { sharing: SharingInfo }).sharing;
  }
  check(
    "home sees it online",
    online.devices.some((d) => d.name === "jetson" && d.online),
    online.devices,
  );

  // it may not shut the door it stands in
  const refused = await new Promise<ServerMessage>((resolve) => {
    remote.ws!.once("message", (raw) => resolve(JSON.parse(String(raw)) as ServerMessage));
    remote.ws!.send(JSON.stringify({ type: "sharing_set", on: false }));
  });
  check("turning sharing off from the far side is refused", refused.type === "error", refused);
  check("and it stays on", await portOpen(port));

  // unpairing closes its windows and voids its key
  const closed = new Promise<number>((resolve) => remote.ws!.once("close", (code) => resolve(code)));
  home.ws.send(JSON.stringify({ type: "sharing_forget", deviceId: answer.deviceId }));
  check("unpairing closes its window", (await closed) === 4003);
  check(
    "and its key no longer opens anything",
    (await door(port, "GET", "/healthz", { "x-ruri-token": key })).status === 401,
  );

  // a second device, kept across a restart
  const second = direct as { key: string };
  home.ws.close();
  await running.close();
  check("closed, the door is shut", !(await portOpen(port)));
  running = await startServer(options);
  await new Promise((r) => setTimeout(r, 300));
  check("started again, the door is open on the same port", await portOpen(port));
  check("with the same certificate", (await servedFingerprint(port)) === print);
  check(
    "and the same devices",
    (await door(port, "GET", "/healthz", { "x-ruri-token": second.key })).status === 200,
  );

  const local = await localWindow();
  await local.next("snapshot");
  local.ws.send(JSON.stringify({ type: "sharing_set", on: false }));
  const off = ((await local.next("sharing")) as { sharing: SharingInfo }).sharing;
  check("turned off, it says so", off.on === false && off.addresses.length === 0);
  check("and the port is shut", !(await portOpen(port)));
  local.ws.close();
  await running.close();
} finally {
  fs.rmSync(configDir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
