import * as net from "node:net";

/**
 * The port is the app's identity, not an implementation detail: the window is
 * a page served from it, so the port is the origin, and the origin is what
 * everything the window keeps for itself is filed under. Coming up on some
 * other port is therefore not a graceful degradation — it is a ruri that has
 * forgotten every preference the window owns, for a reason nobody can see.
 *
 * What takes the port is a ruri that outlived its app. `make install` never
 * deletes the bundle of a running app, it moves it aside, and a rename keeps
 * the inode: a server from the superseded bundle carries on serving out of a
 * path that no longer exists, holding the port, long after the app that
 * spawned it is gone. Every launch after that finds the port taken and
 * quietly steps around it.
 *
 * So the port is claimed rather than hoped for. Whoever holds it is asked who
 * they are, and a ruri that is not this one is one of those leftovers — only
 * one ruri runs at a time, since desktop/main.ts takes the single-instance
 * lock before any of this — so it is retired and the port comes back. Any
 * other program is left alone and the caller goes around it.
 */

/** How long the holder is given to let go after being asked, and after being told. */
const GRACE_MS = 8_000;
const FORCE_MS = 3_000;

/** Long enough for a busy server to answer, short enough not to stall a launch. */
const PROBE_MS = 1_500;

/** How often the port is re-checked while waiting for it to come free. */
const POLL_MS = 100;

export type PortClaim =
  /** Nothing was on the port, or nothing is on it any more. */
  | { outcome: "free" }
  /** A ruri that outlived its app had it, and has been retired. */
  | { outcome: "reclaimed"; pid: number }
  /** Something else has it and is staying — the caller must fall back. */
  | { outcome: "held"; reason: string };

/**
 * Is anything accepting connections there? A refused connection is the only
 * answer that means "free"; anything else — including a connect that hangs —
 * is treated as occupied, since the cost of being wrong that way is a
 * fallback rather than two servers racing for one port.
 */
function listening(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const answer = (occupied: boolean): void => {
      socket.destroy();
      resolve(occupied);
    };
    socket.setTimeout(PROBE_MS);
    socket.once("connect", () => answer(true));
    socket.once("timeout", () => answer(true));
    socket.once("error", () => answer(false));
  });
}

/** Ask whoever is on the port who they are (server.ts serves /healthz). */
async function identify(port: number, host: string): Promise<{ service?: string; pid?: number } | null> {
  try {
    const res = await fetch(`http://${host}:${port}/healthz`, {
      signal: AbortSignal.timeout(PROBE_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as { service?: string; pid?: number };
  } catch {
    // not HTTP, not answering, or answering something that isn't JSON
    return null;
  }
}

/** True if the signal landed, or if the process had already gone on its own. */
function signal(pid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    // ESRCH: it exited between the probe and the signal, which is the outcome
    // we were after anyway. EPERM: it is not ours to stop.
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function freed(port: number, host: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  do {
    if (!(await listening(port, host))) return true;
    await new Promise((done) => setTimeout(done, POLL_MS));
  } while (Date.now() < deadline);
  return !(await listening(port, host));
}

/**
 * Get the port, retiring a leftover ruri for it if that is what is in the way.
 * Never touches anything that isn't a ruri, and never the process it is
 * called from.
 */
export async function claimPort(port: number, host: string): Promise<PortClaim> {
  if (!(await listening(port, host))) return { outcome: "free" };

  const holder = await identify(port, host);
  if (holder?.service !== "ruri" || typeof holder.pid !== "number") {
    return { outcome: "held", reason: "another program is using it" };
  }
  // Can't happen — nothing of ours is bound yet — but a server that somehow
  // asked to displace itself should be told no rather than sent a signal.
  if (holder.pid === process.pid) return { outcome: "free" };

  const pid = holder.pid;
  // Ask before telling: ruri writes transcripts and drafts on a debounce, and
  // a signal it never gets to answer loses whatever hadn't landed yet.
  if (!signal(pid, "SIGTERM")) {
    return { outcome: "held", reason: `a ruri (pid ${pid}) that isn't ours to stop has it` };
  }
  if (await freed(port, host, GRACE_MS)) return { outcome: "reclaimed", pid };

  signal(pid, "SIGKILL");
  if (await freed(port, host, FORCE_MS)) return { outcome: "reclaimed", pid };

  return { outcome: "held", reason: `a ruri (pid ${pid}) has it and would not let go` };
}
