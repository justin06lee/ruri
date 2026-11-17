/**
 * The user's other computers, as this device can see them: the machines on
 * their tailnet (Tailscale's own list — broadcasts don't cross it), and
 * ruris on the same LAN that answer a broadcast.
 * Each is then asked whether ruri is there with sharing on, and whether it
 * is one this device is already paired with (desktop/remote.ts) — which is
 * what Settings → Devices lists, to set one up over SSH or pair with words.
 */
import * as dgram from "node:dgram";
import * as os from "node:os";
import { DISCOVERY_ASK, DISCOVERY_PORT, SHARING_PORT } from "../server/sharing.js";
import { readTailnet } from "../server/tailnet.js";
import type { Remote, Spot } from "./remote.js";

/** How a computer was found. */
export type Via = "tailscale" | "lan" | "paired";

/** One of the user's computers. */
export interface Peer {
  name: string;
  /** Where it can be reached, the most direct first. */
  addresses: string[];
  via: Via[];
  /** Tailscale says it is up (a LAN answer means it is). */
  online: boolean;
  /** Its OS, where Tailscale says. */
  os?: string;
  /** ruri with sharing on answered here. */
  ruri?: {
    address: string;
    port: number;
    /** The paired computer it is, if this device is paired with it. */
    hostId?: string;
  };
}

/** Tailscale's peers (server/tailnet.ts reads its own CLI). */
async function tailscalePeers(): Promise<Peer[]> {
  const tailnet = await readTailnet();
  return tailnet.devices.flatMap((d) =>
    !d.self && d.addresses.length
      ? [
          {
            name: d.name,
            addresses: [...d.addresses],
            via: ["tailscale" as const],
            online: d.online,
            ...(d.os ? { os: d.os } : {}),
          },
        ]
      : [],
  );
}

/** The broadcast address of every LAN this device is on. */
function broadcastAddresses(): string[] {
  const out = new Set<string>(["255.255.255.255"]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const e of entries ?? []) {
      if (e.internal || e.family !== "IPv4") continue;
      const ip = e.address.split(".").map(Number);
      const mask = e.netmask.split(".").map(Number);
      out.add(ip.map((b, i) => (b & mask[i]!) | (~mask[i]! & 255)).join("."));
    }
  }
  return [...out];
}

/** ruris on the same LAN: ask once, by broadcast, and listen a moment. */
function lanPeers(waitMs = 900): Promise<Peer[]> {
  return new Promise((resolve) => {
    const found = new Map<string, Peer>();
    const socket = dgram.createSocket("udp4");
    const finish = () => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()]);
    };
    socket.on("error", finish);
    socket.on("message", (msg, from) => {
      try {
        const answer = JSON.parse(msg.toString("utf8")) as { service?: string; name?: string; port?: number };
        if (answer.service !== "ruri" || !answer.name) return;
        found.set(from.address, {
          name: answer.name,
          addresses: [from.address],
          via: ["lan"],
          online: true,
          ruri: { address: from.address, port: answer.port ?? SHARING_PORT },
        });
      } catch {
        // not ruri's
      }
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      for (const to of broadcastAddresses()) socket.send(DISCOVERY_ASK, DISCOVERY_PORT, to);
      setTimeout(finish, waitMs);
    });
  });
}

/** A machine's name as a person says it: no ".local" on the end. */
const plain = (name: string) => name.replace(/\.local$/i, "");

/** The same machine under its different names: case, ".local" and a
 *  tailnet's lowercasing aside. */
const key = (name: string) => name.toLowerCase().replace(/\.local$/, "");

/**
 * Every computer this device can see, merged by name, and ruri looked for
 * on each that is up: at the address and port its LAN answer gave, the
 * paired host's own, or sharing's usual port at each address it has.
 */
export async function discover(remote: Remote): Promise<Peer[]> {
  const [tail, lan] = await Promise.all([tailscalePeers(), lanPeers()]);
  const self = key(os.hostname());
  const peers = new Map<string, Peer>();
  for (const peer of [...tail, ...lan]) {
    if (key(peer.name) === self) continue;
    const had = peers.get(key(peer.name));
    if (!had) {
      peers.set(key(peer.name), {
        ...peer,
        name: plain(peer.name),
        addresses: [...peer.addresses],
        via: [...peer.via],
      });
      continue;
    }
    for (const a of peer.addresses) if (!had.addresses.includes(a)) had.addresses.push(a);
    for (const v of peer.via) if (!had.via.includes(v)) had.via.push(v);
    had.online ||= peer.online;
    had.os ??= peer.os;
    had.ruri ??= peer.ruri;
  }
  // a paired computer is listed even when neither the tailnet nor the LAN shows it
  for (const host of remote.hosts()) {
    if (![...peers.values()].some((p) => p.addresses.some((a) => host.addresses.includes(a)))) {
      peers.set(`paired:${host.id}`, {
        name: host.name,
        addresses: [...host.addresses],
        via: ["paired"],
        online: true,
      });
    }
  }
  await Promise.all(
    [...peers.values()].map(async (peer) => {
      if (!peer.online) return;
      const paired = remote.hosts().find((h) => h.addresses.some((a) => peer.addresses.includes(a)));
      const spots: Spot[] = peer.ruri
        ? [{ address: peer.ruri.address, port: peer.ruri.port }]
        : peer.addresses.map((address) => ({ address, port: paired?.port ?? SHARING_PORT }));
      const answers = await Promise.all(
        spots.map(async (spot) => ({ spot, seen: await remote.probe(spot) })),
      );
      const hit = answers.find((a) => a.seen);
      if (!hit?.seen) {
        delete peer.ruri;
        return;
      }
      const host = remote.hostBy(hit.seen.fingerprint);
      peer.ruri = { ...hit.spot, ...(host ? { hostId: host.id } : {}) };
    }),
  );
  return [...peers.values()].sort(
    (a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
  );
}
