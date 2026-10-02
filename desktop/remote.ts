/**
 * This device, using another computer's ruri.
 *
 * Paired with another computer — by the six words of its invite, or over
 * SSH (desktop/sshSetup.ts) — the shell keeps it in <configDir>/remote.json:
 * its addresses, its certificate's fingerprint, the key it gave this
 * device. From then on the window can be onto it: no server of its own, no
 * harnesses, nothing running here but the page. Which computer the window
 * is onto is the user's choice, kept in the same file, and "this computer"
 * is always one of them.
 *
 * The other computer's certificate is its own, not an authority's
 * (server/tlsCert.ts), so Chromium would refuse it. The shell tells
 * Chromium which certificate is whose: for every address a paired
 * computer goes by, the certificate must be the pinned one — anything else
 * is refused outright, even one an authority vouches for. An address no
 * paired computer goes by may be looked at (is ruri there? which
 * certificate?) but sent nothing secret: pairing by words proves the words
 * against the very certificate it saw (server/invite.ts).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import { net, type Session } from "electron";
import { writeJsonAtomic } from "../server/atomic.js";
import { configPath } from "../server/configDir.js";
import { macsMatch, nonce, pairMac, urlHost, wordsKey } from "../server/invite.js";
import { errorMessage, isMissing, warn } from "../server/log.js";
import type { Pairing } from "../server/sharing.js";
import { fingerprint } from "../server/tlsCert.js";

/** A computer this device is paired with. */
export interface Host {
  /** Its certificate's fingerprint: what makes it that computer. */
  id: string;
  name: string;
  addresses: string[];
  port: number;
  /** This device's id there. */
  deviceId: string;
  /** The key it gave this device. */
  key: string;
  pairedAt: number;
}

interface Stored {
  /** The computer the window is onto; absent, this one. */
  use?: string;
  hosts: Host[];
}

/** Somewhere ruri may be: an address and the port sharing listens on. */
export interface Spot {
  address: string;
  port: number;
}

/** How long one address is given to answer. */
const REACH_MS = 4_000;

/** Why a computer could not be used. */
export class Unreachable extends Error {
  constructor(
    message: string,
    /** The computer answered, and no longer knows this device. */
    readonly unpaired = false,
  ) {
    super(message);
  }
}

const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "").toLowerCase();

export class Remote {
  private stored: Stored;
  /** The certificate each address last showed, by address. */
  private readonly seen = new Map<string, string>();
  /** Addresses being looked at right now (probed, or paired with by
   *  words), and by how many asks: only these may show a certificate no
   *  one has pinned. Everywhere else is Chromium's to judge, as ever. */
  private readonly looking = new Map<string, number>();

  constructor() {
    this.stored = this.read();
  }

  hosts(): Host[] {
    return this.stored.hosts;
  }

  /** The computer the window is onto, or undefined for this one. */
  current(): Host | undefined {
    return this.stored.hosts.find((h) => h.id === this.stored.use);
  }

  /** Make `id` the computer the window is onto — undefined for this one. */
  use(id: string | undefined): void {
    if (id === undefined) delete this.stored.use;
    else this.stored.use = id;
    this.save();
  }

  /** Unpair, as far as this device goes. */
  forget(id: string): void {
    this.stored.hosts = this.stored.hosts.filter((h) => h.id !== id);
    if (this.stored.use === id) delete this.stored.use;
    this.save();
  }

  /**
   * Teach a session which certificates are which computer's. Every
   * address a paired computer goes by gets its pinned certificate or
   * nothing. Any other address may be looked at, and what it showed is
   * noted; nothing secret goes to one until it has proved itself.
   */
  pin(session: Session): void {
    session.setCertificateVerifyProc((request, callback) => {
      let shown = "";
      try {
        shown = fingerprint(request.certificate.data);
      } catch (err) {
        warn("remote", err, "reading a certificate");
      }
      const name = bare(request.hostname);
      if (shown) this.seen.set(name, shown);
      const pinned = this.pinnedFor(name);
      if (pinned.size) callback(pinned.has(shown) ? 0 : -2);
      else callback(this.looking.has(name) ? 0 : -3);
    });
  }

  /** The paired computer whose certificate this is, if any. */
  hostBy(fingerprintSeen: string): Host | undefined {
    return this.stored.hosts.find((h) => h.id === fingerprintSeen);
  }

  /** Whether ruri answers at a spot, and which certificate it showed —
   *  asked without a key, so nothing secret goes to a stranger. */
  async probe(spot: Spot): Promise<{ fingerprint: string } | undefined> {
    const done = this.look(spot.address);
    try {
      const res = await net.fetch(`https://${urlHost(spot.address)}:${spot.port}/remote/hello`, {
        signal: AbortSignal.timeout(REACH_MS),
        cache: "no-store",
      });
      const body = (await res.json()) as { service?: string };
      const shown = this.seen.get(bare(spot.address));
      return body.service === "ruri" && shown ? { fingerprint: shown } : undefined;
    } catch {
      return undefined;
    } finally {
      done();
    }
  }

  /**
   * Pair by an invite's words with whichever of these spots made it: each
   * is asked in turn to prove the words over the certificate it shows, and
   * the one that can is shown this device's proof and gives it a key.
   */
  async pairWords(words: string[], spots: Spot[]): Promise<{ host: Host; address: string }> {
    if (!spots.length) {
      throw new Unreachable("No computer with sharing on was found. Add it by its address, or use SSH.");
    }
    const key = await wordsKey(words);
    let lastError = "";
    for (const spot of spots) {
      const base = `https://${urlHost(spot.address)}:${spot.port}`;
      const done = this.look(spot.address);
      try {
        const mine = nonce();
        const hello = (await this.post(`${base}/pair/hello`, { nonce: mine })) as {
          ok?: boolean;
          error?: string;
          nonce?: string;
          macs?: string[];
        };
        if (!hello.ok || !hello.nonce || !hello.macs) {
          lastError = hello.error ?? lastError;
          continue;
        }
        // the certificate this connection showed: a computer in the middle
        // would have shown its own, and could not have made a MAC over it
        const shown = this.seen.get(bare(spot.address));
        if (!shown) continue;
        const proved = hello.macs.some((mac) =>
          macsMatch(mac, pairMac(key, "host", shown, mine, hello.nonce!)),
        );
        if (!proved) continue;
        const answer = (await this.post(`${base}/pair/prove`, {
          nonce: mine,
          hostNonce: hello.nonce,
          mac: pairMac(key, "device", shown, mine, hello.nonce),
          name: computerName(),
        })) as Partial<Pairing> & { error?: string };
        if (!answer.ok || !answer.key || answer.fingerprint !== shown) {
          throw new Unreachable(answer.error ?? "It would not pair.");
        }
        return { host: this.adopt(answer as Pairing, spot.address), address: spot.address };
      } catch (err) {
        if (err instanceof Unreachable) throw err;
        lastError = errorMessage(err);
      } finally {
        done();
      }
    }
    throw new Unreachable(
      lastError && !/fetch|network|abort|timed out/i.test(lastError)
        ? lastError
        : "No computer here made those words. Check them, or make a new invite.",
    );
  }

  /**
   * Keep a computer this device has just been paired with — from words,
   * or from SSH, where the pairing came over the signed-in channel and its
   * fingerprint can be trusted as it stands. `reachedAt` goes first: it is
   * known to work.
   */
  adopt(pairing: Pairing, reachedAt?: string): Host {
    const host: Host = {
      id: pairing.fingerprint,
      name: pairing.name,
      addresses: merge(reachedAt ? [reachedAt] : [], pairing.addresses),
      port: pairing.port,
      deviceId: pairing.deviceId,
      key: pairing.key,
      pairedAt: Date.now(),
    };
    this.stored.hosts = [...this.stored.hosts.filter((h) => h.id !== host.id), host];
    this.save();
    return host;
  }

  /**
   * Find the computer: every address it goes by at once, the first to
   * answer as ruri, knowing this device, wins. Where else it can be
   * reached now is kept for next time — a laptop at home and away sees it
   * at different addresses.
   */
  async reach(host: Host): Promise<string> {
    try {
      return await Promise.any(host.addresses.map((a) => this.hello(a, host).then(() => a)));
    } catch (err) {
      const unpaired =
        err instanceof AggregateError && err.errors.some((e) => e instanceof Unreachable && e.unpaired);
      throw unpaired
        ? new Unreachable(`Pair again with a new invite from ${host.name}.`, true)
        : new Unreachable(`Can't reach ${host.name}.`);
    }
  }

  /** Whether the computer still answers at `address`, knowing this device. */
  async answers(host: Host, address: string): Promise<boolean> {
    try {
      await this.hello(address, host);
      return true;
    } catch {
      return false;
    }
  }

  /* ── underneath ───────────────────────────────────────────────────── */

  /** Look at an address for a while; call what this returns when done. */
  private look(address: string): () => void {
    const name = bare(address);
    this.looking.set(name, (this.looking.get(name) ?? 0) + 1);
    return () => {
      const left = (this.looking.get(name) ?? 1) - 1;
      if (left > 0) this.looking.set(name, left);
      else this.looking.delete(name);
    };
  }

  private pinnedFor(name: string): Set<string> {
    const found = new Set<string>();
    for (const host of this.stored.hosts) {
      if (host.addresses.some((a) => a.toLowerCase() === name)) found.add(host.id);
    }
    return found;
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const res = await net.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
    return res.json();
  }

  /** Ask one address whether it is this computer's ruri, still knowing this
   *  device — and where else it is now. Pinned: the key goes to no other. */
  private async hello(address: string, host: Host): Promise<void> {
    const res = await net.fetch(`https://${urlHost(address)}:${host.port}/remote/hello`, {
      headers: { "x-ruri-token": host.key },
      signal: AbortSignal.timeout(REACH_MS),
      // a dead address must not be answered from a cache
      cache: "no-store",
    });
    const body = (await res.json()) as { service?: string; paired?: boolean; addresses?: string[] };
    if (body.service !== "ruri") throw new Error(`${address} is not ruri`);
    if (!body.paired) throw new Unreachable(`${address} no longer knows this device`, true);
    if (body.addresses?.length) {
      const addresses = merge(host.addresses, body.addresses);
      if (addresses.join() !== host.addresses.join()) {
        host.addresses = addresses;
        this.save();
      }
    }
  }

  private read(): Stored {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath("remote.json"), "utf8")) as Partial<Stored>;
      const hosts = Array.isArray(raw.hosts)
        ? raw.hosts.filter(
            (h): h is Host =>
              typeof h?.id === "string" &&
              typeof h.key === "string" &&
              typeof h.port === "number" &&
              Array.isArray(h.addresses),
          )
        : [];
      return { ...(typeof raw.use === "string" ? { use: raw.use } : {}), hosts };
    } catch (err) {
      if (!isMissing(err)) warn("remote", err, "reading remote.json");
      return { hosts: [] };
    }
  }

  private save(): void {
    try {
      // the keys are in here: this user's only
      writeJsonAtomic(configPath("remote.json"), this.stored, 2, 0o600);
    } catch (err) {
      warn("remote", errorMessage(err), "writing remote.json");
    }
  }
}

/** Every address once, the first lists' first. */
function merge(...lists: string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) for (const a of list) if (a && !out.includes(a)) out.push(a);
  return out;
}

/** What this device calls itself, for the other computer's list. */
export function computerName(): string {
  return os.hostname().replace(/\.local$/i, "") || "a device";
}
