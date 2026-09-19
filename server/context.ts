/**
 * Everything the server's parts share, as one object handed to each of
 * them: the stores, the two session managers, the live state grouped by
 * what it is for, and the host-provided options. Built once in
 * server/server.ts; every message handler (server/handlers) and every
 * helper takes it as its first argument.
 */
import type { WebSocket } from "ws";
import type {
  ComponentProposal,
  PermissionId,
  PermissionRequest,
  PermissionState,
  TccRow,
} from "../shared/protocol.js";
import type { AgentLogs, Crew } from "./agents.js";
import type { SessionArchive } from "./archive.js";
import type { BridgeHost } from "./bridge.js";
import type { BridgeState } from "./bridgeState.js";
import type { BriefStore } from "./brief.js";
import type { Checkpoints } from "./checkpoints.js";
import type { Clients } from "./clients.js";
import type { DigestFolder } from "./compaction.js";
import type { ComponentHost, ComponentStore } from "./components.js";
import type { DraftStore } from "./drafts.js";
import type { UsageGauges } from "./gauges.js";
import type { HomeLog } from "./homelog.js";
import type { IdeaStore } from "./ideas.js";
import type { LedgerStore } from "./ledger.js";
import type { ManagerHost } from "./manager.js";
import type { Models } from "./models.js";
import type { NoteBackfill } from "./notes.js";
import type { PrefStore } from "./prefs.js";
import type { ProjectStore } from "./projects.js";
import type { SendQueues } from "./queue.js";
import type { ReadableImages } from "./readable.js";
import type { Retries } from "./retry.js";
import type { SecretStore } from "./secrets.js";
import type { SessionManager } from "./sessions.js";
import type { CaptureHost } from "./shots.js";
import type { TurnTracker } from "./smallmodel.js";
import type { Terminals } from "./terminal.js";
import type { TrackerStore } from "./tracker.js";
import type { Turns } from "./turns.js";

export interface StartServerOptions {
  port: number;
  host?: string;
  /**
   * The secret every window and script must present — as ?token= on the
   * WebSocket URL, and as x-ruri-token (or ?token=) on any request that
   * changes something. The server is bound to loopback, but loopback is
   * every page open in every browser on the machine: without this, any
   * site could open the socket and drive an agent. Written to
   * <configDir>/token (mode 0600) for local tooling, removed on close.
   */
  token: string;
  /** When set, GET requests are served from this directory (the built web UI). */
  staticDir?: string;
  /**
   * Host-provided native folder picker (the Electron shell passes one).
   * Resolves to the chosen directory, or null if the user cancelled.
   */
  pickFolder?: () => Promise<string | null>;
  /**
   * Host-provided macOS grants (the Electron shell passes one): what macOS
   * has let ruri do, the asking for it, and the privacy database's rows —
   * see desktop/permissions.ts.
   */
  permissions?: {
    check(): Promise<PermissionState[]>;
    request(id?: PermissionId): Promise<PermissionState[]>;
    rows(): Promise<TccRow[]>;
  };
  /**
   * Host-provided element screenshots (the Electron shell passes one): load
   * a URL in a window nobody sees and photograph the elements named by
   * selector. Absent when ruri runs headless, and then the component sweep
   * names without taking pictures. See server/shots.ts.
   */
  capture?: CaptureHost;
  /**
   * Host-provided bridge (the Electron shell passes one): the hidden
   * windows and launched apps a session drives to see what it built.
   * Absent when ruri runs headless, and then the bridge tools say so.
   * See server/bridge.ts.
   */
  bridge?: BridgeHost;
  /**
   * Take `port` back from a ruri that outlived its app rather than falling
   * back around it (server/port.ts). The desktop shell sets this, because the
   * port it asks for is the app's identity; the dev server and the test
   * harnesses each have a port of their own and leave leftovers alone.
   */
  reclaimPort?: boolean;
}

export interface RuriServer {
  port: number;
  /**
   * Set only when `port` is not the port that was asked for: something else
   * holds that one and this server is on an ephemeral port instead, which
   * means a window served from it will not find anything it filed under the
   * usual origin. The shell says so out loud (desktop/main.ts).
   */
  portFallback?: { wanted: number; reason: string };
  close(): Promise<void>;
}

/** One window's socket. */
export type ClientConn = WebSocket;

/** A component the model has just built, waiting to be named (see
 *  handlers/components.ts). */
export interface PendingComponent {
  channelId: string;
  proposal: ComponentProposal;
  resolve(name: string | null): void;
}

export interface ServerContext {
  readonly options: StartServerOptions;
  /** The port this server actually listens on, known once it does. A
   *  session's bridge endpoint is written with it, and sessions are made
   *  long after. */
  listeningPort: number;

  /* ── the stores ─────────────────────────────────────────────────── */
  readonly store: ProjectStore;
  readonly archive: SessionArchive;
  /** What each subagent did, apart from the chat that started it. */
  readonly agentLogs: AgentLogs;
  readonly crew: Crew;
  /** Home's chat is ephemeral, but its activity persists in the write-ahead
   *  log — appended programmatically per event, grepped by the model. */
  readonly homeLog: HomeLog;
  readonly tracker: TrackerStore;
  readonly briefs: BriefStore;
  /** What every project has spent, by the day — the one count that
   *  survives rewinds, compactions and Home's nightly amnesia. */
  readonly ledger: LedgerStore;
  // the two per-PROJECT boards (everything else here is per session)
  readonly ideas: IdeaStore;
  readonly components: ComponentStore;
  /** The vault: handed to each harness process as $RURI_SECRET_* when it
   *  is built (sessionHost.ts), and to nothing else ruri starts. */
  readonly secrets: SecretStore;
  /** The window's own preferences, kept on this machine rather than in
   *  the window — see server/prefs.ts for why that is not where they
   *  belong. */
  readonly prefs: PrefStore;
  /** Half-written prompts, per channel — outliving both the wiped Home
   *  archive and any rewind that truncates a session's. */
  readonly drafts: DraftStore;
  /** ruri's own file checkpoints, one per prompt, on every harness. */
  readonly checkpoints: Checkpoints;
  /** The composer's terminal mode: a row of shell tabs per channel. */
  readonly terminals: Terminals;
  /** Each chat's condensed oldest exchanges, kept caught up so a
   *  compaction brief lists only the newest (server/compaction.ts). */
  readonly digests: DigestFolder;
  /** Assembles each finished turn for its recall note and role title. */
  turnTracker: TurnTracker;

  /* ── the sessions ───────────────────────────────────────────────── */
  /** The chats: Home and every project session. */
  manager: SessionManager;
  /** The agents the user starts from a chat's agents page (handlers/crew.ts). */
  crewManager: SessionManager;

  /* ── the live state, by what it is for ──────────────────────────── */
  readonly clients: Clients;
  readonly readable: ReadableImages;
  readonly turns: Turns;
  readonly queues: SendQueues;
  /** Recall notes the small model missed, being written after the fact. */
  readonly notes: NoteBackfill;
  readonly retries: Retries;
  readonly models: Models;
  readonly usage: UsageGauges;
  readonly bridge: BridgeState;
  /** The cards up: permissions, questions and components to name. */
  readonly permissions: Map<string, PermissionRequest>;
  /**
   * Components the model has just built, waiting to be named. The card
   * rides the permission channel (it already survives reconnects) and
   * resolves the tool call that raised it, so the model learns the name the
   * user chose.
   */
  readonly pendingComponents: Map<string, PendingComponent>;
  /** Projects mid-sweep (handlers/components.ts). */
  readonly sweeping: Set<string>;
  /** Projects whose repo is being read for their brief right now. */
  readonly catchingUp: Set<string>;
  /** The last thing each of the user's agents said this turn: its report. */
  readonly crewSaid: Map<string, string>;

  /* ── the hosts the models reach the app through ─────────────────── */
  componentHost: ComponentHost;
  managerHost: ManagerHost;

  musicRoot(): string;
}
