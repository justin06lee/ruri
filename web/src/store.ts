import { create } from "zustand";
import {
  DEFAULT_MODEL,
  HOME_ID,
  HOME_TRANSCRIPT_MAX,
  keepRecent,
  leadOf,
  TRANSCRIPT_TAIL,
  briefLine,
  type BackgroundWork,
  type BridgeState,
  type HarnessInfo,
  type SharingInfo,
  type IntegrationHarness,
  type Integrations,
  type TalkLetter,
  type TalkPolicy,
  type TeamAction,
  type TeamBudget,
  type TeamLiaison,
  type TeamMember,
  type PluginRow,
  type ClientMessage,
  type Attachment,
  type AttachmentUpload,
  type CommandInfo,
  type ContextUsage,
  type DraftAttachment,
  type EarlierItem,
  type Idea,
  type NamedComponent,
  type ComponentFile,
  type ProjectSheet,
  type SheetGit,
  type SourceLabel,
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
  type PermissionMode,
  type SessionInfo,
  type QueueHold,
  type RecentSession,
  type ServerMessage,
  type TrackerItem,
  type TranscriptEvent,
  type TurnNote,
  type TurnProgress,
  type UsageLimits,
} from "../../shared/protocol";
import type { ComposerAttachment } from "./components/Attachments";
import {
  insertAt,
  predict,
  statusWithOutgoing,
  withOutgoing,
  withOutgoingItems,
  type Outgoing,
  type PromptMessage,
} from "./lib/outgoing";
import { overlay, reuse } from "./lib/transcript";
import { pictureStored } from "./pictures";
import { hydratePrefs } from "./prefs";
import { isAwake, subscribeAwake } from "./lib/awake";
import { Held } from "./lib/held";
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
  /** Each chat's agents and scripts still running with no turn needed —
   *  a chat is busy while it has any (see `busy`). Absent = none. */
  work: Record<string, BackgroundWork>;
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
  /** The folder each project's `ruri add` installs into, when set. */
  componentDirs: Record<string, string>;
  /** Components' code as the library page last read it, by component id. */
  componentCode: Record<string, ComponentFile[]>;
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
  /** Channels whose queue is standing by, and why (a stop, a dropped
   *  connection, a usage limit): nothing goes out until the next prompt
   *  pulls it along, or it is sent on by hand. */
  queueHeld: Record<string, QueueHold | undefined>;
  /** Limit windows per provider id (percent used) for the usage gauges. */
  usage: Record<string, UsageLimits>;
  /** Context-window occupancy per channel. */
  contexts: Record<string, ContextUsage>;
  /** Prompts on screen that have not left this window yet — no socket to
   *  send them down — by their id, each to its chat. They go the moment
   *  there is one (the outbox). */
  unsent: Record<string, string>;
  /** Chats whose turn the user has stopped and that have not stopped yet:
   *  the stop is answered at once, the harness winds down after. */
  stopping: Record<string, true>;
  /** How the running turn is getting on, per channel — what the working
   *  line counts. Only channels with a turn in flight are in here. */
  turns: Record<string, TurnProgress>;
  /** What each project has spent, keyed by PROJECT id (Home under "home"). */
  stats: Record<string, ProjectStats>;
  /** Sessions on disk from outside ruri, per PROJECT id, once asked for. */
  recent: Record<string, RecentSession[]>;
  /** Each project's shape: being rebuilt from the repo, when the repo was
   *  last read for it, and the last word said about it. */
  catchups: Record<string, { busy: boolean; built?: number; note?: string; at: number }>;
  /** Each project's memory being rebuilt from its chats, and the last word. */
  recalls: Record<string, { busy: boolean; note?: string; at: number }>;
  /** Each project's sheet (its architecture and its memory), once the
   *  architecture page has asked for it — and every change after. */
  sheets: Record<string, ProjectSheet>;
  /** Beside each sheet: where each memory line came from, and the repo as
   *  git had it when the sheet was sent. */
  sheetFacts: Record<string, { sources: Record<string, SourceLabel>; git?: SheetGit }>;
  /** Shell tab ids per channel, in the order the tab row shows them. */
  terminals: Record<string, string[]>;
  /** Rapid-fire mode: the main pane cycles through projects whose lead awaits a prompt. */
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
  /** The model that writes and checks the projects' memory. */
  memoryModel: string;
  /** What an unset model means: the crowned default, else the built-in. */
  defaultModel: string;
  /** The local account name shown on the sidebar's account bar. */
  user: string;
  /** Every coding CLI on this machine, as the updater last saw it. */
  harnesses: HarnessInfo[];
  /** The updater is looking right now. */
  harnessesChecking: boolean;
  /** Settings → Integrations, as last read — and for which project. */
  integrations: { projectId?: string; data: Integrations } | null;
  /** Who may message whom, and the latest messages between agents (the
   *  talk page, server/talk.ts) — asked for on every connect. */
  talk: { policy: TalkPolicy; letters: TalkLetter[] } | null;
  /** Each project's team, as the team page last heard it — asked for when
   *  the page opens, and kept up to date while it is (server/team.ts). */
  team: Record<
    string,
    {
      members: TeamMember[];
      liaison?: TeamLiaison;
      freeLayers: Array<{ slug: string; name: string }>;
      budget: TeamBudget;
    }
  >;
  /** The plugin browser's last answer. */
  pluginsFound: { harness: IntegrationHarness; query: string; plugins: PluginRow[]; total: number } | null;
  /** How the last change to the integrations went. */
  integrationNote: { ok: boolean; message: string; at: number } | null;
  /** Whether the host can show a native folder picker (Electron shell). */
  canPickFolder: boolean;
  canPermissions: boolean;
  /** The server's OS (process.platform), "" before the first hello. */
  platform: string;
  /** Whether other devices may use the computer this window is onto, and
   *  who they are (server/sharing.ts). */
  sharing: SharingInfo | null;
  /** Set when this window is on another device than the server: which
   *  device the server knows it as. */
  remoteDevice: { id: string; name: string } | null;
  /** The invite this window last asked for — its six words — until it
   *  runs out. */
  invite: { words: string[]; expires: number } | null;
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

/**
 * Whether a chat is doing anything at all: a turn running (or waiting on
 * the user inside one), or agents and scripts of its own still at work
 * after its turn has ended. What the sidebar's dragons and the projects
 * page go by. Reads two maps and answers a boolean, so a selector made of
 * it re-renders only when the answer changes.
 */
/**
 * The chat the window shows for `id`: Home, or any session of an open
 * project — its lead, which the user mostly talks to, or a teammate or the
 * liaison, opened from the team page. Undefined when no open project has it.
 */
export function shownChat(projects: Project[], id: string): string | undefined {
  if (id === HOME_ID) return id;
  return projects.some((p) => p.sessions.some((x) => x.id === id)) ? id : undefined;
}

/** The lead of the project a chat belongs to. */
export function leadFor(projects: Project[], id: string): string | undefined {
  const project = projects.find((p) => p.sessions.some((x) => x.id === id));
  return project ? leadOf(project)?.id : undefined;
}

/** What the window shows once the projects change: the chat it was on, or
 *  — a teammate retired or refreshed under it — that project's lead, or
 *  Home when the project itself is gone. */
function stillShown(before: Project[], after: Project[], id: string | null): string {
  if (!id) return HOME_ID;
  const lead = leadFor(before, id);
  return shownChat(after, id) ?? (lead ? shownChat(after, lead) : undefined) ?? HOME_ID;
}

/** The team page opening on a project: its team, and news of it while open. */
export function askTeam(projectId: string): void {
  send({ type: "team_get", projectId });
}

/** The user doing to a member what its lead can. */
export function teamAction(memberId: string, action: TeamAction): void {
  send({ type: "team_member", memberId, action });
}

export function isBusy(s: Pick<RuriState, "statuses" | "work">, channelId: string): boolean {
  const status = s.statuses[channelId];
  return status === "working" || status === "permission" || channelId in s.work;
}

/** The unread map with one chat's diamond taken off — the same map when it
 *  had none, so nothing re-renders for it. */
function seen(unread: Record<string, boolean>, id: string | null): Record<string, boolean> {
  return id && unread[id] ? { ...unread, [id]: false } : unread;
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
  work: {},
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
  componentDirs: {},
  componentCode: {},
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
  unsent: {},
  stopping: {},
  turns: {},
  stats: {},
  recent: {},
  catchups: {},
  recalls: {},
  sheets: {},
  sheetFacts: {},
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
  memoryModel: "",
  defaultModel: DEFAULT_MODEL,
  user: "",
  harnesses: [],
  harnessesChecking: false,
  integrations: null,
  talk: null,
  team: {},
  pluginsFound: null,
  integrationNote: null,
  canPickFolder: false,
  canPermissions: false,
  platform: "",
  sharing: null,
  remoteDevice: null,
  invite: null,
  grants: null,
  picked: null,
  lastError: null,
  setActive: (asked) =>
    set((s) => {
      const id = asked;
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
  // closing either page puts the open chat back in front of you, and with
  // it whatever finished there while the page stood over it (see "event")
  setProjectsOpen: (on) =>
    set((s) => ({
      projectsOpen: on,
      rapid: false,
      settingsOpen: false,
      unread: on ? s.unread : seen(s.unread, s.activeId),
    })),
  closeSkillBody: () => set({ skillBody: null }),
  setSettingsOpen: (on) =>
    set((s) => ({
      settingsOpen: on,
      projectsOpen: false,
      unread: on ? s.unread : seen(s.unread, s.activeId),
    })),
  clearPicked: () => set({ picked: null }),
  dismissError: () => set({ lastError: null }),
}));

// Vite dev server (:5173) talks to the standalone server on RURI_PORT (7777
// unless set — vite.config.ts passes it through); when the UI is served by
// the ruri server itself (desktop app / production), the WebSocket lives on
// the same origin.
const DEV_PORT: string = (import.meta.env["RURI_PORT"] as string | undefined) || "7777";
// over TLS when the page came that way: a window onto another computer
// (server/sharing.ts)
const WS_URL = import.meta.env.DEV
  ? `ws://${location.hostname}:${DEV_PORT}`
  : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

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

/* ── prompts on their way (lib/outgoing.ts) ──────────────────────── */

/** The prompts this window has put on screen and the server has not yet
 *  said it has, in the order they were sent. */
const outbox = new Map<string, Outgoing>();
/** Each chat's status as the server last said it — what `statuses` goes
 *  back to once no prompt of this window's is holding it at working. */
const serverStatuses: Record<string, ProjectStatus> = {};

/* The outbox outlives the page: a prompt typed while the socket was down,
   and a reload before it came back, must not be a prompt lost. Kept in the
   window's own storage — the server is the one thing it cannot reach. */
const OUTBOX_KEY = "ruri-outbox";

function saveOutbox(): void {
  try {
    // one still packing its files is not written down until it has them
    const kept = [...outbox.values()]
      .filter((out) => !packing.has(out.message.clientId))
      .map((out) => ({ message: out.message, shown: out.shown, at: out.at }));
    if (kept.length) localStorage.setItem(OUTBOX_KEY, JSON.stringify(kept));
    else localStorage.removeItem(OUTBOX_KEY);
  } catch {
    // over the storage quota (big attachments): the prompt still goes from
    // memory; only a reload before it does would lose it
  }
}

function restoreOutbox(): void {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    if (!raw) return;
    for (const saved of JSON.parse(raw) as Array<Pick<Outgoing, "message" | "shown" | "at">>) {
      outbox.set(saved.message.clientId, shownAs(saved.message, saved.shown, saved.at));
    }
  } catch {
    localStorage.removeItem(OUTBOX_KEY);
  }
}

/** What stands on screen for a prompt: its bubble or its card. */
function shownAs(
  message: PromptMessage,
  shown: Outgoing["shown"],
  at: number,
  files?: Attachment[],
): Outgoing {
  const attachments: Attachment[] =
    files ??
    (message.attachments ?? []).map(({ id, kind, mediaType, name, n }) => ({ id, kind, mediaType, name, n }));
  const out: Outgoing = { message, shown, at };
  if (shown === "event") {
    out.event = {
      kind: "user",
      id: message.clientId,
      text: message.text,
      ...(attachments.length ? { attachments } : {}),
      ts: at,
    };
  } else if (shown === "queued") {
    out.item = { id: message.clientId, text: message.text, ...(attachments.length ? { attachments } : {}) };
  }
  return out;
}

/** The state with a prompt on its way put on screen. */
function showOutgoing(s: RuriState, out: Outgoing): Partial<RuriState> {
  const channelId = out.message.projectId;
  if (out.shown === "event") {
    return {
      transcripts: {
        ...s.transcripts,
        [channelId]: withOutgoing(channelId, s.transcripts[channelId] ?? [], [out]),
      },
      ...goneOut(s, out),
    };
  }
  if (out.shown === "queued") {
    return {
      queued: { ...s.queued, [channelId]: withOutgoingItems(channelId, s.queued[channelId] ?? [], [out]) },
    };
  }
  return {};
}

/** Prompts on screen whose files are still being packed for the wire:
 *  they go when their bytes are ready, not before — a prompt sent without
 *  its pictures would be a different prompt. */
const packing = new Set<string>();

/** The state with a prompt that has just gone down a socket: its chat at
 * work, its working line counting from now. */
function goneOut(s: RuriState, out: Outgoing): Partial<RuriState> {
  const channelId = out.message.projectId;
  if (out.shown !== "event" || out.onWire === undefined) return {};
  const status = statusWithOutgoing(channelId, s.statuses[channelId] ?? "idle", [out], out.onWire);
  return {
    statuses: { ...s.statuses, [channelId]: status },
    ...(s.turns[channelId]
      ? {}
      : { turns: { ...s.turns, [channelId]: { startedAt: out.onWire, tokens: 0, at: out.onWire } } }),
  };
}

/** Put a prompt from the outbox down the socket, if there is one. */
function transmit(out: Outgoing): boolean {
  if (!send(out.message)) return false;
  out.onWire = Date.now();
  return true;
}

/**
 * Send a prompt — on screen at once, wherever the server is going to put
 * it, and sent now or the moment there is a socket to send it down. Never
 * fails: what the composer held is in the outbox and goes when it can.
 * `files`: the attachments as the bubble shows them (the composer's own
 * copies, see lib/localFiles.ts); `uploads`: their bytes, which may still
 * be on their way — the prompt shows first and goes when they are ready.
 */
export function sendPrompt(
  message: Omit<PromptMessage, "clientId" | "attachments">,
  files?: Attachment[],
  uploads?: Promise<AttachmentUpload[]>,
): void {
  const s = useRuri.getState();
  const channelId = message.projectId;
  const full = { ...message, clientId: crypto.randomUUID() } as PromptMessage;
  const shown = predict(
    { status: s.statuses[channelId], queued: s.queued[channelId], held: s.queueHeld[channelId] },
    message.text,
    message.now === true,
  );
  const out = shownAs(full, shown, Date.now(), files);
  outbox.set(full.clientId, out);
  /** Off it goes — or it waits for a socket, and says so under the chat. */
  const go = (): boolean => {
    saveOutbox();
    return transmit(out);
  };
  const waiting = (state: RuriState): Partial<RuriState> => ({
    unsent: { ...state.unsent, [full.clientId]: channelId },
  });
  if (!uploads) {
    // sent first, then shown: one render, with the chat already at work
    const went = go();
    useRuri.setState((state) => ({ ...showOutgoing(state, out), ...(went ? {} : waiting(state)) }));
    return;
  }
  useRuri.setState((state) => showOutgoing(state, out));
  packing.add(full.clientId);
  uploads.then(
    (attachments) => {
      packing.delete(full.clientId);
      out.message = { ...out.message, ...(attachments.length ? { attachments } : {}) };
      const went = go();
      useRuri.setState((state) => (went ? goneOut(state, out) : waiting(state)));
    },
    () => {
      // the files could not be read back: nothing went, and the words go
      // back to the composer rather than out without what they point at
      packing.delete(full.clientId);
      outbox.delete(full.clientId);
      useRuri.setState((state) => settleOutgoing(state, out, "failed"));
      composeInto(channelId, full.text);
      showError("The attachments could not be read — the prompt is back in the composer.");
    },
  );
}

/** Everything in the outbox, down a socket that has just opened. The ones
 *  that went down the last one too may have arrived — the server knows
 *  them by their ids, and answers rather than runs them again. */
function flushOutbox(): void {
  const gone = [...outbox.values()].filter((out) => !packing.has(out.message.clientId) && transmit(out));
  if (gone.length === 0) return;
  useRuri.setState((s) =>
    gone.reduce<RuriState>((state, out) => ({ ...state, ...goneOut(state, out) }), { ...s, unsent: {} }),
  );
}

/** The server has a prompt, and says where it went. */
function settleOutgoing(
  s: RuriState,
  out: Outgoing,
  as: "event" | "queued" | "other" | "failed",
): Partial<RuriState> {
  const channelId = out.message.projectId;
  const id = out.message.clientId;
  const next: Partial<RuriState> = {};
  if (s.unsent[id]) {
    const { [id]: _gone, ...rest } = s.unsent;
    next.unsent = rest;
  }
  // the bubble, where the server did not make it one — unless the server's
  // own event has already taken its place
  const events = s.transcripts[channelId];
  if (out.event && as !== "event" && events?.includes(out.event)) {
    next.transcripts = { ...s.transcripts, [channelId]: events.filter((event) => event !== out.event) };
  }
  const items = s.queued[channelId];
  if (out.item && as !== "queued" && items?.includes(out.item)) {
    next.queued = { ...s.queued, [channelId]: items.filter((item) => item !== out.item) };
  }
  // working on this window's word alone: the server's word stands now
  const status = statusWithOutgoing(
    channelId,
    serverStatuses[channelId] ?? "idle",
    outbox.values(),
    Date.now(),
  );
  if (status !== s.statuses[channelId]) next.statuses = { ...s.statuses, [channelId]: status };
  if (status !== "working" && status !== "permission" && s.turns[channelId]?.tokens === 0) {
    const { [channelId]: _gone, ...turns } = s.turns;
    next.turns = turns;
  }
  return next;
}

/** Stop a chat's turn. The stop shows at once; the harness winds down
 *  after, and the chat says so when it has. */
export function stopTurn(channelId: string): void {
  if (!send({ type: "interrupt", projectId: channelId })) return;
  useRuri.setState((s) => ({ stopping: { ...s.stopping, [channelId]: true } }));
  // a harness that never says it stopped must not leave it saying so
  setTimeout(() => {
    const { stopping } = useRuri.getState();
    if (!stopping[channelId]) return;
    const { [channelId]: _gone, ...rest } = stopping;
    useRuri.setState({ stopping: rest });
  }, 20_000);
}

/* ── changes on screen before the server's word ─────────────────── */

/**
 * A change this window made to something the server sends whole — the
 * project list, a chat's queue — shown the moment it is made, and laid
 * over each copy the server sends until one shows it (or until it has
 * waited long enough that it is not going to, and the server's word
 * stands). Without it a rename snaps back to the old name for the round
 * trip, and a card dragged in the queue jumps back to where it was.
 */
interface Change<T> {
  apply(value: T): T;
  /** The server's copy already shows it: it is done with. */
  shows(value: T): boolean;
  until: number;
}
const CHANGE_MS = 10_000;

/** The server's copy, with the changes it does not show yet laid over it. */
function laid<T>(changes: Array<Change<T>>, value: T): T {
  const now = Date.now();
  for (let i = changes.length - 1; i >= 0; i -= 1) {
    const change = changes[i]!;
    if (change.until < now || change.shows(value)) changes.splice(i, 1);
  }
  return changes.reduce((v, change) => change.apply(v), value);
}

const projectChanges: Array<Change<Project[]>> = [];
const queueChanges = new Map<string, Array<Change<QueuedPrompt[]>>>();

/** Send a change to the project list, and show it now. */
function changeProjects(
  message: ClientMessage,
  apply: (projects: Project[]) => Project[],
  shows: (projects: Project[]) => boolean,
): void {
  if (!send(message)) {
    showError("Not connected — that did not go through; try again once ruri is back.");
    return;
  }
  projectChanges.push({ apply, shows, until: Date.now() + CHANGE_MS });
  useRuri.setState((s) => ({ projects: apply(s.projects) }));
}

/** Send a change to a chat's queue, and show it now. */
function changeQueue(
  message: ClientMessage,
  channelId: string,
  apply: (items: QueuedPrompt[]) => QueuedPrompt[],
  shows: (items: QueuedPrompt[]) => boolean,
): void {
  if (!send(message)) return;
  const changes = queueChanges.get(channelId) ?? [];
  changes.push({ apply, shows, until: Date.now() + CHANGE_MS });
  queueChanges.set(channelId, changes);
  useRuri.setState((s) => ({ queued: { ...s.queued, [channelId]: apply(s.queued[channelId] ?? []) } }));
}

/** A chat's queue as the server sent it, with this window's prompts on
 *  their way and its own rearranging laid over it. */
function queueOf(channelId: string, items: QueuedPrompt[]): QueuedPrompt[] {
  const changes = queueChanges.get(channelId);
  const mine = withOutgoingItems(channelId, items, outbox.values());
  return changes?.length ? laid(changes, mine) : mine;
}

function onSession(
  projects: Project[],
  sessionId: string,
  change: (session: SessionInfo) => SessionInfo,
): Project[] {
  return projects.map((p) =>
    p.sessions.some((x) => x.id === sessionId)
      ? { ...p, sessions: p.sessions.map((x) => (x.id === sessionId ? change(x) : x)) }
      : p,
  );
}
function onProject(projects: Project[], projectId: string, change: (project: Project) => Project): Project[] {
  return projects.map((p) => (p.id === projectId ? change(p) : p));
}
function sessionIn(projects: Project[], sessionId: string): SessionInfo | undefined {
  for (const p of projects) for (const x of p.sessions) if (x.id === sessionId) return x;
  return undefined;
}

export function renameProject(projectId: string, name: string): void {
  changeProjects(
    { type: "rename_project", projectId, name },
    (projects) => onProject(projects, projectId, (p) => ({ ...p, name })),
    (projects) => projects.find((p) => p.id === projectId)?.name === name,
  );
}

/** Star or unstar a project — or tuck it away or bring it back. The server
 *  flips it; this window shows the side it flips to, whichever copy of the
 *  list comes first. */
export function toggleProject(projectId: string, what: "starred" | "hidden"): void {
  const project = useRuri.getState().projects.find((p) => p.id === projectId);
  if (!project) return;
  const to = !project[what];
  changeProjects(
    { type: what === "starred" ? "toggle_star" : "toggle_hidden", projectId },
    (projects) => onProject(projects, projectId, (p) => ({ ...p, [what]: to })),
    (projects) => Boolean(projects.find((p) => p.id === projectId)?.[what]) === to,
  );
}

/**
 * A chat's model, effort or permission mode, picked — on the picker at
 * once. A chat's pick is its own; a project's is every chat's in it, and
 * what a new one starts on; Home's is Home's (server/handlers/settings.ts).
 */
export function pickSetting(
  channelId: string,
  setting: "model" | "effort" | "permissionMode",
  value: string,
): void {
  const message: ClientMessage =
    setting === "model"
      ? { type: "set_model", projectId: channelId, model: value }
      : setting === "effort"
        ? { type: "set_effort", projectId: channelId, effort: value }
        : { type: "set_permission_mode", projectId: channelId, mode: value as PermissionMode };
  if (channelId === HOME_ID) {
    // Home's settings come back whole (home_settings), and nothing else
    // sends them in between: shown now, they simply stand
    if (send(message)) useRuri.setState((s) => ({ home: { ...s.home, [setting]: value } }));
    return;
  }
  const isSession = sessionIn(useRuri.getState().projects, channelId) !== undefined;
  changeProjects(
    message,
    (projects) =>
      isSession
        ? onSession(projects, channelId, (x) => ({ ...x, [setting]: value }))
        : onProject(projects, channelId, (p) => ({
            ...p,
            [setting]: value,
            sessions: p.sessions.map((x) => {
              const { [setting]: _gone, ...rest } = x;
              return rest;
            }),
          })),
    (projects) =>
      isSession
        ? sessionIn(projects, channelId)?.[setting] === value
        : projects.find((p) => p.id === channelId)?.[setting] === value,
  );
}

/** Take a prompt out of the queue. */
export function unqueue(channelId: string, itemId: string): void {
  changeQueue(
    { type: "queue_remove", projectId: channelId, itemId },
    channelId,
    (items) => items.filter((item) => item.id !== itemId),
    (items) => !items.some((item) => item.id === itemId),
  );
}

/** Carry a queued prompt to just before another — or to the back of the
 *  line, with none. The one being rewritten stays at the end, out of it. */
export function moveQueued(channelId: string, itemId: string, beforeId: string | undefined): void {
  const place = (items: QueuedPrompt[]): QueuedPrompt[] => {
    const moving = items.find((item) => item.id === itemId);
    if (!moving) return items;
    const line = items.filter((item) => item !== moving && !item.editing);
    const at = beforeId ? line.findIndex((item) => item.id === beforeId) : -1;
    if (at === -1) line.push(moving);
    else line.splice(at, 0, moving);
    return [...line, ...items.filter((item) => item !== moving && item.editing)];
  };
  changeQueue(
    { type: "queue_move", projectId: channelId, itemId, ...(beforeId ? { beforeId } : {}) },
    channelId,
    place,
    (items) => {
      const line = items.filter((item) => !item.editing).map((item) => item.id);
      const at = line.indexOf(itemId);
      return at === -1 || (beforeId ? line[at + 1] === beforeId : at === line.length - 1);
    },
  );
}

/** Fold one queued prompt into another — the words in the order the two
 *  stood in the line, the second's markers numbered on from the first's
 *  (server/queue.ts, mergeEntries). */
export function mergeQueued(channelId: string, itemId: string, intoId: string): void {
  changeQueue(
    { type: "queue_merge", projectId: channelId, itemId, intoId },
    channelId,
    (items) => {
      const from = items.find((item) => item.id === itemId);
      const into = items.find((item) => item.id === intoId);
      if (!from || !into || from === into || from.from || into.from) return items;
      const [first, second] = items.indexOf(from) < items.indexOf(into) ? [from, into] : [into, from];
      const offset = { image: 0, video: 0, file: 0, region: 0 };
      for (const att of first.attachments ?? []) {
        offset[att.kind] = Math.max(offset[att.kind], att.n);
        for (const region of att.regions ?? []) offset.region = Math.max(offset.region, region.n);
      }
      const text = second.text.replace(
        /\[(image|video|file|region)\s#(\d+)\]/g,
        (_, kind: keyof typeof offset, n: string) => `[${kind} #${Number(n) + offset[kind]}]`,
      );
      const attachments = [
        ...(first.attachments ?? []),
        ...(second.attachments ?? []).map((att) => ({ ...att, n: att.n + offset[att.kind] })),
      ];
      const merged: QueuedPrompt = {
        id: into.id,
        text: [first.text, text].filter((part) => part.trim()).join("\n\n"),
        ...(attachments.length ? { attachments } : {}),
      };
      return items.filter((item) => item !== from).map((item) => (item === into ? merged : item));
    },
    (items) => !items.some((item) => item.id === itemId),
  );
}

/** Take a queued prompt out of the line to rewrite it: marked so at once,
 *  so the composer knows it is rewriting before the server says so — an
 *  Enter pressed in between puts the rewrite back, rather than sending a
 *  second copy of the prompt. */
export function editQueued(channelId: string, itemId: string): void {
  changeQueue(
    { type: "queue_edit", projectId: channelId, itemId },
    channelId,
    (items) => {
      const item = items.find((x) => x.id === itemId);
      if (!item || item.editing) return items;
      return [...items.filter((x) => x !== item), { ...item, editing: true }];
    },
    (items) => items.some((item) => item.id === itemId && item.editing),
  );
}

/** Cards the user has answered that the server has not yet taken down. */
const answered = new Set<string>();

/** Answer a permission or question card — taken down at once. False when
 *  the answer could not be sent, and the card stays. */
export function answerCard(
  message: Extract<ClientMessage, { type: "permission_response" | "question_response" }>,
): boolean {
  if (!send(message)) return false;
  answered.add(message.requestId);
  useRuri.setState((s) => ({ permissions: s.permissions.filter((p) => p.requestId !== message.requestId) }));
  return true;
}

/** How many chats the window keeps whole at once. Opening one more lets
 *  the least recently opened go back to its tail; opening it again asks.
 *  A dozen: a chat opened from the sidebar is usually one of the last few,
 *  and over a network every one kept is one that opens without a wait. */
const KEEP_LOADED = 12;
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

/**
 * Ask for a chat's history before it is opened — the pointer is on its
 * row, and a click is likely a moment away. Over a network that moment is
 * most of the round trip: the chat opens whole instead of opening to its
 * last few events and filling in. The server marks where this window now
 * stands in it, and catches it up from there when the chat does open.
 */
export function prefetchTranscript(channelId: string): void {
  const state = useRuri.getState();
  if (!state.connected || state.loaded[channelId] || requested.has(channelId)) return;
  if (send({ type: "transcript_get", projectId: channelId, prefetch: true })) requested.add(channelId);
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
 *
 * Whether anyone is looking goes with it. A warm CLI costs 200-odd MB and a
 * steady trickle of battery for as long as it lives, and nobody is about to
 * type into a window that is behind another app — so the server is told
 * when this one sleeps, and lets those processes go a minute later.
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
    // a window nobody is looking at is sent nothing of its chats, and
    // caught up on them as it wakes (receive, below, holds the rest)
    live: isAwake(),
    ...(boardsUp > 0 ? { board: true } : {}),
    ...(metersUp > 0 ? { meters: true } : {}),
    // not what is on screen but whether anyone is in front of it: what
    // decides how long an open chat's process is kept warm, and whether the
    // statistics meters sample at all
    awake: isAwake(),
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

// waking and going to sleep change nothing on screen, but they change
// whether anyone is looking at it, which the server acts on
subscribeAwake(syncView);

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
 * is the whole reason the machine is read at all (server/resources.ts) — so this is held
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

/* ── asleep: nothing applies ─────────────────────────────────────── */

/** What came while nobody was looking (lib/held.ts): held unread, so the
 *  page does no work at all, and applied as the window wakes. */
const held = new Held();

/** Waking: everything held, applied at once — one task, so one render. The
 *  chats on screen are caught up by the server, once the view says live. */
function applyHeld(): void {
  const messages = held.take();
  // too much went by: a fresh connection, and its snapshot, instead
  if (messages === "overflow") {
    ws?.close();
    return;
  }
  for (const msg of messages) apply(msg);
  // an agent's log left open heard nothing while the window slept
  const panel = useRuri.getState().agentPanel;
  const key = panel?.keys.at(-1);
  if (panel && key) refreshAgentLog(panel.projectId, key);
}

subscribeAwake(() => {
  if (isAwake()) applyHeld();
});

function receive(msg: ServerMessage): void {
  if (isAwake()) apply(msg);
  else held.hold(msg);
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

/** Ask again for a log that is open — a script's, whose output is read
 *  afresh each time rather than sent as it comes. */
export function refreshAgentLog(projectId: string, key: string): void {
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

/* ── the line to the server ───────────────────────────────────────── */

/**
 * A window onto another computer (server/sharing.ts — the page came over
 * TLS). Its socket crosses a network, which can drop it without a word: a
 * laptop that slept, a change of Wi-Fi. The browser goes on believing such
 * a socket is open, and what is sent down it is simply gone. So this
 * window asks every so often whether the server is still there (`ping`),
 * and a socket that does not answer is let go of and a new one opened. The
 * window's own socket on this computer cannot fail that way, and is left
 * alone: nothing to ask, nothing to wake for.
 */
const OVER_NETWORK = location.protocol === "https:";
/** Quiet this long, and the server is asked whether it is there. */
const QUIET_MS = 10_000;
/** Asked, and no word back in this long: the socket is dead. */
const ANSWER_MS = 4_000;
/** When the server last said anything at all — any message is proof of life. */
let lastHeard = 0;
let probing = false;

/** Ask the server whether it is there; no word back in `wait` and the
 *  socket is let go of. */
function probe(wait = ANSWER_MS): void {
  const socket = ws;
  if (!socket || socket.readyState !== WebSocket.OPEN || probing) return;
  probing = true;
  const asked = Date.now();
  socket.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
  setTimeout(() => {
    probing = false;
    if (ws === socket && lastHeard < asked) abandon(socket);
  }, wait);
}

if (OVER_NETWORK) {
  setInterval(() => {
    if (Date.now() - lastHeard >= QUIET_MS) probe();
  }, QUIET_MS / 2);
  // back on a network, or back in front of someone: is the line still good?
  window.addEventListener("online", () => probe(2_500));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - lastHeard > 3_000) probe(2_500);
  });
}

/** Let a socket go that has stopped answering, and open another now —
 *  not after the close it would wait on, which a dead line never sends. */
function abandon(socket: WebSocket): void {
  socket.onclose = null;
  socket.onmessage = null;
  socket.onerror = null;
  try {
    socket.close();
  } catch {
    // closing a dead socket can throw; it is let go of either way
  }
  if (ws !== socket) return;
  ws = null;
  useRuri.setState({ connected: false });
  connect();
}

/** Tries since the socket was last open; how long each waits grows with it,
 *  from nothing to a few seconds. */
let attempts = 0;
const RETRY_MS = [0, 250, 1_000, 2_000];

export function connect(): void {
  // Dev-only fixture mode (?fixture): canned data instead of a live server,
  // so the UI can be screenshotted deterministically without spending tokens.
  if (new URLSearchParams(location.search).has("fixture")) {
    void import("./fixture").then((m) => m.installFixture());
    // and a door for the scripts that drive it to play the server's part —
    // a reply streaming in, events arriving (scripts/perf.mjs)
    (window as unknown as { __ruriReceive?: typeof receive }).__ruriReceive = receive;
    return;
  }
  const retry = () => {
    useRuri.setState({ connected: false });
    const wait = RETRY_MS[attempts] ?? 3_000;
    attempts += 1;
    setTimeout(connect, wait);
  };
  resolveToken().then(
    (t) => {
      const socket = new WebSocket(`${WS_URL}/?token=${encodeURIComponent(t)}`);
      ws = socket;
      socket.onopen = () => {
        attempts = 0;
        lastHeard = Date.now();
        useRuri.setState({ connected: true });
        flushUnsavedDrafts();
        // prompts sent while there was no socket, or on the one that died
        flushOutbox();
        // who may message whom: the talk page, and the header's count
        send({ type: "talk_get" });
        // a new connection knows nothing of what is on screen
        lastView = "";
        sendView();
      };
      socket.onmessage = (raw) => {
        lastHeard = Date.now();
        const msg = JSON.parse(raw.data as string) as ServerMessage;
        // proof of life and nothing more: never held, never applied
        if (msg.type === "pong") return;
        receive(msg);
      };
      socket.onclose = () => {
        if (ws === socket) ws = null;
        retry();
      };
      socket.onerror = () => socket.close();
    },
    // no token means no server yet (dev: the file appears when it starts)
    retry,
  );
}

restoreOutbox();

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
      // The snapshot carries tails: every chat is unloaded again, and the
      // one on screen asks for itself (ChatPane). A chat this window held
      // whole stays on screen meanwhile — its tail laid over its end —
      // rather than going blank for the round trip, which on a socket that
      // dropped across a network is the one moment it is most noticed.
      requested.clear();
      historyAsked.clear();
      opened.length = 0;
      Object.assign(serverStatuses, msg.statuses);
      setState((s) => ({
        projects: laid(projectChanges, msg.projects),
        transcripts: Object.fromEntries(
          Object.entries(msg.transcripts).map(([id, tail]) => {
            const held = s.loaded[id] ? s.transcripts[id] : undefined;
            return [id, withOutgoing(id, held ? overlay(held, tail) : tail, outbox.values())];
          }),
        ),
        loaded: {},
        history: {},
        // what the chats on screen fold away above their newest compaction,
        // until each one's transcript comes again with its own
        earlier: Object.fromEntries(Object.entries(s.earlier).filter(([id]) => id in msg.transcripts)),
        statuses: Object.fromEntries(
          Object.entries(msg.statuses).map(([id, status]) => [
            id,
            statusWithOutgoing(id, status, outbox.values(), Date.now()),
          ]),
        ),
        work: msg.work ?? {},
        // a card answered here stays down, whatever the server still holds
        permissions: msg.permissions.filter((p) => !answered.has(p.requestId)),
        models: msg.models,
        summaries: msg.summaries,
        tracker: msg.tracker,
        ideas: msg.ideas,
        components: msg.components,
        componentDirs: msg.componentDirs,
        secrets: msg.secrets,
        queued: Object.fromEntries(Object.entries(msg.queued).map(([id, items]) => [id, queueOf(id, items)])),
        queueHeld: msg.queuesHeld,
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
        platform: msg.platform,
        sharing: msg.sharing,
        remoteDevice: msg.remoteDevice ?? null,
        bridges: msg.bridges,
        workspaceDir: msg.workspaceDir,
        musicDir: msg.musicDir,
        home: msg.home,
        starredModels: msg.starredModels,
        smallModel: msg.smallModel,
        memoryModel: msg.memoryModel,
        defaultModel: msg.defaultModel,
        user: msg.user,
        harnesses: msg.harnesses ?? [],
        harnessesChecking: msg.harnessesChecking === true,
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
        activeId: stillShown(s.projects, msg.projects, s.activeId),
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
      const projects = laid(projectChanges, msg.projects);
      setState((s) => ({
        projects,
        activeId: stillShown(s.projects, projects, s.activeId),
      }));
      break;
    }
    case "queued": {
      setState((s) => ({
        queued: { ...s.queued, [msg.projectId]: queueOf(msg.projectId, msg.items) },
        queueHeld: { ...s.queueHeld, [msg.projectId]: msg.held },
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
          [msg.projectId]: reuse(
            s.transcripts[msg.projectId],
            withOutgoing(msg.projectId, msg.events, outbox.values()),
          ),
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
    case "recall": {
      setState((s) => ({
        recalls: {
          ...s.recalls,
          [msg.projectId]: { busy: msg.busy, at: Date.now(), ...(msg.note ? { note: msg.note } : {}) },
        },
      }));
      break;
    }
    case "sheet": {
      setState((s) => ({
        sheets: { ...s.sheets, [msg.projectId]: msg.sheet },
        sheetFacts: {
          ...s.sheetFacts,
          [msg.projectId]: { sources: msg.sources ?? {}, ...(msg.git ? { git: msg.git } : {}) },
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
      setState((s) => {
        const dirs = { ...s.componentDirs };
        if (msg.dir) dirs[msg.projectId] = msg.dir;
        else delete dirs[msg.projectId];
        return { components: { ...s.components, [msg.projectId]: msg.items }, componentDirs: dirs };
      });
      break;
    }
    case "component_code": {
      setState((s) => ({ componentCode: { ...s.componentCode, [msg.componentId]: msg.files } }));
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
    case "memory_model": {
      setState({ memoryModel: msg.model });
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
        queueHeld: { ...s.queueHeld, [HOME_ID]: undefined },
        contexts: Object.fromEntries(Object.entries(s.contexts).filter(([k]) => k !== HOME_ID)),
        turns: Object.fromEntries(Object.entries(s.turns).filter(([k]) => k !== HOME_ID)),
      }));
      break;
    }
    case "event": {
      setState((s) => {
        let transcript = [...(s.transcripts[msg.projectId] ?? [])];
        const existing = transcript.findIndex((event) => event.id === msg.event.id);
        if (existing === -1) transcript.splice(insertAt(transcript, msg.event), 0, msg.event);
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
          // event that trickles in while a background session works. The
          // open chat is elsewhere too while the projects page or settings
          // has the pane: you went there to wait, and it is the projects
          // page that should say this one is done.
          // A teammate's turn wears none: it has no row of its own, and
          // its lead says what came of it.
          unread:
            msg.event.kind !== "result" ||
            (msg.projectId === s.activeId && !s.projectsOpen && !s.settingsOpen) ||
            leadFor(s.projects, msg.projectId) !== msg.projectId
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
          transcripts[id] = withOutgoing(
            id,
            s.loaded[id] && held ? overlay(held, tail) : tail,
            outbox.values(),
          );
        }
        return { transcripts };
      });
      break;
    }
    case "status": {
      serverStatuses[msg.projectId] = msg.status;
      setState((s) => {
        // a prompt of this window's on its way keeps the chat working,
        // whatever a turn that ended a moment before says
        const status = statusWithOutgoing(msg.projectId, msg.status, outbox.values(), Date.now());
        const stopped = status !== "working" && status !== "permission" && s.stopping[msg.projectId];
        if (!stopped) return { statuses: { ...s.statuses, [msg.projectId]: status } };
        const { [msg.projectId]: _gone, ...stopping } = s.stopping;
        return { statuses: { ...s.statuses, [msg.projectId]: status }, stopping };
      });
      break;
    }
    case "sent": {
      const out = outbox.get(msg.clientId);
      if (!out) break;
      outbox.delete(msg.clientId);
      saveOutbox();
      setState((s) => settleOutgoing(s, out, msg.as));
      // it never went: the words go back where they were written
      if (msg.as === "failed") {
        composeInto(msg.projectId, out.message.text);
        setState({ lastError: "That prompt did not go through — it is back in the composer." });
      }
      break;
    }
    case "pong":
      break;
    case "talk": {
      setState({ talk: { policy: msg.policy, letters: msg.letters } });
      break;
    }
    case "team": {
      setState((s) => ({
        team: {
          ...s.team,
          [msg.projectId]: {
            members: msg.members,
            ...(msg.liaison ? { liaison: msg.liaison } : {}),
            freeLayers: msg.freeLayers,
            budget: msg.budget,
          },
        },
      }));
      break;
    }
    case "integrations": {
      setState({
        integrations: { ...(msg.projectId ? { projectId: msg.projectId } : {}), data: msg.integrations },
      });
      break;
    }
    case "plugins_found": {
      setState({
        pluginsFound: { harness: msg.harness, query: msg.query, plugins: msg.plugins, total: msg.total },
      });
      break;
    }
    case "integration_done": {
      setState({ integrationNote: { ok: msg.ok, message: msg.message, at: Date.now() } });
      break;
    }
    case "harnesses": {
      setState({ harnesses: msg.harnesses, harnessesChecking: msg.checking === true });
      break;
    }
    case "work": {
      setState((s) => {
        const { [msg.projectId]: _gone, ...rest } = s.work;
        return { work: msg.work ? { ...rest, [msg.projectId]: msg.work } : rest };
      });
      break;
    }
    case "permission_request": {
      // answered here already: the server has not heard yet, and the card
      // stays down
      if (answered.has(msg.request.requestId)) break;
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
      answered.delete(msg.requestId);
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
    case "sharing": {
      setState({ sharing: msg.sharing });
      break;
    }
    case "sharing_invite": {
      setState({ invite: { words: msg.words, expires: msg.expires } });
      break;
    }
    case "folder_picked": {
      if (msg.path) setState({ picked: { path: msg.path, target: msg.target ?? "workspace" } });
      break;
    }
    case "picture_stored": {
      pictureStored(msg.id, msg.url);
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
