import { create } from "zustand";
import type {
  ClientMessage,
  PermissionRequest,
  Project,
  ProjectStatus,
  ServerMessage,
  TranscriptEvent,
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
  lastError: string | null;
  setActive(id: string | null): void;
  dismissError(): void;
}

export const useRuri = create<RuriState>((set) => ({
  connected: false,
  projects: [],
  activeId: null,
  transcripts: {},
  drafts: {},
  statuses: {},
  permissions: [],
  unread: {},
  lastError: null,
  setActive: (id) =>
    set((s) => ({ activeId: id, unread: id ? { ...s.unread, [id]: false } : s.unread })),
  dismissError: () => set({ lastError: null }),
}));

// Vite dev server (:5173) talks to the standalone server on :7777; when the
// UI is served by the ruri server itself (desktop app / production), the
// WebSocket lives on the same origin.
const WS_URL = import.meta.env.DEV ? `ws://${location.hostname}:7777` : `ws://${location.host}`;
let ws: WebSocket | null = null;

export function send(message: ClientMessage): void {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

export function connect(): void {
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
        drafts: {},
        activeId:
          s.activeId && msg.projects.some((p) => p.id === s.activeId)
            ? s.activeId
            : (msg.projects[0]?.id ?? null),
      }));
      break;
    }
    case "projects": {
      setState((s) => ({
        projects: msg.projects,
        activeId:
          s.activeId && msg.projects.some((p) => p.id === s.activeId)
            ? s.activeId
            : (msg.projects[0]?.id ?? null),
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
    case "error": {
      setState({ lastError: msg.message });
      break;
    }
  }
}
