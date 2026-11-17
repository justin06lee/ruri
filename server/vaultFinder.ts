import type { VaultDevice, VaultTailnet } from "../shared/protocol.js";
import { readTailnet, type Tailnet } from "./tailnet.js";

/**
 * Where on the tailnet a ghostly vault already runs: each of the user's
 * devices that is on is asked for the public description every
 * Bitwarden-compatible server gives of itself, at the two places
 * `ghostly-server install --tailscale` serves from. Nothing else is sent
 * — signing in is still for a person to do — and nothing is asked of a
 * device shared in from someone else's tailnet.
 *
 * The same look ghostly's own desktop app makes at its sign-in
 * (ghostly's src/tailnet.ts), so the two agree on what a vault is.
 */

/** 443 is where `ghostly-server install --tailscale` serves; 8443 is the
 *  port it suggests when that one is taken. */
const PORTS = [443, 8443];
const PROBE_MS = 4_000;
/** A tailnet can be large; the devices asked are capped. */
const MAX_DEVICES = 40;
/** Never a server, so not listed at all. */
const HANDHELD = new Set(["ios", "android", "tvos"]);

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** What serves a vault at this address, if anything does. */
export async function probeVault(server: string, fetcher: Fetch): Promise<string | undefined> {
  try {
    const response = await fetcher(`${server}/api/config`, {
      signal: AbortSignal.timeout(PROBE_MS),
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!response.ok || !/json/i.test(response.headers.get("content-type") ?? "")) return undefined;
    const config = (await response.json()) as {
      object?: unknown;
      version?: unknown;
      server?: { name?: unknown } | null;
    } | null;
    if (config?.object !== "config" || typeof config.version !== "string") return undefined;
    const name = config.server?.name;
    // Bitwarden's own server leaves the name out; the compatible ones give theirs
    return typeof name === "string" && name.trim() ? name.trim().slice(0, 40) : "Bitwarden";
  } catch {
    return undefined;
  }
}

/** The devices the Passwords page lists: this one first, phones left out. */
function listed(tailnet: Tailnet): Tailnet["devices"] {
  return tailnet.devices
    .filter((d) => !d.shared && d.host !== "" && !HANDHELD.has((d.os ?? "").toLowerCase()))
    .slice(0, MAX_DEVICES);
}

/** Look at the tailnet: every device of the user's, and the vault each one serves. */
export async function findVaults(
  options: { tailnet?: Tailnet; fetch?: Fetch } = {},
): Promise<Omit<VaultTailnet, "looking">> {
  const tailnet = options.tailnet ?? (await readTailnet());
  const at = Date.now();
  if (tailnet.state !== "connected") return { state: tailnet.state, devices: [], at };
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const devices = await Promise.all(
    listed(tailnet).map(async (d): Promise<VaultDevice> => {
      const device: VaultDevice = {
        name: d.name,
        host: d.host,
        ...(d.os ? { os: d.os } : {}),
        online: d.online,
        self: d.self,
        ssh: d.ssh,
      };
      if (!d.online) return device;
      for (const port of PORTS) {
        const server = `https://${d.host}${port === 443 ? "" : `:${port}`}`;
        const software = await probeVault(server, fetcher);
        if (software) return { ...device, vault: { server, software } };
      }
      return device;
    }),
  );
  return { state: "connected", ...(tailnet.name ? { name: tailnet.name } : {}), devices, at };
}
