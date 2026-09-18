/**
 * The bridge's life between turns: what a channel's window is showing,
 * whether the user has taken it over, and the moment's grace before it
 * closes once the turn is done.
 */
import * as fs from "node:fs";
import type { ServerMessage } from "../shared/protocol.js";
import { bridgeDir, type BridgeHost } from "./bridge.js";
import { warn } from "./log.js";

/**
 * The bridge closes when a turn is over.
 *
 * A session opens a hidden window (or launches an app) to look at what it
 * built, and used to leave it there — a page running at full speed, and
 * its renderer's hundred-odd megabytes — until the session itself was
 * closed or the model thought to call web_close. Now whatever a channel
 * holds is closed a moment after its turn ends, unless the user has taken
 * it over to work in. A window handed back while nothing is running goes
 * the same way. The moment's grace is for a queued prompt, which starts
 * the next turn straight away and wants the page it was just looking at.
 */
const BRIDGE_GRACE_MS = 3000;

export class BridgeState {
  private readonly closers = new Map<string, NodeJS.Timeout>();
  /** Whether each channel's window was last seen taken over. */
  private readonly takenOver = new Map<string, boolean>();

  constructor(
    private readonly host: BridgeHost | undefined,
    /** A turn is running (or blocked on permission) in the channel. */
    private readonly busy: (channelId: string) => boolean,
    broadcast: (message: ServerMessage) => void,
  ) {
    // what the bridge is showing for a channel, as it changes — the strip
    // beside that channel's composer follows it
    host?.onState((channelId, state) => {
      broadcast({ type: "bridge", projectId: channelId, state });
      const was = this.takenOver.get(channelId) === true;
      if (state) this.takenOver.set(channelId, state.takenOver);
      else this.takenOver.delete(channelId);
      // handed back with no turn running: nobody is driving it any more
      if (was && state && !state.takenOver && !this.busy(channelId)) this.closeBridgeSoon(channelId);
    });
  }

  closeBridgeSoon = (channelId: string): void => {
    if (!this.host) return;
    this.cancelBridgeClose(channelId);
    const timer = setTimeout(() => {
      this.closers.delete(channelId);
      const state = this.host?.states()[channelId];
      if (!state || state.takenOver || this.busy(channelId)) return;
      void this.host?.close(channelId);
    }, BRIDGE_GRACE_MS);
    timer.unref?.();
    this.closers.set(channelId, timer);
  };

  cancelBridgeClose = (channelId: string): void => {
    const timer = this.closers.get(channelId);
    if (!timer) return;
    clearTimeout(timer);
    this.closers.delete(channelId);
  };

  /** The session's window and apps go with it, and so do its pictures. */
  closeBridge = (sessionId: string): void => {
    void this.host?.close(sessionId);
    try {
      fs.rmSync(bridgeDir(sessionId), { recursive: true, force: true });
    } catch (err) {
      warn("server", err, "closeBridge");
      // best-effort
    }
  };

  forgetChannel(sessionId: string): void {
    this.closeBridge(sessionId);
  }
}
