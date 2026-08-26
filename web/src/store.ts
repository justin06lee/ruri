import { create } from "zustand";
import {
  HOME_ID,
  type ClientMessage,
  type HomeSettings,
  type ModelChoice,
  type PermissionRequest,
  type PickTarget,
  type Project,
  type ProjectStatus,
  type ServerMessage,
  type TrackerItem,
  type TranscriptEvent,
} from "../../shared/protocol";

export interface Draft {
  messageId: string;
  text: string;
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
  /** Split-send queue depth per channel. */
  queue: Record<string, number>;
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
  queue: {},
  composerSeed: null,
  workspaceDir: "",
  musicDir: "",
  musicEpoch: 0,
  home: {},
  canPickFolder: false,
  picked: null,
  lastError: null,
  setActive: (id) =>
    set((s) => ({ activeId: id, unread: id ? { ...s.unread, [id]: false } : s.unread })),
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
        canPickFolder: msg.canPickFolder,
        workspaceDir: msg.workspaceDir,
        musicDir: msg.musicDir,
        home: msg.home,
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
    case "queue": {
      setState((s) => ({ queue: { ...s.queue, [msg.projectId]: msg.remaining } }));
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
          unread:
            msg.projectId === s.activeId ? s.unread : { ...s.unread, [msg.projectId]: true },
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
      setState((s) => ({
        permissions: [...s.permissions, msg.request],
        unread:
          msg.request.projectId === s.activeId
            ? s.unread
            : { ...s.unread, [msg.request.projectId]: true },
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
