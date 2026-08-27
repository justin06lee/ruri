import { create } from "zustand";
import {
  HOME_ID,
  type ClientMessage,
  type ContextUsage,
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

/** Append text to a channel's saved draft (async prompt arrivals). */
function appendDraft(channelId: string, text: string): void {
  const prev = composerDrafts.get(channelId);
  composerDrafts.set(channelId, {
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
  /** Account limit windows (percent used) for the usage gauges. */
  usage: UsageLimits;
  /** Context-window occupancy per channel. */
  contexts: Record<string, ContextUsage>;
  /** Text waiting to be inserted into the composer (tracker "send as prompt"). */
  composerSeed: string | null;
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
  seedComposer(text: string): void;
  clearComposerSeed(): void;
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
  composerSeed: null,
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
      return { activeId: id, unread: id ? { ...s.unread, [id]: false } : s.unread };
    }),
  seedComposer: (text) => set({ composerSeed: text }),
  clearComposerSeed: () => set({ composerSeed: null }),
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
    case "review_prompt": {
      // The generated fix-it prompt goes into the composer of the channel
      // that was reviewed — live-seeded if it's still active, otherwise into
      // its saved draft for the next visit.
      const state = useRuri.getState();
      if (msg.projectId === state.activeId) state.seedComposer(msg.text);
      else appendDraft(msg.projectId, msg.text);
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
