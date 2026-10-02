/**
 * The desktop shell the window is in, as against the server it talks to
 * (desktop/preload.ts). Only the desktop app has one — and when its window
 * is onto another computer, the server is over there while this is still
 * here: which computer the window is onto, and pairing with another, are
 * asked of it.
 */
import type { WindowDragPhase } from "../../../shared/protocol";

/** A computer this device is paired with (desktop/remote.ts), keys left out. */
export interface PairedHost {
  id: string;
  name: string;
  addresses: string[];
  pairedAt: number;
}

/** One of the user's other computers, as this device found it
 *  (desktop/peers.ts). */
export interface Peer {
  name: string;
  addresses: string[];
  via: Array<"makima" | "tailscale" | "lan" | "paired">;
  online: boolean;
  os?: string;
  /** ruri with sharing on answered here — and `hostId` if this device is
   *  paired with it. */
  ruri?: { address: string; port: number; hostId?: string };
}

/** What a setup over SSH or a pairing by words came to. */
export interface PairOutcome {
  ok: boolean;
  name?: string;
  error?: string;
  /** What the user can do about a failure: give a password, or let ruri
   *  install itself there. */
  needs?: "password" | "install";
  /** The coding CLIs found on the computer set up. */
  harnesses?: string[];
}

export interface ShellState {
  /** This device's own name. */
  computer: string;
  /** The account this device's user is signed in as — the likely one over
   *  SSH too. */
  user: string;
  /** The computer the window is onto, and where it answered ("" while it
   *  can't be reached) — null when it is this one. */
  using: { id: string; name: string; address: string } | null;
  hosts: PairedHost[];
}

export interface RuriShell {
  version: number;
  state(): Promise<ShellState | null>;
  /** The user's other computers, looked for afresh. */
  peers(): Promise<Peer[]>;
  /** Set a computer up over SSH and pair with it — then the window moves there. */
  setUp(target: {
    user: string;
    address: string;
    install?: boolean;
    password?: string;
  }): Promise<PairOutcome>;
  onSetupStep(listener: (step: string) => void): () => void;
  /** Pair by an invite's six words — then the window moves there. */
  pairWords(ask: { words: string; address?: string; port?: number }): Promise<PairOutcome>;
  /** Switch the window onto a paired computer — null for this one. */
  use(hostId: string | null): Promise<void>;
  forget(hostId: string): Promise<ShellState | null>;
  retry(): Promise<void>;
  windowDrag(phase: WindowDragPhase): void;
}

export const ruriShell: RuriShell | undefined =
  typeof window === "undefined" ? undefined : (window as unknown as { ruriShell?: RuriShell }).ruriShell;
