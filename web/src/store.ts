import { create } from "zustand";
import {
  HOME_ID,
  type ClientMessage,
  type Attachment,
  type ContextUsage,
  type DraftAttachment,
  type DraftAttachmentUpload,
  type HomeSettings,
  type ModelChoice,
  type PermissionRequest,
  type PickTarget,
  type Project,
  type ProjectStatus,
  type QueuedPrompt,
  type ServerMessage,
  type TrackerItem,
  type TranscriptEvent,
  type UsageLimits,
} from "../../shared/protocol";
import type { ComposerAttachment } from "./components/Attachments";
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
  counter: { image: number; video: number; file: number };
}
export const composerDrafts = new Map<string, ComposerDraft>();

/* A half-written prompt outlives the app, attachments included. The server
   holds it — the window's own storage cannot: the app serves itself on a
   fresh port every launch, so localStorage lands under a different origin
   each time. */
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** Channels this window has actually had a draft for. A composer mounts
 *  empty and immediately saves that emptiness; without this, that first
 *  write would race the snapshot and wipe the very draft it is about to
 *  restore. Only a channel we know had something can clear itself. */
const draftedChannels = new Set<string>();
/** Attachment ids the server already has bytes for — everything after the
 *  first save is metadata, so editing a caption never re-uploads a video. */
const storedAttachments = new Set<string>();

/** Hand the channel's draft to the server, a beat after typing stops. */
function persistDraft(channelId: string, draft: ComposerDraft): void {
  clearTimeout(draftTimers.get(channelId));
  draftTimers.set(
    channelId,
    setTimeout(() => {
      draftTimers.delete(channelId);
      void (async () => {
        const attachments: DraftAttachmentUpload[] = await Promise.all(
          draft.atts.map(async (att) => {
            const fresh = !storedAttachments.has(att.id);
            storedAttachments.add(att.id);
            return {
              id: att.id,
              kind: att.kind,
              mediaType: att.mediaType,
              name: att.name,
              n: att.n,
              ...(att.regions.length ? { regions: att.regions } : {}),
              ...(fresh ? { data: await fileToBase64(att.file) } : {}),
            };
          }),
        );
        send({ type: "draft", projectId: channelId, text: draft.text, attachments });
      })();
    }, 400),
  );
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
  send({ type: "draft", projectId: channelId, text: "", attachments: [] });
}

/**
 * Bring a saved draft's attachments back as live files: the bytes are where
 * every other attachment lives, so fetching each one gives the composer a
 * real File again — previews, region crops, and the send path all work on it
 * exactly as they did before the quit. Anything whose file is gone is
 * dropped; its [marker] stays in the text as words.
 */
async function restoreAttachments(
  channelId: string,
  saved: DraftAttachment[],
): Promise<void> {
  const atts: ComposerAttachment[] = [];
  for (const att of saved) {
    const live = await liveAttachment(att, att.n);
    if (live) atts.push(live);
  }
  const draft = composerDrafts.get(channelId);
  // typing in this channel while the files loaded wins; the marker numbering
  // picks up above whatever came back
  if (!draft || draft.atts.length > 0) return;
  const counter = { image: 0, video: 0, file: 0 };
  for (const att of atts) counter[att.kind] = Math.max(counter[att.kind], att.n);
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
    const counter = { ...(before?.counter ?? { image: 0, video: 0, file: 0 }) };
    const live: ComposerAttachment[] = [];
    let renumbered = text;
    for (const att of attachments) {
      const fresh = await liveAttachment(att, counter[att.kind] + 1);
      if (!fresh) continue;
      counter[att.kind] += 1;
      live.push(fresh);
      // a placeholder first: renumbering 1→2 while a 2 is still around
      // would otherwise renumber it twice
      renumbered = renumbered.replaceAll(`[${att.kind} #${att.n}]`, `\u0000${att.kind}:${fresh.n}\u0000`);
    }
    renumbered = renumbered.replaceAll(/\u0000(image|video|file):(\d+)\u0000/g, "[$1 #$2]");
    const draft = composerDrafts.get(channelId);
    const body = draft?.text.trim()
      ? `${draft.text.replace(/\s+$/, "")}\n${renumbered}`
      : renumbered;
    setComposerDraft(channelId, {
      text: body,
      atts: [...(draft?.atts ?? []), ...live],
      counter,
    });
    bumpDraft(channelId);
  })();
}

/** Append text to a channel's saved draft (async prompt arrivals). */
function appendDraft(channelId: string, text: string): void {
  const prev = composerDrafts.get(channelId);
  setComposerDraft(channelId, {
    text: prev?.text.trim() ? `${prev.text.replace(/\s+$/, "")}\n${text}` : text,
    atts: prev?.atts ?? [],
    counter: prev?.counter ?? { image: 0, video: 0, file: 0 },
  });
}

interface RuriState {
  connected: boolean;
  projects: Project[];
  activeId: string | null;
  transcripts: Record<string, TranscriptEvent[]>;
  drafts: Record<string, Draft | undefined>;
  statuses: Record<string, ProjectStatus>;
  permissions: PermissionRequest[];
  unread: Record<string, boolean>;
  models: ModelChoice[];
  /** Turn summaries per project, keyed by the turn's user-event id. */
  summaries: Record<string, Record<string, string>>;
  /** Feature-tracker checklists per project. */
  tracker: Record<string, TrackerItem[]>;
  /** App-side prompt queue per channel — held until the running turn ends. */
  queued: Record<string, QueuedPrompt[]>;
  /** Limit windows per provider id (percent used) for the usage gauges. */
  usage: Record<string, UsageLimits>;
  /** Context-window occupancy per channel. */
  contexts: Record<string, ContextUsage>;
  /** Rapid-fire mode: the main pane cycles through sessions awaiting a prompt. */
  rapid: boolean;
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
  /** The local account name shown on the sidebar's account bar. */
  user: string;
  /** Whether the host can show a native folder picker (Electron shell). */
  canPickFolder: boolean;
  /** Latest native-picker result, tagged with what the pick was for. */
  picked: { path: string; target: PickTarget } | null;
  lastError: string | null;
  setActive(id: string | null): void;
  setRapid(on: boolean): void;
  clearPicked(): void;
  dismissError(): void;
}

export const useRuri = create<RuriState>((set) => ({
  connected: false,
  projects: [],
  activeId: HOME_ID,
  transcripts: {},
  drafts: {},
  statuses: {},
  permissions: [],
  unread: {},
  models: [],
  summaries: {},
  tracker: {},
  queued: {},
  usage: {},
  contexts: {},
  rapid: false,
  draftBumps: {},
  workspaceDir: "",
  musicDir: "",
  musicEpoch: 0,
  home: {},
  starredModels: [],
  smallModel: "",
  user: "",
  canPickFolder: false,
  picked: null,
  lastError: null,
  setActive: (id) =>
    set((s) => {
      // Home is ephemeral: crossing its boundary (either direction) asks the
      // server to wipe it — ignored server-side while a turn is running.
      if ((s.activeId === HOME_ID) !== (id === HOME_ID)) send({ type: "reset_home" });
      return { activeId: id, rapid: false, unread: id ? { ...s.unread, [id]: false } : s.unread };
    }),
  setRapid: (on) => set({ rapid: on }),
  clearPicked: () => set({ picked: null }),
  dismissError: () => set({ lastError: null }),
}));

// Vite dev server (:5173) talks to the standalone server on :7777; when the
// UI is served by the ruri server itself (desktop app / production), the
// WebSocket lives on the same origin.
const WS_URL = import.meta.env.DEV ? `ws://${location.hostname}:7777` : `ws://${location.host}`;

/** Base for the server's HTTP endpoints (music etc.) — empty when same-origin. */
export const HTTP_BASE = import.meta.env.DEV ? `http://${location.hostname}:7777` : "";
let ws: WebSocket | null = null;

export function send(message: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export function connect(): void {
  // Dev-only fixture mode (?fixture): canned data instead of a live server,
  // so the UI can be screenshotted deterministically without spending tokens.
  if (new URLSearchParams(location.search).has("fixture")) {
    void import("./fixture").then((m) => m.installFixture());
    return;
  }
  ws = new WebSocket(WS_URL);
  ws.onopen = () => useRuri.setState({ connected: true });
  ws.onmessage = (raw) => apply(JSON.parse(raw.data as string) as ServerMessage);
  ws.onclose = () => {
    useRuri.setState({ connected: false });
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws?.close();
}

function apply(msg: ServerMessage): void {
  const { setState } = useRuri;
  switch (msg.type) {
    case "snapshot": {
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
          counter: { image: 0, video: 0, file: 0 },
        });
        draftedChannels.add(channelId);
        // the files follow: each one is fetched back into a live File and
        // lands in the strip when it arrives
        if (draft.attachments?.length) void restoreAttachments(channelId, draft.attachments);
      }
      setState((s) => ({
        projects: msg.projects,
        transcripts: msg.transcripts,
        statuses: msg.statuses,
        permissions: msg.permissions,
        models: msg.models,
        summaries: msg.summaries,
        tracker: msg.tracker,
        queued: msg.queued,
        usage: msg.usage,
        contexts: msg.contexts,
        canPickFolder: msg.canPickFolder,
        workspaceDir: msg.workspaceDir,
        musicDir: msg.musicDir,
        home: msg.home,
        starredModels: msg.starredModels,
        smallModel: msg.smallModel,
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
        activeId:
          s.activeId &&
          (s.activeId === HOME_ID ||
            msg.projects.some((p) => p.sessions.some((x) => x.id === s.activeId)))
            ? s.activeId
            : HOME_ID,
      }));
      break;
    }
    case "projects": {
      setState((s) => ({
        projects: msg.projects,
        activeId:
          s.activeId &&
          (s.activeId === HOME_ID ||
            msg.projects.some((p) => p.sessions.some((x) => x.id === s.activeId)))
            ? s.activeId
            : HOME_ID,
      }));
      break;
    }
    case "queued": {
      setState((s) => ({ queued: { ...s.queued, [msg.projectId]: msg.items } }));
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
    case "usage": {
      setState({ usage: msg.limits });
      break;
    }
    case "context": {
      setState((s) => ({ contexts: { ...s.contexts, [msg.projectId]: msg.context } }));
      break;
    }
    case "review_prompt":
    case "compose": {
      // Text bound for a channel's composer (a review's fix-it prompt, a
      // rewound prompt back for editing) goes straight into the persistent
      // draft map — never through component state, so switching sessions
      // can't lose it — and the bump tells a mounted composer to re-read.
      appendDraft(msg.projectId, msg.text);
      bumpDraft(msg.projectId);
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
    case "starred_models": {
      setState({ starredModels: msg.models });
      break;
    }
    case "small_model": {
      setState({ smallModel: msg.model });
      break;
    }
    case "home_reset": {
      setState((s) => ({
        transcripts: { ...s.transcripts, [HOME_ID]: [] },
        summaries: { ...s.summaries, [HOME_ID]: {} },
        drafts: { ...s.drafts, [HOME_ID]: undefined },
        statuses: { ...s.statuses, [HOME_ID]: "idle" },
        unread: { ...s.unread, [HOME_ID]: false },
        queued: { ...s.queued, [HOME_ID]: [] },
        contexts: Object.fromEntries(Object.entries(s.contexts).filter(([k]) => k !== HOME_ID)),
      }));
      break;
    }
    case "event": {
      setState((s) => {
        const transcript = [...(s.transcripts[msg.projectId] ?? []), msg.event];
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
    case "status": {
      setState((s) => ({ statuses: { ...s.statuses, [msg.projectId]: msg.status } }));
      break;
    }
    case "permission_request": {
      setState((s) => ({ permissions: [...s.permissions, msg.request] }));
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
          [msg.projectId]: { ...s.summaries[msg.projectId], [msg.turnId]: msg.summary },
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
