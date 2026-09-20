import { create } from "zustand";
import {
  DEFAULT_MODEL,
  HOME_ID,
  HOME_TRANSCRIPT_MAX,
  keepRecent,
  TRANSCRIPT_TAIL,
  briefLine,
  type BridgeState,
  type ClientMessage,
  type Attachment,
  type CommandInfo,
  type ContextUsage,
  type DraftAttachment,
  type EarlierItem,
  type Idea,
  type NamedComponent,
  type SecretMeta,
  type SkillInfo,
  type SubagentState,
  type DraftAttachmentUpload,
  type HomeSettings,
  type ModelChoice,
  type PermissionRequest,
  type PermissionState,
  type PickTarget,
  type TccRow,
  type Project,
  type ProjectStats,
  type Resources,
  type ProjectStatus,
  type QueuedPrompt,
  type RecentSession,
  type ServerMessage,
  type TrackerItem,
  type TranscriptEvent,
  type TurnNote,
  type TurnProgress,
  type UsageLimits,
} from "../../shared/protocol";
import type { ComposerAttachment } from "./components/Attachments";
import { overlay, reuse } from "./lib/transcript";
import { hydratePrefs } from "./prefs";
import { fileToBase64 } from "./lib/files";

export interface Draft {
  messageId: string;
  text: string;
}

/** Unsent composer state, kept per channel so switching sessions never loses
 *  a draft in progress. Module-level (not zustand): the composer remounts per
 *  channel and reads it on mount; a tracker review's generated prompt lands
 *  here too when its channel isn't the active one. */
export interface ComposerDraft {
  text: string;
  atts: ComposerAttachment[];
  /** Next marker number per kind. Regions count across every attachment,
   *  in the order they were drawn — [region #7] is the seventh box in this
   *  prompt, whichever image it sits on. */
  counter: { image: number; video: number; file: number; region: number };
}
export const composerDrafts = new Map<string, ComposerDraft>();

/* A half-written prompt outlives the app, attachments included. The server
   holds it — the window's own storage could not carry the files even if it
   wanted to, and everything else the window keeps for itself is backed by
   the server too (see ./prefs). */
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Channels this window has actually had a draft for. A composer mounts
 *  empty and immediately saves that emptiness; without this, that first
 *  write would race the snapshot and wipe the very draft it is about to
 *  restore. Only a channel we know had something can clear itself. */
const draftedChannels = new Set<string>();
/** Attachment ids the server already has bytes for — everything after the
 *  first save is metadata, so editing a caption never re-uploads a video.
 *  An id only lands here once its save has actually left the socket: the
 *  server drops metadata for a file it never received, so believing a
 *  dropped save went would quietly cost the draft its pictures. */
const storedAttachments = new Set<string>();
/** Channels whose last save never reached the server. They go again, bytes
 *  and all, the moment the socket is back. */
const unsavedDrafts = new Set<string>();

/** Hand the channel's draft to the server, a beat after typing stops. */
function persistDraft(channelId: string, draft: ComposerDraft): void {
  clearTimeout(draftTimers.get(channelId));
  draftTimers.set(
    channelId,
    setTimeout(() => {
      draftTimers.delete(channelId);
      void (async () => {
        const attachments: DraftAttachmentUpload[] = await Promise.all(
          draft.atts.map(async (att) => ({
            id: att.id,
            kind: att.kind,
            mediaType: att.mediaType,
            name: att.name,
            n: att.n,
            ...(att.regions.length ? { regions: att.regions } : {}),
            ...(storedAttachments.has(att.id) ? {} : { data: await fileToBase64(att.file) }),
          })),
        );
        if (send({ type: "draft", projectId: channelId, text: draft.text, attachments })) {
          for (const att of draft.atts) storedAttachments.add(att.id);
          unsavedDrafts.delete(channelId);
        } else {
          unsavedDrafts.add(channelId);
        }
      })();
    }, 400),
  );
}

/** Save again everything the socket dropped while it was down. */
function flushUnsavedDrafts(): void {
  for (const channelId of [...unsavedDrafts]) {
    const draft = composerDrafts.get(channelId);
    if (draft) persistDraft(channelId, draft);
    else if (send({ type: "draft", projectId: channelId, text: "", attachments: [] })) {
      unsavedDrafts.delete(channelId);
    }
  }
}

/** Whether a channel is holding anything worth keeping. */
function hasDraft(draft: ComposerDraft | undefined): boolean {
  return Boolean(draft && (draft.text.trim() || draft.atts.length > 0));
}

/** Write a channel's draft — the one door every composer change goes
 *  through, so what's on screen is what a relaunch brings back. */
export function setComposerDraft(channelId: string, draft: ComposerDraft): void {
  composerDrafts.set(channelId, draft);
  if (draft.text.trim() || draft.atts.length > 0) draftedChannels.add(channelId);
  else if (!draftedChannels.has(channelId)) return;
  persistDraft(channelId, draft);
}

/** The prompt went out (or was thrown away) — the draft goes with it, and
 *  the server hears about that immediately rather than on the debounce. */
export function clearComposerDraft(channelId: string): void {
  for (const att of composerDrafts.get(channelId)?.atts ?? []) storedAttachments.delete(att.id);
  composerDrafts.delete(channelId);
  draftedChannels.delete(channelId);
  clearTimeout(draftTimers.get(channelId));
  draftTimers.delete(channelId);
  // a clear the socket drops would bring the sent prompt back as a draft on
  // the next launch, so it queues behind the reconnect like a save does
  if (send({ type: "draft", projectId: channelId, text: "", attachments: [] })) {
    unsavedDrafts.delete(channelId);
  } else {
    unsavedDrafts.add(channelId);
  }
}

/**
 * Bring a saved draft's attachments back as live files: the bytes are where
 * every other attachment lives, so fetching each one gives the composer a
 * real File again — previews, region crops, and the send path all work on it
 * exactly as they did before the quit. Anything whose file is gone is
 * dropped; its [marker] stays in the text as words.
 */
async function restoreAttachments(channelId: string, saved: DraftAttachment[]): Promise<void> {
  const atts: ComposerAttachment[] = [];
  for (const att of saved) {
    const live = await liveAttachment(att, att.n);
    if (live) atts.push(live);
  }
  const draft = composerDrafts.get(channelId);
  // typing in this channel while the files loaded wins; the marker numbering
  // picks up above whatever came back
  if (!draft || draft.atts.length > 0) return;
  const counter = { image: 0, video: 0, file: 0, region: 0 };
  for (const att of atts) {
    counter[att.kind] = Math.max(counter[att.kind], att.n);
    for (const region of att.regions) {
      // a draft saved before regions were numbered: give it one now, in the
      // order it was drawn, rather than leaving a [region #undefined]
      if (typeof region.n !== "number") region.n = counter.region + 1;
      counter.region = Math.max(counter.region, region.n);
    }
  }
  composerDrafts.set(channelId, { ...draft, atts, counter });
  bumpDraft(channelId);
}

/** One stored attachment, fetched back into a live File the composer can
 *  hold — previews, region crops, and the send path all work off it. Null
 *  when its bytes are gone. */
async function liveAttachment(
  att: DraftAttachment | Attachment,
  n: number,
): Promise<ComposerAttachment | null> {
  if (!att.url) return null;
  try {
    const res = await fetch(`${HTTP_BASE}${att.url}`);
    if (!res.ok) return null;
    const file = new File([await res.blob()], att.name, { type: att.mediaType });
    storedAttachments.add(att.id);
    return {
      id: att.id,
      file,
      kind: att.kind,
      mediaType: att.mediaType,
      name: att.name,
      n,
      objectUrl: URL.createObjectURL(file),
      regions: "regions" in att ? (att.regions ?? []) : [],
    };
  } catch {
    return null;
  }
}

/** Tell a mounted composer its channel's draft changed underneath it. */
function bumpDraft(channelId: string): void {
  useRuri.setState((s) => ({
    draftBumps: { ...s.draftBumps, [channelId]: (s.draftBumps[channelId] ?? 0) + 1 },
  }));
}

/**
 * Put a prompt back in a channel's composer — a queued one pulled out of the
 * queue, or anything else the app hands back for editing.
 *
 * Its attachments come with it, renumbered onto whatever the composer is
 * already holding, and its [markers] are rewritten to match — so the text
 * still points at the right files instead of at numbers that mean something
 * else now.
 */
export function composeInto(channelId: string, text: string, attachments?: Attachment[]): void {
  if (!attachments || attachments.length === 0) {
    appendDraft(channelId, text);
    bumpDraft(channelId);
    return;
  }
  void (async () => {
    const before = composerDrafts.get(channelId);
    const counter = { ...(before?.counter ?? { image: 0, video: 0, file: 0, region: 0 }) };
    const live: ComposerAttachment[] = [];
    let renumbered = text;
    for (const att of attachments) {
      const fresh = await liveAttachment(att, counter[att.kind] + 1);
      if (!fresh) continue;
      counter[att.kind] += 1;
      for (const region of fresh.regions) counter.region = Math.max(counter.region, region.n);
      live.push(fresh);
      // a placeholder first: renumbering 1→2 while a 2 is still around
      // would otherwise renumber it twice
      renumbered = renumbered.replaceAll(`[${att.kind} #${att.n}]`, `\u0000${att.kind}:${fresh.n}\u0000`);
    }
    // eslint-disable-next-line no-control-regex -- NUL is the placeholder written just above, never typed
    renumbered = renumbered.replaceAll(/\u0000(image|video|file):(\d+)\u0000/g, "[$1 #$2]");
    const draft = composerDrafts.get(channelId);
    const body = draft?.text.trim() ? `${draft.text.replace(/\s+$/, "")}\n${renumbered}` : renumbered;
    setComposerDraft(channelId, {
      text: body,
      atts: [...(draft?.atts ?? []), ...live],
      counter,
    });
    bumpDraft(channelId);
  })();
}

/**
 * Put a file the app itself made into a channel's composer — a sketch, a
 * drawn-on picture — exactly as a dropped file would land: numbered, with
 * its marker at the end of the prompt, previewed in the strip.
 */
export function attachFile(channelId: string, file: File, kind: "image" | "video" | "file"): void {
  const prev = composerDrafts.get(channelId);
  const counter = { ...(prev?.counter ?? { image: 0, video: 0, file: 0, region: 0 }) };
  counter[kind] += 1;
  const att: ComposerAttachment = {
    id: crypto.randomUUID(),
    file,
    kind,
    mediaType: file.type || "application/octet-stream",
    name: file.name,
    n: counter[kind],
    objectUrl: URL.createObjectURL(file),
    regions: [],
  };
  const marker = `[${kind} #${att.n}]`;
  const text = prev?.text.trim() ? `${prev.text.replace(/\s+$/, "")} ${marker} ` : `${marker} `;
  setComposerDraft(channelId, { text, atts: [...(prev?.atts ?? []), att], counter });
  bumpDraft(channelId);
}

/** Swap an attachment's file for another under the same marker — the
 *  picture drawn on, put back where it was. A new id, so the server stores
 *  the new bytes; the regions go, since the picture they sat on has. */
export function replaceAttachmentFile(channelId: string, attId: string, file: File): void {
  const prev = composerDrafts.get(channelId);
  if (!prev) return;
  const atts = prev.atts.map((att) => {
    if (att.id !== attId) return att;
    URL.revokeObjectURL(att.objectUrl);
    storedAttachments.delete(att.id);
    return {
      ...att,
      id: crypto.randomUUID(),
      file,
      mediaType: file.type || att.mediaType,
      name: file.name,
      objectUrl: URL.createObjectURL(file),
      regions: [],
    };
  });
  setComposerDraft(channelId, { ...prev, atts });
  bumpDraft(channelId);
}

/** Append text to a channel's saved draft (async prompt arrivals). */
function appendDraft(channelId: string, text: string): void {
  const prev = composerDrafts.get(channelId);
  setComposerDraft(channelId, {
    text: prev?.text.trim() ? `${prev.text.replace(/\s+$/, "")}\n${text}` : text,
    atts: prev?.atts ?? [],
    counter: prev?.counter ?? { image: 0, video: 0, file: 0, region: 0 },
  });
}

interface RuriState {
  connected: boolean;
  projects: Project[];
  activeId: string | null;
  /** Every channel's events — whole for the chats marked in `loaded`, the
   *  last few for the rest (what the Home board's lines need). */
  transcripts: Record<string, TranscriptEvent[]>;
  /** The channels whose transcript is here in full. A chat opens by asking
   *  for its history (ensureTranscript) and lands here when it arrives; the
   *  least recently opened are let go of again, back to their tail. */
  loaded: Record<string, true>;
  /** A chat's history — every event before its newest compaction — once
   *  one of its earlier exchanges is opened in full. Only ever the open
   *  chat's. */
  history: Record<string, TranscriptEvent[]>;
  /** The outline of each loaded chat's history: the exchanges it shows
   *  folded above its newest compaction mark. Arrives with the transcript. */
  earlier: Record<string, EarlierItem[]>;
  drafts: Record<string, Draft | undefined>;
  statuses: Record<string, ProjectStatus>;
  permissions: PermissionRequest[];
  unread: Record<string, boolean>;
  models: ModelChoice[];
  /** Recall notes per project, keyed by the turn's user-event id. */
  summaries: Record<string, Record<string, TurnNote>>;
  /** Feature-tracker checklists per project. */
  tracker: Record<string, TrackerItem[]>;
  /** Ideas boards, keyed by PROJECT id (the tracker is keyed by session). */
  ideas: Record<string, Idea[]>;
  /** Component indexes, keyed by PROJECT id. */
  components: Record<string, NamedComponent[]>;
  /** How each project's repo sweep is getting on. `at` is when the line
   *  last changed — a finished sweep's last word is worth reading, and
   *  worth taking down again a little later. */
  sweeps: Record<string, { busy: boolean; note?: string; at: number }>;
  /** What the bridge is showing per channel: the page or app a session is
   *  driving, for the strip beside its composer. Absent = nothing open. */
  bridges: Record<string, BridgeState>;
  /** The vault's names — the values live on the server and stay there. */
  secrets: SecretMeta[];
  /** Skills as of the last scan: every global one, plus one project's own. */
  skills: SkillInfo[];
  /** Slash commands the composer's menu offers, and the project they were
   *  read for (a project's own skills and command files are in there). */
  commands: CommandInfo[];
  commandsFor: string | null;
  /** Which project the local half of `skills` belongs to. */
  skillsFor: string | null;
  /** A bmo command is running. */
  skillsBusy: boolean;
  /** What bmo said last. */
  skillsNote: string | null;
  /** The skill whose SKILL.md is open, and its markdown. */
  skillBody: { name: string; body: string } | null;
  closeSkillBody(): void;
  /** App-side prompt queue per channel — held until the running turn ends. */
  queued: Record<string, QueuedPrompt[]>;
  /** Channels whose queue is standing by after a stopped turn: nothing goes
   *  out until the next prompt pulls it along, or it is sent on by hand. */
  queueHeld: Record<string, boolean>;
  /** Limit windows per provider id (percent used) for the usage gauges. */
  usage: Record<string, UsageLimits>;
  /** Context-window occupancy per channel. */
  contexts: Record<string, ContextUsage>;
  /** How the running turn is getting on, per channel — what the working
   *  line counts. Only channels with a turn in flight are in here. */
  turns: Record<string, TurnProgress>;
  /** What each project has spent, keyed by PROJECT id (Home under "home"). */
  stats: Record<string, ProjectStats>;
  /** Sessions on disk from outside ruri, per PROJECT id, once asked for. */
  recent: Record<string, RecentSession[]>;
  /** Each project's catch-up brief: being rebuilt, when the repo was last
   *  read for it, and the last word said about it. */
  catchups: Record<string, { busy: boolean; built?: number; note?: string; at: number }>;
  /** Shell tab ids per channel, in the order the tab row shows them. */
  terminals: Record<string, string[]>;
  /** Rapid-fire mode: the main pane cycles through sessions awaiting a prompt. */
  rapid: boolean;
  /** The projects page, off the sidebar, is showing instead of a chat. */
  projectsOpen: boolean;
  /** Settings has the whole pane when it's open — it outgrew a dialog. */
  settingsOpen: boolean;
  /** What the agents are costing this machine — only while the statistics
   *  page is up to ask for it (server/resources.ts). */
  resources: Resources | undefined;
  /** Bumped per channel when text lands in its draft from outside (a review
   *  prompt, a rewound prompt) — a mounted composer re-reads the draft map. */
  draftBumps: Record<string, number>;
  /** The workspace root the Home agent manages. */
  workspaceDir: string;
  /** Where the music player's playlists live. */
  musicDir: string;
  /** Bumped when the music dir changes, so the player rescans. */
  musicEpoch: number;
  /** The Home agent's model/permission settings. */
  home: HomeSettings;
  /** Starred model ids — the composer picker shows only these. */
  starredModels: string[];
  smallModel: string;
  /** What an unset model means: the crowned default, else the built-in. */
  defaultModel: string;
  /** The local account name shown on the sidebar's account bar. */
  user: string;
  /** Whether the host can show a native folder picker (Electron shell). */
  canPickFolder: boolean;
  canPermissions: boolean;
  /** The macOS grants as last read (Settings asks), or null before that. */
  grants: { items: PermissionState[]; rows: TccRow[] } | null;
  /** Latest native-picker result, tagged with what the pick was for. */
  picked: { path: string; target: PickTarget } | null;
  lastError: string | null;
  /** Subagent logs — everything an agent did — for the agents whose cards
   *  have been opened (keyed by agentLogKey), kept current while here. */
  agentLogs: Record<string, TranscriptEvent[]>;
  /** The agents page: the chat it belongs to and the agents opened on it,
   *  the one showing last (an agent's own agents open on top of it). No
   *  keys = the list of every agent in the chat. */
  agentPanel: { projectId: string; keys: string[] } | null;
  /** The agents the user started from each chat's agents page (its crew),
   *  keyed by chat. */
  crew: Record<string, SubagentState[]>;
  /** Picking a session by hand also leaves rapid fire — the line is only
   *  ever showing you one, and this is you choosing another. */
  setActive(id: string | null): void;
  setRapid(on: boolean): void;
  setProjectsOpen(on: boolean): void;
  setSettingsOpen(on: boolean): void;
  clearPicked(): void;
  dismissError(): void;
}

export const useRuri = create<RuriState>((set) => ({
  connected: false,
  projects: [],
  activeId: HOME_ID,
  transcripts: {},
  loaded: {},
  history: {},
  earlier: {},
  drafts: {},
  statuses: {},
  permissions: [],
  agentLogs: {},
  agentPanel: null,
  crew: {},
  unread: {},
  models: [],
  summaries: {},
  tracker: {},
  ideas: {},
  components: {},
  sweeps: {},
  bridges: {},
  secrets: [],
  skills: [],
  commands: [],
  commandsFor: null,
  skillsFor: null,
  skillsBusy: false,
  skillsNote: null,
  skillBody: null,
  queued: {},
  queueHeld: {},
  terminals: {},
  usage: {},
  contexts: {},
  turns: {},
  stats: {},
  recent: {},
  catchups: {},
  rapid: false,
  projectsOpen: false,
  settingsOpen: false,
  resources: undefined,
  draftBumps: {},
  workspaceDir: "",
  musicDir: "",
  musicEpoch: 0,
  home: {},
  starredModels: [],
  smallModel: "",
  defaultModel: DEFAULT_MODEL,
  user: "",
  canPickFolder: false,
  canPermissions: false,
  grants: null,
  picked: null,
  lastError: null,
  setActive: (id) =>
    set((s) => {
      // Home is ephemeral: crossing its boundary (either direction) asks the
      // server to wipe it — ignored server-side while a turn is running.
      if ((s.activeId === HOME_ID) !== (id === HOME_ID)) send({ type: "reset_home" });
      return {
        activeId: id,
        // the earlier view belongs to the chat it was opened in
        history: {},
        rapid: false,
        projectsOpen: false,
        settingsOpen: false,
        unread: id ? { ...s.unread, [id]: false } : s.unread,
      };
    }),
  setRapid: (on) => set({ rapid: on, projectsOpen: false }),
  setProjectsOpen: (on) => set({ projectsOpen: on, rapid: false, settingsOpen: false }),
  closeSkillBody: () => set({ skillBody: null }),
  setSettingsOpen: (on) => set({ settingsOpen: on, projectsOpen: false }),
  clearPicked: () => set({ picked: null }),
  dismissError: () => set({ lastError: null }),
}));

// Vite dev server (:5173) talks to the standalone server on RURI_PORT (7777
// unless set — vite.config.ts passes it through); when the UI is served by
// the ruri server itself (desktop app / production), the WebSocket lives on
// the same origin.
const DEV_PORT: string = (import.meta.env["RURI_PORT"] as string | undefined) || "7777";
const WS_URL = import.meta.env.DEV ? `ws://${location.hostname}:${DEV_PORT}` : `ws://${location.host}`;

/** Base for the server's HTTP endpoints (music etc.) — empty when same-origin. */
export const HTTP_BASE = import.meta.env.DEV ? `http://${location.hostname}:${DEV_PORT}` : "";
let ws: WebSocket | null = null;

/**
 * The server's token (server/server.ts): without it the socket is refused.
 * The desktop app puts it on the window's URL; the vite dev page has no
 * such URL and asks vite for it instead (vite.config.ts reads the file the
 * server wrote). Kept once found — the URL does not change under the page.
 */
let token: string | null = new URLSearchParams(location.search).get("token");

async function resolveToken(): Promise<string> {
  if (token) return token;
  const res = await fetch("/__token");
  if (!res.ok) throw new Error(`no server token yet (${res.status})`);
  token = (await res.text()).trim();
  return token;
}

/* ── terminal traffic ─────────────────────────────────────────────── */

/**
 * Shell bytes bypass the store: they arrive keystroke by keystroke and belong
 * to one panel, so they go straight to whoever has it open instead of
 * re-rendering the app for every character.
 */
export type TerminalMessage =
  { kind: "data"; data: string; replay?: boolean } | { kind: "exit"; note: string };

const terminalListeners = new Map<string, Set<(message: TerminalMessage) => void>>();

/** Listen to one tab's shell. Tab ids are unique across every channel, so
 *  this is the whole routing table. */
export function onTerminal(termId: string, listener: (message: TerminalMessage) => void): () => void {
  const listeners = terminalListeners.get(termId) ?? new Set();
  listeners.add(listener);
  terminalListeners.set(termId, listeners);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) terminalListeners.delete(termId);
  };
}

function emitTerminal(termId: string, message: TerminalMessage): void {
  for (const listener of terminalListeners.get(termId) ?? []) listener(message);
}

/** Say something to the server, if it is listening — and whether it went.
 *  A dropped message is simply gone; the few that cannot afford that (a
 *  draft's attachment bytes) look at the answer and try again. */
export function send(message: ClientMessage): boolean {
  if (ws?.readyState !== WebSocket.OPEN) {
    // fixture mode has no server: it keeps what would have gone out, for
    // the scripts that drive it to read back
    (window as unknown as { __ruriSent?: ClientMessage[] }).__ruriSent?.push(message);
    return false;
  }
  ws.send(JSON.stringify(message));
  return true;
}

/** How many chats the window keeps whole at once. Opening a fifth lets the
 *  least recently opened go back to its tail; opening it again asks. */
const KEEP_LOADED = 4;
/** Loaded chats, least recently opened first. */
const opened: string[] = [];
/** Asked for and not yet arrived — so a re-render does not ask twice. */
const requested = new Set<string>();

/**
 * Ask for a chat's whole history, unless it is here or on its way. The
 * snapshot only carries the last few events of each (TRANSCRIPT_TAIL);
 * this is what fills a chat in when it opens.
 */
export function ensureTranscript(channelId: string): void {
  const state = useRuri.getState();
  if (state.loaded[channelId] || requested.has(channelId)) return;
  // the chat goes on screen first, so nothing it does between the history
  // leaving the server and the view arriving there falls in the gap
  if (viewQueued) sendView();
  if (send({ type: "transcript_get", projectId: channelId })) requested.add(channelId);
}

/* ── what this window has on screen ──────────────────────────────── */

/**
 * The chats on screen, and whether Home's projects page is — told to the
 * server whenever that changes (the `view` message). Only these get their
 * conversation as it happens; every other chat's work waits on the server
 * until the chat is opened, and arrives then, whole. The server also keeps
 * an open chat's agent process warm between turns, and closes the rest the
 * moment their work is done. Counted, because a hand-off (rapid fire, a
 * remount) briefly has the old pane and the new one both mounted.
 */
const onScreen = new Map<string, number>();
let boardsUp = 0;
/** Windows with the statistics page up, which is what runs the meters. */
let metersUp = 0;
/** The last view the server was told, so a re-render says nothing twice. */
let lastView = "";
let viewQueued = false;

function sendView(): void {
  viewQueued = false;
  const message: ClientMessage = {
    type: "view",
    channels: [...onScreen.keys()],
    // always live: a window that cannot be seen still keeps its state
    // current (lib/awake.ts freezes only what moves)
    live: true,
    ...(boardsUp > 0 ? { board: true } : {}),
    ...(metersUp > 0 ? { meters: true } : {}),
  };
  const json = JSON.stringify(message);
  if (json !== lastView && send(message)) lastView = json;
}

/** Say it once, after whatever else this moment changes: a switch from one
 *  chat to another is one message, not an "off" and then an "on". */
function syncView(): void {
  if (viewQueued) return;
  viewQueued = true;
  queueMicrotask(() => {
    if (viewQueued) sendView();
  });
}

/** Put a chat on screen; the function returned takes it off again. */
export function watchChannel(channelId: string): () => void {
  const count = onScreen.get(channelId) ?? 0;
  onScreen.set(channelId, count + 1);
  syncView();
  const panel = useRuri.getState().agentPanel;
  const key = count === 0 && panel?.projectId === channelId ? panel.keys.at(-1) : undefined;
  // an agent's log left open here heard nothing while the chat was away —
  // asked for again once the view has gone out ahead of it
  if (key) queueMicrotask(() => requestAgentLog(channelId, key));
  return () => {
    const left = (onScreen.get(channelId) ?? 1) - 1;
    if (left > 0) onScreen.set(channelId, left);
    else onScreen.delete(channelId);
    syncView();
  };
}

/** Home's projects page is up; the function returned says it went. */
export function watchBoard(): () => void {
  boardsUp += 1;
  syncView();
  return () => {
    boardsUp -= 1;
    syncView();
  };
}

/**
 * Ask the server to read what the agents are costing this machine.
 *
 * It samples only while somebody is asking — the statistics page being up
 * is the whole reason a `ps` runs (server/resources.ts) — so this is held
 * for exactly as long as the page is, and the last reading is dropped when
 * it goes, rather than left to go stale on the page behind it.
 */
export function watchMeters(): () => void {
  metersUp += 1;
  syncView();
  return () => {
    metersUp -= 1;
    if (metersUp === 0) useRuri.setState({ resources: undefined });
    syncView();
  };
}

/** Every message applies as it arrives, asleep or awake: only what moves
 *  is frozen while nobody can see the window (lib/awake.ts). */
function receive(msg: ServerMessage): void {
  apply(msg);
}

/** Histories asked for and not yet arrived. */
const historyAsked = new Set<string>();

/** Ask for a chat's history — every event before its newest compaction —
 *  unless it is already on its way. */
export function requestHistory(channelId: string): void {
  if (historyAsked.has(channelId)) return;
  if (send({ type: "history_get", projectId: channelId })) historyAsked.add(channelId);
}

/** A subagent log's key in `agentLogs`: its chat, and its card's key. */
export function agentLogKey(projectId: string, key: string): string {
  return `${projectId}\u0000${key}`;
}

/** How many agents' logs the window keeps at once. Opening another lets the
 *  least recently opened go — it is on disk, a click away. */
const KEEP_AGENT_LOGS = 6;
/** How much of one agent's log the window keeps — the newest, as Home's
 *  transcript is kept (HOME_TRANSCRIPT_MAX); the rest is on disk. */
const AGENT_LOG_MAX = 400;
/** Logs asked for, least recently opened first. */
const agentLogOrder: string[] = [];

/** Ask for an agent's log. It is held (empty) while it is on its way, so
 *  what the agent does meanwhile lands in it too. */
function requestAgentLog(projectId: string, key: string): void {
  const id = agentLogKey(projectId, key);
  const at = agentLogOrder.indexOf(id);
  if (at !== -1) agentLogOrder.splice(at, 1);
  agentLogOrder.push(id);
  const logs = { ...useRuri.getState().agentLogs };
  while (agentLogOrder.length > KEEP_AGENT_LOGS) delete logs[agentLogOrder.shift()!];
  logs[id] ??= [];
  useRuri.setState({ agentLogs: logs });
  send({ type: "agent_log", projectId, key });
}

/**
 * Open an agent on the agents page: as its only agent, or — `stack`, from
 * the page itself — on top of the one showing (an agent's own agent, or
 * one picked from the list). No key opens the list of every agent.
 */
export function openAgent(projectId: string, key?: string, stack = false): void {
  const panel = useRuri.getState().agentPanel;
  const keys = !key
    ? []
    : stack && panel?.projectId === projectId
      ? [...panel.keys.filter((k) => k !== key), key]
      : [key];
  useRuri.setState({ agentPanel: { projectId, keys } });
  if (key) requestAgentLog(projectId, key);
}

/** Step back out of the agent on top — to the one under it, or the list. */
export function backAgent(): void {
  const panel = useRuri.getState().agentPanel;
  if (panel) useRuri.setState({ agentPanel: { ...panel, keys: panel.keys.slice(0, -1) } });
}

export function closeAgent(): void {
  if (useRuri.getState().agentPanel) useRuri.setState({ agentPanel: null });
}

/** Move one of the user's own agents' cards along here, ahead of the
 *  server's word on it, so the page answers the press at once. */
function crewCard(projectId: string, key: string, change: (agent: SubagentState) => SubagentState): void {
  useRuri.setState((s) => ({
    crew: { ...s.crew, [projectId]: (s.crew[projectId] ?? []).map((a) => (a.key === key ? change(a) : a)) },
  }));
}

/**
 * Start an agent of the user's own in a chat — `text` its brief, on
 * `model` (the chat's when unset) — and open its page. It works in the
 * chat's project by itself; its card and its log arrive as it goes.
 */
export function startAgent(projectId: string, text: string, model?: string): void {
  const key = `crew-${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  if (!send({ type: "agent_start", projectId, key, text, ...(model ? { model } : {}) })) return;
  const agent: SubagentState = {
    key,
    description: briefLine(text),
    prompt: text,
    status: "running",
    mine: true,
    startedAt: Date.now(),
    ...(model ? { model } : {}),
  };
  useRuri.setState((s) => ({ crew: { ...s.crew, [projectId]: [...(s.crew[projectId] ?? []), agent] } }));
  openAgent(projectId, key);
}

/** Tell one of the user's own agents something more, once it is done. */
export function sendAgent(projectId: string, key: string, text: string): void {
  if (!send({ type: "agent_send", projectId, key, text })) return;
  crewCard(projectId, key, (agent) => {
    const next: SubagentState = { ...agent, status: "running", startedAt: Date.now() };
    delete next.endedAt;
    delete next.result;
    delete next.activity;
    return next;
  });
}

/** Stop one of the user's own agents where it is. */
export function stopAgent(projectId: string, key: string): void {
  send({ type: "agent_stop", projectId, key });
}

/** Put a line in the chat's error bar — for what went wrong on this side,
 *  a send that found no socket most of all. */
export function showError(message: string): void {
  useRuri.setState({ lastError: message });
}

export function connect(): void {
  // Dev-only fixture mode (?fixture): canned data instead of a live server,
  // so the UI can be screenshotted deterministically without spending tokens.
  if (new URLSearchParams(location.search).has("fixture")) {
    void import("./fixture").then((m) => m.installFixture());
    return;
  }
  const retry = () => {
    useRuri.setState({ connected: false });
    setTimeout(connect, 1500);
  };
  resolveToken().then(
    (t) => {
      ws = new WebSocket(`${WS_URL}/?token=${encodeURIComponent(t)}`);
      ws.onopen = () => {
        useRuri.setState({ connected: true });
        flushUnsavedDrafts();
        // a new connection knows nothing of what is on screen
        lastView = "";
        sendView();
      };
      ws.onmessage = (raw) => receive(JSON.parse(raw.data as string) as ServerMessage);
      ws.onclose = retry;
      ws.onerror = () => ws?.close();
    },
    // no token means no server yet (dev: the file appears when it starts)
    retry,
  );
}

function apply(msg: ServerMessage): void {
  const { setState } = useRuri;
  switch (msg.type) {
    case "snapshot": {
      // The machine's copy of the window's preferences, ahead of everything
      // else in here: the theme is on screen already and may be the wrong one.
      hydratePrefs(msg.prefs);
      // Unsent prompts come back where they were left. A channel already
      // being typed in wins over the stored copy — the server's is at most
      // a debounce behind, and what's on screen is the truth.
      const restored = Object.entries(msg.composerDrafts).filter(
        ([channelId]) => !hasDraft(composerDrafts.get(channelId)),
      );
      for (const [channelId, draft] of restored) {
        composerDrafts.set(channelId, {
          text: draft.text,
          atts: [],
          counter: { image: 0, video: 0, file: 0, region: 0 },
        });
        draftedChannels.add(channelId);
        // the files follow: each one is fetched back into a live File and
        // lands in the strip when it arrives
        if (draft.attachments?.length) void restoreAttachments(channelId, draft.attachments);
      }
      // the snapshot carries tails: every chat is unloaded again, and the
      // one on screen asks for itself (ChatPane)
      requested.clear();
      historyAsked.clear();
      opened.length = 0;
      setState((s) => ({
        projects: msg.projects,
        transcripts: msg.transcripts,
        loaded: {},
        history: {},
        earlier: {},
        statuses: msg.statuses,
        permissions: msg.permissions,
        models: msg.models,
        summaries: msg.summaries,
        tracker: msg.tracker,
        ideas: msg.ideas,
        components: msg.components,
        secrets: msg.secrets,
        queued: msg.queued,
        queueHeld: Object.fromEntries(msg.queuesHeld.map((id) => [id, true])),
        usage: msg.usage,
        contexts: msg.contexts,
        turns: msg.turns,
        stats: msg.stats,
        catchups: Object.fromEntries(
          Object.entries(msg.catchups).map(([id, c]) => [
            id,
            { busy: false, at: 0, ...(c.built ? { built: c.built } : {}) },
          ]),
        ),
        canPickFolder: msg.canPickFolder,
        canPermissions: msg.canPermissions,
        bridges: msg.bridges,
        workspaceDir: msg.workspaceDir,
        musicDir: msg.musicDir,
        home: msg.home,
        starredModels: msg.starredModels,
        smallModel: msg.smallModel,
        defaultModel: msg.defaultModel,
        user: msg.user,
        // a mounted composer re-reads its channel's draft on the bump
        draftBumps: restored.reduce<Record<string, number>>(
          (bumps, [channelId]) => ({
            ...bumps,
            [channelId]: (s.draftBumps[channelId] ?? 0) + 1,
          }),
          { ...s.draftBumps },
        ),
        drafts: {},
        // what the agents did while the window was away is on the server:
        // every log goes, and the one on screen asks again below
        agentLogs: {},
        crew: msg.crew,
        activeId:
          s.activeId &&
          (s.activeId === HOME_ID || msg.projects.some((p) => p.sessions.some((x) => x.id === s.activeId)))
            ? s.activeId
            : HOME_ID,
      }));
      agentLogOrder.length = 0;
      const panel = useRuri.getState().agentPanel;
      const showing = panel?.keys.at(-1);
      if (panel && showing) requestAgentLog(panel.projectId, showing);
      break;
    }
    case "agent_log": {
      const id = agentLogKey(msg.projectId, msg.key);
      setState((s) => {
        // anything that came live while this was on its way stays in it
        const live = s.agentLogs[id] ?? [];
        const ids = new Set(msg.events.map((event) => event.id));
        const log = keepRecent([...msg.events, ...live.filter((event) => !ids.has(event.id))], AGENT_LOG_MAX);
        return { agentLogs: { ...s.agentLogs, [id]: log } };
      });
      break;
    }
    case "agent_event": {
      const id = agentLogKey(msg.projectId, msg.key);
      // only the logs someone has opened are kept here; the rest wait on disk
      const log = useRuri.getState().agentLogs[id];
      if (!log) break;
      const at = log.findIndex((event) => event.id === msg.event.id);
      const next = at === -1 ? [...log, msg.event] : log.map((event, i) => (i === at ? msg.event : event));
      setState((s) => ({ agentLogs: { ...s.agentLogs, [id]: keepRecent(next, AGENT_LOG_MAX) } }));
      break;
    }
    case "crew": {
      // a chat coming back on screen is sent its crew whether it moved or not
      const known = useRuri.getState().crew[msg.projectId];
      if (known && JSON.stringify(known) === JSON.stringify(msg.agents)) break;
      setState((s) => ({ crew: { ...s.crew, [msg.projectId]: msg.agents } }));
      break;
    }
    case "projects": {
      setState((s) => ({
        projects: msg.projects,
        activeId:
          s.activeId &&
          (s.activeId === HOME_ID || msg.projects.some((p) => p.sessions.some((x) => x.id === s.activeId)))
            ? s.activeId
            : HOME_ID,
      }));
      break;
    }
    case "queued": {
      setState((s) => ({
        queued: { ...s.queued, [msg.projectId]: msg.items },
        queueHeld: { ...s.queueHeld, [msg.projectId]: msg.held === true },
      }));
      break;
    }
    case "history": {
      historyAsked.delete(msg.projectId);
      setState((s) => ({ history: { ...s.history, [msg.projectId]: msg.events } }));
      break;
    }
    case "transcript": {
      requested.delete(msg.projectId);
      setState((s) => {
        const transcripts = {
          ...s.transcripts,
          [msg.projectId]: reuse(s.transcripts[msg.projectId], msg.events),
        };
        const loaded: Record<string, true> = { ...s.loaded, [msg.projectId]: true };
        const earlier = { ...s.earlier, [msg.projectId]: msg.earlier ?? [] };
        // most recently opened last; the ones past the budget go back to
        // their tail — never the one on screen
        const at = opened.indexOf(msg.projectId);
        if (at !== -1) opened.splice(at, 1);
        opened.push(msg.projectId);
        while (opened.length > KEEP_LOADED) {
          const oldest = opened.findIndex((id) => id !== s.activeId);
          if (oldest === -1) break;
          const [gone] = opened.splice(oldest, 1);
          if (!gone) break;
          delete loaded[gone];
          delete earlier[gone];
          const events = transcripts[gone];
          if (events && events.length > TRANSCRIPT_TAIL) transcripts[gone] = events.slice(-TRANSCRIPT_TAIL);
        }
        return {
          transcripts,
          loaded,
          earlier,
          summaries: { ...s.summaries, [msg.projectId]: msg.summaries },
          // the transcript was rewritten (a compaction, a rewind): whatever
          // history was showing is out of date
          history: Object.fromEntries(Object.entries(s.history).filter(([id]) => id !== msg.projectId)),
        };
      });
      break;
    }
    case "open_session": {
      useRuri.getState().setActive(msg.projectId);
      break;
    }
    case "recent": {
      setState((s) => ({ recent: { ...s.recent, [msg.projectId]: msg.items } }));
      break;
    }
    case "catchup": {
      setState((s) => ({
        catchups: {
          ...s.catchups,
          [msg.projectId]: {
            busy: msg.busy,
            at: Date.now(),
            ...(msg.built ? { built: msg.built } : {}),
            ...(msg.note ? { note: msg.note } : {}),
          },
        },
      }));
      break;
    }
    case "events_removed": {
      const gone = new Set(msg.eventIds);
      setState((s) => ({
        transcripts: {
          ...s.transcripts,
          [msg.projectId]: (s.transcripts[msg.projectId] ?? []).filter((e) => !gone.has(e.id)),
        },
      }));
      break;
    }
    case "terminal_data": {
      emitTerminal(msg.termId, {
        kind: "data",
        data: msg.data,
        ...(msg.replay ? { replay: true } : {}),
      });
      break;
    }
    case "terminal_exit": {
      emitTerminal(msg.termId, { kind: "exit", note: msg.note });
      break;
    }
    case "terminal_tabs": {
      setState((s) => ({ terminals: { ...s.terminals, [msg.projectId]: msg.tabs } }));
      break;
    }
    case "usage": {
      setState({ usage: msg.limits });
      break;
    }
    case "context": {
      setState((s) => ({ contexts: { ...s.contexts, [msg.projectId]: msg.context } }));
      break;
    }
    case "turn": {
      setState((s) => {
        if (msg.turn === null) {
          if (!(msg.projectId in s.turns)) return {};
          const turns = { ...s.turns };
          delete turns[msg.projectId];
          return { turns };
        }
        return { turns: { ...s.turns, [msg.projectId]: msg.turn } };
      });
      break;
    }
    case "stats": {
      setState((s) => ({ stats: { ...s.stats, [msg.projectId]: msg.stats } }));
      break;
    }
    case "resources": {
      setState({ resources: msg.resources });
      break;
    }
    case "review_prompt":
    case "compose": {
      // Text bound for a channel's composer (a review's fix-it prompt, a
      // rewound prompt back for editing, a catch-up brief with its
      // screenshots) goes straight into the persistent draft map — never
      // through component state, so switching sessions can't lose it — and
      // the bump tells a mounted composer to re-read.
      const attachments = msg.type === "compose" ? msg.attachments : undefined;
      if (attachments?.length) composeInto(msg.projectId, msg.text, attachments);
      else {
        appendDraft(msg.projectId, msg.text);
        bumpDraft(msg.projectId);
      }
      break;
    }
    case "ideas": {
      setState((s) => ({ ideas: { ...s.ideas, [msg.projectId]: msg.items } }));
      break;
    }
    case "components": {
      setState((s) => ({ components: { ...s.components, [msg.projectId]: msg.items } }));
      break;
    }
    case "sweep": {
      setState((s) => ({
        sweeps: {
          ...s.sweeps,
          [msg.projectId]: {
            busy: msg.busy,
            at: Date.now(),
            ...(msg.note ? { note: msg.note } : {}),
          },
        },
      }));
      break;
    }
    case "bridge": {
      setState((s) => {
        const bridges = { ...s.bridges };
        if (msg.state) bridges[msg.projectId] = msg.state;
        else delete bridges[msg.projectId];
        return { bridges };
      });
      break;
    }
    case "secrets": {
      setState({ secrets: msg.items });
      break;
    }
    case "skill_body": {
      setState({ skillBody: { name: msg.name, body: msg.body } });
      break;
    }
    case "commands": {
      setState({ commands: msg.commands, commandsFor: msg.projectId ?? null });
      break;
    }
    case "skills": {
      setState({
        skills: msg.skills,
        skillsFor: msg.projectId ?? null,
        skillsBusy: msg.busy ?? false,
        skillsNote: msg.note ?? null,
      });
      break;
    }
    case "workspace": {
      setState({ workspaceDir: msg.path });
      break;
    }
    case "music_dir": {
      setState((s) => ({ musicDir: msg.path, musicEpoch: s.musicEpoch + 1 }));
      break;
    }
    case "home_settings": {
      setState({ home: msg.home });
      break;
    }
    case "prefs": {
      hydratePrefs(msg.prefs);
      break;
    }
    case "starred_models": {
      setState({ starredModels: msg.models });
      break;
    }
    case "small_model": {
      setState({ smallModel: msg.model });
      break;
    }
    case "default_model": {
      setState({ defaultModel: msg.model });
      break;
    }
    case "home_reset": {
      setState((s) => ({
        transcripts: { ...s.transcripts, [HOME_ID]: [] },
        // empty is the whole of it
        loaded: { ...s.loaded, [HOME_ID]: true },
        summaries: { ...s.summaries, [HOME_ID]: {} },
        drafts: { ...s.drafts, [HOME_ID]: undefined },
        statuses: { ...s.statuses, [HOME_ID]: "idle" },
        unread: { ...s.unread, [HOME_ID]: false },
        queued: { ...s.queued, [HOME_ID]: [] },
        queueHeld: { ...s.queueHeld, [HOME_ID]: false },
        contexts: Object.fromEntries(Object.entries(s.contexts).filter(([k]) => k !== HOME_ID)),
        turns: Object.fromEntries(Object.entries(s.turns).filter(([k]) => k !== HOME_ID)),
      }));
      break;
    }
    case "event": {
      setState((s) => {
        let transcript = [...(s.transcripts[msg.projectId] ?? [])];
        const existing = transcript.findIndex((event) => event.id === msg.event.id);
        if (existing === -1) transcript.push(msg.event);
        else transcript[existing] = msg.event;
        // a chat nobody is looking at keeps only its tail
        if (!s.loaded[msg.projectId] && transcript.length > TRANSCRIPT_TAIL) {
          transcript = transcript.slice(-TRANSCRIPT_TAIL);
        }
        // Home keeps its newest events, the same cut the server makes
        if (msg.projectId === HOME_ID) transcript = keepRecent(transcript, HOME_TRANSCRIPT_MAX);
        const drafts = { ...s.drafts };
        if (msg.event.kind === "assistant" && drafts[msg.projectId]?.messageId === msg.event.id) {
          drafts[msg.projectId] = undefined;
        }
        return {
          transcripts: { ...s.transcripts, [msg.projectId]: transcript },
          drafts,
          // The diamond pip marks a FINISHED turn elsewhere — not every
          // event that trickles in while a background session works.
          unread:
            msg.projectId === s.activeId || msg.event.kind !== "result"
              ? s.unread
              : { ...s.unread, [msg.projectId]: true },
        };
      });
      break;
    }
    case "delta": {
      setState((s) => {
        const prev = s.drafts[msg.projectId];
        const draft: Draft =
          prev && prev.messageId === msg.messageId
            ? { messageId: msg.messageId, text: prev.text + msg.delta }
            : { messageId: msg.messageId, text: msg.delta };
        return { drafts: { ...s.drafts, [msg.projectId]: draft } };
      });
      break;
    }
    case "reply": {
      setState((s) => ({ drafts: { ...s.drafts, [msg.projectId]: msg.draft ?? undefined } }));
      break;
    }
    case "tails": {
      setState((s) => {
        const transcripts = { ...s.transcripts };
        for (const [id, tail] of Object.entries(msg.transcripts)) {
          const held = transcripts[id];
          // a whole chat stays whole, its end brought up to date; a chat
          // held only as a tail simply takes the newer tail
          transcripts[id] = s.loaded[id] && held ? overlay(held, tail) : tail;
        }
        return { transcripts };
      });
      break;
    }
    case "status": {
      setState((s) => ({ statuses: { ...s.statuses, [msg.projectId]: msg.status } }));
      break;
    }
    case "permission_request": {
      // a request sent again is the same card with something changed on it
      // (a question gone late), not a second card
      setState((s) => ({
        permissions: s.permissions.some((p) => p.requestId === msg.request.requestId)
          ? s.permissions.map((p) => (p.requestId === msg.request.requestId ? msg.request : p))
          : [...s.permissions, msg.request],
      }));
      break;
    }
    case "permission_resolved": {
      setState((s) => ({
        permissions: s.permissions.filter((p) => p.requestId !== msg.requestId),
      }));
      break;
    }
    case "models": {
      setState({ models: msg.models });
      break;
    }
    case "permissions": {
      setState({ grants: { items: msg.items, rows: msg.rows } });
      break;
    }
    case "folder_picked": {
      if (msg.path) setState({ picked: { path: msg.path, target: msg.target ?? "workspace" } });
      break;
    }
    case "tracker": {
      setState((s) => ({ tracker: { ...s.tracker, [msg.projectId]: msg.items } }));
      break;
    }
    case "turn_summary": {
      setState((s) => ({
        summaries: {
          ...s.summaries,
          [msg.projectId]: { ...s.summaries[msg.projectId], [msg.turnId]: msg.note },
        },
      }));
      break;
    }
    case "error": {
      setState({ lastError: msg.message });
      break;
    }
  }
}
