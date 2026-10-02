/**
 * Other devices, using this computer.
 *
 * ruri's own window talks to the server on 127.0.0.1, and nothing else may.
 * Sharing opens a second door, on every network this computer is on — a
 * LAN, Tailscale, makima, whatever carries packets — so a laptop or a small
 * board can run its chats here, on this machine's processor and memory, and
 * be nothing but a window itself.
 *
 * That door is TLS with a certificate of ruri's own (server/tlsCert.ts),
 * which a paired device pins, so the line is private on any network and
 * nothing in the middle can pass for this computer. Behind it, every
 * request and every socket shows a device key — kept here only as a hash,
 * taken back without touching anyone else's. A device gets its key one of
 * two ways: by proving the six words of an invite (server/invite.ts says
 * how, without the words ever crossing the wire), or over SSH, where the
 * login is the proof and the device's shell asks this computer's own port
 * for a key directly (pairDirect, desktop/sshSetup.ts). Devices on the same
 * LAN find it by a broadcast it answers; ones on a mesh, from the mesh's
 * own list of machines.
 *
 * What comes in through it is served exactly as the local window is — the
 * same routes (server/routes.ts), the same socket (server/socket.ts) — with
 * the window marked as another device's (Clients.seats), so the things that
 * only make sense in front of this screen (its folder dialog, macOS's
 * grants, carrying its window) are not offered to it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as dgram from "node:dgram";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import type { WebSocketServer } from "ws";
import type { SharedDevice, SharingInfo } from "../shared/protocol.js";
import { writeJsonAtomic, writeTextAtomic } from "./atomic.js";
import { configPath } from "./configDir.js";
import { macsMatch, makeWords, nonce, pairMac, wordsKey } from "./invite.js";
import { errorMessage, isMissing, warn } from "./log.js";
import { fingerprint, identityHolds, makeIdentity, type TlsIdentity } from "./tlsCert.js";

/** The port sharing asks for first. Once it has one it keeps it — every
 *  paired device knows this computer by it. */
export const SHARING_PORT = 7775;

/** The UDP port a device's broadcast asks "is ruri here?" on, and what it
 *  asks — the same on every computer, whatever port sharing has. */
export const DISCOVERY_PORT = 7775;
export const DISCOVERY_ASK = "ruri?1";

/** How long an invite lets a device in for. */
const INVITE_MS = 15 * 60_000;

/** Invites open at once; the oldest goes when another is made. */
const OPEN_INVITES = 5;

/** Wrong proofs an invite takes before it is put away. */
const INVITE_MISSES = 5;

/** How long a device has between hello and proof. */
const HELLO_MS = 2 * 60_000;

/** Wrong proofs allowed a minute before pairing is turned away for a while. */
const PAIR_FAILURES_PER_MINUTE = 20;

/** The cookie a device's key rides in, for what a page loads by itself
 *  (images, audio, the PDF viewer) that cannot carry a header. */
const COOKIE = "ruri_device";

interface StoredDevice {
  id: string;
  name: string;
  pairedAt: number;
  lastSeen?: number;
  /** sha256 of its key, hex: the key itself is only ever on the device. */
  keyHash: string;
}

interface Stored {
  on: boolean;
  port?: number;
  devices: StoredDevice[];
}

/** What a newly paired device is given: its key, and how to find and
 *  trust this computer from now on. */
export interface Pairing {
  ok: true;
  deviceId: string;
  key: string;
  name: string;
  addresses: string[];
  port: number;
  fingerprint: string;
}

/** An open invite: its words' key (never the words), until when, and how
 *  many wrong proofs it has had. */
interface OpenInvite {
  key: Buffer;
  expires: number;
  misses: number;
}

/** Which device a window that came in through sharing belongs to. */
export interface Seat {
  deviceId: string;
  name: string;
}

/** What sharing needs of the rest of the server. */
export interface SharingHooks {
  /** Serve a request the door has let in, as the local window's would be. */
  serve(req: http.IncomingMessage, res: http.ServerResponse): void;
  /** The socket server on this door (server/socket.ts). */
  sockets(server: https.Server): WebSocketServer;
  /** Close every window this device has open. */
  closeDevice(deviceId: string): void;
  /** Sharing changed. */
  changed(info: SharingInfo): void;
}

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

/** A device's name, as it gave it: one line, not too long. */
function cleanName(raw: unknown): string {
  const text = typeof raw === "string" ? raw.replace(/\p{Cc}/gu, " ").trim() : "";
  return text.slice(0, 64) || "a device";
}

/** This computer's name, as a person would say it. */
export function computerName(): string {
  return os.hostname().replace(/\.local$/i, "") || "this computer";
}

/** Interfaces that lead nowhere another device is: containers' bridges and
 *  the like. */
const INNER_INTERFACE = /^(lo|docker|br-|veth|virbr|vmnet|vboxnet|lxc|lxd|cni|flannel|kube|podman)/i;

/**
 * Where another device might reach this computer: its IPv4 address on
 * every network it is on — the LAN's, a Tailscale or makima mesh's — and
 * then its name, which a mesh's DNS or the LAN's mDNS may answer for. The
 * device tries them all at once and keeps the first that answers.
 */
export function reachableAddresses(): string[] {
  const ips: string[] = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (INNER_INTERFACE.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      if (entry.address.startsWith("169.254.")) continue;
      if (!ips.includes(entry.address)) ips.push(entry.address);
    }
  }
  const host = os.hostname();
  const names = host && host !== "localhost" ? [host] : [];
  if (host && !host.includes(".")) names.push(`${host}.local`);
  return [...ips, ...names];
}

/** The key a request shows: the header, the URL, or the cookie. */
function presentedKey(req: http.IncomingMessage): { key: string; from: "header" | "query" | "cookie" } {
  const header = req.headers["x-ruri-token"];
  if (typeof header === "string" && header) return { key: header, from: "header" };
  const query = new URL(req.url ?? "/", "https://ruri").searchParams.get("token");
  if (query) return { key: query, from: "query" };
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE) return { key: decodeURIComponent(value.join("=")), from: "cookie" };
  }
  return { key: "", from: "header" };
}

/** A page's Origin, if it sent one, must be the door itself. */
function originOk(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin === undefined || origin === `https://${req.headers.host ?? ""}`;
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export class Sharing {
  private stored: Stored;
  private server: https.Server | undefined;
  private wss: WebSocketServer | undefined;
  private error: string | undefined;
  /** The invites not yet used, newest last. */
  private invites: OpenInvite[] = [];
  /** Each hello's number, and until when a proof may follow it. */
  private readonly hellos = new Map<string, number>();
  /** What answers a LAN's "is ruri here?". */
  private beacon: dgram.Socket | undefined;
  /** Open windows per device. */
  private readonly windows = new Map<string, number>();
  /** When the recent wrong codes came. */
  private failures: number[] = [];
  private hooks: SharingHooks | undefined;

  constructor() {
    this.stored = this.read();
  }

  /** Wire it to the server, and open the door if it was left open. */
  start(hooks: SharingHooks): void {
    this.hooks = hooks;
    if (this.stored.on) void this.open();
  }

  /** What the settings page shows. */
  info(): SharingInfo {
    return {
      on: this.stored.on,
      name: computerName(),
      port: this.port(),
      addresses: this.stored.on ? reachableAddresses() : [],
      devices: this.stored.devices.map((d): SharedDevice => ({
        id: d.id,
        name: d.name,
        pairedAt: d.pairedAt,
        ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}),
        online: (this.windows.get(d.id) ?? 0) > 0,
      })),
      ...(this.error ? { error: this.error } : {}),
    };
  }

  /** Whether the door is open and listening. */
  listening(): boolean {
    return this.server?.listening === true;
  }

  /** Turn sharing on or off; resolves once the door is open or shut. */
  async set(on: boolean): Promise<void> {
    if (on === this.stored.on && (on ? this.listening() : !this.server)) return;
    this.stored.on = on;
    this.save();
    if (on) await this.open();
    else await this.shut();
  }

  /** Six words that let one more device in — sharing on first, if it was
   *  off. The words go to whoever asked and are not kept here. */
  async invite(): Promise<{ words: string[]; expires: number; name: string }> {
    await this.ensureOpen();
    const words = makeWords();
    const key = await wordsKey(words);
    const expires = Date.now() + INVITE_MS;
    this.invites = [...this.live().slice(-(OPEN_INVITES - 1)), { key, expires, misses: 0 }];
    return { words, expires, name: computerName() };
  }

  /**
   * A key for a device, with no invite: for the device's own shell, signed
   * in here over SSH and asking on this computer's local port with its
   * token (desktop/sshSetup.ts). Sharing on first, if it was off.
   */
  async pairDirect(name: unknown): Promise<Pairing> {
    await this.ensureOpen();
    return this.admit(name);
  }

  /** Unpair a device: its key stops working, its windows close. */
  forget(deviceId: string): void {
    const before = this.stored.devices.length;
    this.stored.devices = this.stored.devices.filter((d) => d.id !== deviceId);
    if (this.stored.devices.length === before) return;
    this.save();
    this.windows.delete(deviceId);
    this.hooks?.closeDevice(deviceId);
    this.changed();
  }

  /** A window of this device connected. */
  arrived(deviceId: string): void {
    this.windows.set(deviceId, (this.windows.get(deviceId) ?? 0) + 1);
    this.seen(deviceId);
  }

  /** A window of this device went. */
  left(deviceId: string): void {
    const open = (this.windows.get(deviceId) ?? 1) - 1;
    if (open > 0) this.windows.set(deviceId, open);
    else this.windows.delete(deviceId);
    this.seen(deviceId);
  }

  /** The device a request or a socket upgrade shows the key of, if any. */
  deviceFor(req: http.IncomingMessage): Seat | undefined {
    const { key } = presentedKey(req);
    if (!key) return undefined;
    const hash = Buffer.from(hashKey(key), "hex");
    const device = this.stored.devices.find((d) => {
      const stored = Buffer.from(d.keyHash, "hex");
      return stored.length === hash.length && timingSafeEqual(stored, hash);
    });
    return device ? { deviceId: device.id, name: device.name } : undefined;
  }

  /** What a socket upgrade at this door is refused with — 0 lets it in. */
  refusal(origin: string | undefined, req: http.IncomingMessage): number {
    if (origin !== undefined && origin !== `https://${req.headers.host ?? ""}`) return 403;
    return this.deviceFor(req) ? 0 : 401;
  }

  /** Shut the door, for the server's own close. */
  close(): Promise<void> {
    return this.shut(false);
  }

  /* ── the door ─────────────────────────────────────────────────────── */

  private port(): number {
    return this.stored.port ?? SHARING_PORT;
  }

  private async ensureOpen(): Promise<void> {
    if (!this.listening()) await this.set(true);
    if (!this.listening()) throw new Error(this.error ?? "sharing could not be turned on");
  }

  /** The invites still open, the run-out ones put away. */
  private live(): OpenInvite[] {
    const now = Date.now();
    this.invites = this.invites.filter((i) => i.expires > now && i.misses < INVITE_MISSES);
    return this.invites;
  }

  /** A new device, its key made and handed back with everything it needs
   *  to find and trust this computer. */
  private admit(rawName: unknown): Pairing {
    const key = randomBytes(32).toString("base64url");
    const device: StoredDevice = {
      id: randomBytes(6).toString("hex"),
      name: cleanName(rawName),
      pairedAt: Date.now(),
      keyHash: hashKey(key),
    };
    this.stored.devices.push(device);
    this.save();
    this.changed();
    console.log(`ruri: paired ${device.name}`);
    return {
      ok: true,
      deviceId: device.id,
      key,
      name: computerName(),
      addresses: reachableAddresses(),
      port: this.port(),
      fingerprint: fingerprint(this.identity().cert),
    };
  }

  /** Answer a LAN's broadcast "is ruri here?" — so a device on the same
   *  network finds this computer without being told where it is. The
   *  answer is only a hint: what pairs is the words, or SSH. */
  private listenForAsks(): void {
    if (this.beacon) return;
    const beacon = dgram.createSocket({ type: "udp4", reuseAddr: true });
    beacon.on("message", (msg, from) => {
      if (msg.toString("utf8") !== DISCOVERY_ASK) return;
      const answer = JSON.stringify({ service: "ruri", name: computerName(), port: this.port() });
      beacon.send(answer, from.port, from.address);
    });
    beacon.on("error", (err) => {
      warn("sharing", err, "answering the LAN's asks");
      beacon.close();
      if (this.beacon === beacon) this.beacon = undefined;
    });
    beacon.bind(DISCOVERY_PORT);
    this.beacon = beacon;
  }

  private async open(): Promise<void> {
    if (this.server || !this.hooks) return;
    const hooks = this.hooks;
    let identity: TlsIdentity;
    try {
      identity = this.identity();
    } catch (err) {
      this.error = `ruri could not make its certificate: ${errorMessage(err)}`;
      this.changed();
      return;
    }
    const server = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) =>
      this.handle(req, res),
    );
    this.server = server;
    this.wss = hooks.sockets(server);
    // the port this computer is known by: the first time, 7775 or any the
    // system has free; after that, only the one the devices were given
    const wanted = this.stored.port;
    const listen = (port: number, host: string) =>
      new Promise<void>((resolve, reject) => {
        const fail = (err: Error) => {
          server.off("listening", ok);
          reject(err);
        };
        const ok = () => {
          server.off("error", fail);
          resolve();
        };
        server.once("error", fail);
        server.once("listening", ok);
        server.listen(port, host);
      });
    const attempt = async (port: number): Promise<void> => {
      try {
        // "::" takes IPv4 as well wherever IPv6 is on; where it is off,
        // 0.0.0.0
        await listen(port, "::");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EAFNOSUPPORT") throw err;
        await listen(port, "0.0.0.0");
      }
    };
    try {
      try {
        await attempt(wanted ?? SHARING_PORT);
      } catch (err) {
        if (wanted !== undefined || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        await attempt(0);
      }
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : SHARING_PORT;
      if (this.stored.port !== port) {
        this.stored.port = port;
        this.save();
      }
      this.error = undefined;
      server.on("error", (err) => warn("sharing", err, "the door"));
      this.listenForAsks();
      console.log(`ruri: other devices can use this computer — port ${port}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      this.error =
        code === "EADDRINUSE"
          ? `Port ${this.port()} is taken by another program, and your devices know this computer by it. Free it and turn sharing on again.`
          : `Sharing could not start: ${errorMessage(err)}`;
      warn("sharing", err, "opening the door");
      this.wss?.close();
      this.wss = undefined;
      this.server = undefined;
    }
    this.changed();
  }

  private shut(announce = true): Promise<void> {
    const server = this.server;
    const wss = this.wss;
    this.server = undefined;
    this.wss = undefined;
    this.invites = [];
    this.hellos.clear();
    this.beacon?.close();
    this.beacon = undefined;
    if (!server) return Promise.resolve();
    return new Promise((resolve) => {
      for (const client of wss?.clients ?? []) client.close(4001, "sharing turned off");
      wss?.close();
      server.closeAllConnections();
      server.close(() => {
        if (announce) this.changed();
        resolve();
      });
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";
    // whether this is a ruri at all, before a device has a key — and with
    // one, where else it might reach this computer next time
    if (pathname === "/remote/hello" && req.method === "GET") {
      const seat = this.deviceFor(req);
      json(res, 200, {
        service: "ruri",
        ...(seat ? { name: computerName(), addresses: reachableAddresses(), port: this.port() } : {}),
        paired: Boolean(seat),
      });
      return;
    }
    if (pathname === "/pair/hello" && req.method === "POST") {
      void this.pairHello(req, res);
      return;
    }
    if (pathname === "/pair/prove" && req.method === "POST") {
      void this.pairProve(req, res);
      return;
    }
    if (!originOk(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const { from } = presentedKey(req);
    const seat = this.deviceFor(req);
    if (!seat) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      res.end(`This device is not paired with ${computerName()}.`);
      return;
    }
    // the page came with its key in the URL: everything it loads by
    // itself after that carries it as a cookie
    if (from === "query" && req.method === "GET") {
      res.setHeader(
        "set-cookie",
        `${COOKIE}=${encodeURIComponent(presentedKey(req).key)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`,
      );
    }
    this.hooks?.serve(req, res);
  }

  /** A body as JSON, or a 400 said and undefined. */
  private async body(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const parsed = JSON.parse(await readBody(req, 4096)) as unknown;
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
      throw new Error("not an object");
    } catch (err) {
      json(res, 400, { ok: false, error: `bad request: ${errorMessage(err)}` });
      return undefined;
    }
  }

  /** Whether pairing is being hammered; said if so. */
  private hammered(res: http.ServerResponse): boolean {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length < PAIR_FAILURES_PER_MINUTE) return false;
    json(res, 429, { ok: false, error: "Too many wrong words — wait a minute." });
    return true;
  }

  /**
   * The first half of pairing by words: the device's number in, this
   * computer's number and its proof of each open invite's words out —
   * MACs over this computer's certificate, which the device checks against
   * the certificate it sees (server/invite.ts).
   */
  private async pairHello(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.hammered(res)) return;
    const body = await this.body(req, res);
    if (!body) return;
    const deviceNonce = typeof body["nonce"] === "string" ? body["nonce"].slice(0, 64) : "";
    const invites = this.live();
    if (!deviceNonce || !invites.length) {
      json(res, 404, {
        ok: false,
        error: `No invite is open on ${computerName()} — make one there (Settings, Devices, Invite a device).`,
      });
      return;
    }
    const now = Date.now();
    for (const [n, until] of this.hellos) if (until <= now) this.hellos.delete(n);
    const hostNonce = nonce();
    this.hellos.set(hostNonce, now + HELLO_MS);
    const print = fingerprint(this.identity().cert);
    json(res, 200, {
      ok: true,
      name: computerName(),
      nonce: hostNonce,
      macs: invites.map((i) => pairMac(i.key, "host", print, deviceNonce, hostNonce)),
    });
  }

  /** The second half: the device's proof of the words, and if it holds,
   *  the device's key. One proof per hello. */
  private async pairProve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (this.hammered(res)) return;
    const body = await this.body(req, res);
    if (!body) return;
    const str = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : "");
    const hostNonce = str("hostNonce");
    const until = this.hellos.get(hostNonce);
    this.hellos.delete(hostNonce);
    if (!until || until <= Date.now()) {
      json(res, 403, { ok: false, error: "That pairing took too long — try again." });
      return;
    }
    const print = fingerprint(this.identity().cert);
    const invites = this.live();
    const matched = invites.find((i) =>
      macsMatch(pairMac(i.key, "device", print, str("nonce"), hostNonce), str("mac")),
    );
    if (!matched) {
      this.failures.push(Date.now());
      for (const i of invites) i.misses += 1;
      json(res, 403, { ok: false, error: "Those aren't the words — check them on the other computer." });
      return;
    }
    this.invites = this.invites.filter((i) => i !== matched);
    json(res, 200, this.admit(body["name"]));
  }

  /* ── what is kept ─────────────────────────────────────────────────── */

  private seen(deviceId: string): void {
    const device = this.stored.devices.find((d) => d.id === deviceId);
    if (device) {
      device.lastSeen = Date.now();
      this.save();
    }
    this.changed();
  }

  private changed(): void {
    this.hooks?.changed(this.info());
  }

  private read(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath("sharing.json"), "utf8")) as Partial<Stored>;
      return {
        on: raw.on === true,
        ...(typeof raw.port === "number" ? { port: raw.port } : {}),
        devices: Array.isArray(raw.devices)
          ? raw.devices.filter(
              (d): d is StoredDevice =>
                typeof d?.id === "string" && typeof d.keyHash === "string" && typeof d.name === "string",
            )
          : [],
      };
    } catch (err) {
      if (!isMissing(err)) warn("sharing", err, "reading sharing.json");
      return { on: false, devices: [] };
    }
  }

  private save(): void {
    try {
      writeJsonAtomic(configPath("sharing.json"), this.stored, 2, 0o600);
    } catch (err) {
      warn("sharing", err, "writing sharing.json");
    }
  }

  private cached: TlsIdentity | undefined;

  /** The door's key and certificate: made once and kept, since every
   *  paired device has pinned this certificate. */
  private identity(): TlsIdentity {
    if (this.cached) return this.cached;
    const keyFile = configPath("sharing", "key.pem");
    const certFile = configPath("sharing", "cert.pem");
    try {
      const kept = { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") };
      if (identityHolds(kept)) return (this.cached = kept);
      warn("sharing", "key and certificate do not match", "making new ones");
    } catch (err) {
      if (!isMissing(err)) warn("sharing", err, "reading the certificate");
    }
    const made = makeIdentity();
    writeTextAtomic(keyFile, made.key, 0o600);
    writeTextAtomic(certFile, made.cert, 0o600);
    return (this.cached = made);
  }
}
