/** Types (and the one shared constant) between the ruri server and the web UI. */

/** The pseudo-project id of the Home view — the workspace-manager agent. */
export const HOME_ID = "home";

export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";

export interface Project {
  id: string;
  name: string;
  path: string;
  folder?: string;
  /** Model override for this project's sessions; the CLI default when unset. */
  model?: string;
  /** Permission mode for this project's sessions (default "default"). */
  permissionMode?: PermissionMode;
}

export type ProjectStatus = "idle" | "working" | "permission" | "error";

/** A model the CLI reports as available (for the picker). */
export interface ModelChoice {
  value: string;
  displayName: string;
}

/** Tick state of a tracker item: open → liked (check) → rejected (x) → open. */
export type TrackerStatus = "open" | "liked" | "rejected";

/** One entry on the feature/prompt tracker checklist. */
export interface TrackerItem {
  id: string;
  text: string;
  note: string;
  status: TrackerStatus;
  /** "auto" = extracted from a turn by the small model; "manual" = user-added. */
  source: "auto" | "manual";
  /** Turn (user-event id) this item was extracted from, when auto. */
  turnId?: string;
  ts: number;
}

/** A playable track in the music library (served by GET /music/track). */
export interface Track {
  id: string;
  title: string;
  filename: string;
  /** Same-origin streaming URL (/music/track?p=…). */
  url: string;
}

/** A folder of tracks (served by GET /music/playlists). */
export interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
}

export type TranscriptEvent =
  | { kind: "user"; id: string; text: string; ts: number }
  | { kind: "assistant"; id: string; text: string; ts: number }
  | { kind: "tool"; id: string; name: string; summary: string; ts: number }
  | {
      kind: "result";
      id: string;
      ok: boolean;
      costUsd?: number;
      durationMs?: number;
      error?: string;
      ts: number;
    }
  | { kind: "info"; id: string; text: string; ts: number };

export interface PermissionRequest {
  requestId: string;
  projectId: string;
  toolName: string;
  input: unknown;
  /**
   * Permission-rule updates the CLI suggests for "don't ask again" (opaque
   * Agent SDK `PermissionUpdate` objects, echoed back verbatim on always-allow).
   */
  suggestions?: unknown[];
  ts: number;
}

export type ClientMessage =
  | { type: "add_project"; name: string; path: string; folder?: string }
  | { type: "pick_folder" }
  | { type: "remove_project"; projectId: string }
  | { type: "send"; projectId: string; text: string }
  | { type: "interrupt"; projectId: string }
  | { type: "permission_response"; requestId: string; allow: boolean; always?: boolean }
  | { type: "set_model"; projectId: string; model: string }
  | { type: "set_permission_mode"; projectId: string; mode: PermissionMode }
  | { type: "tracker_add"; projectId: string; text: string; note?: string }
  | {
      type: "tracker_update";
      projectId: string;
      itemId: string;
      status?: TrackerStatus;
      note?: string;
      text?: string;
    }
  | { type: "tracker_remove"; projectId: string; itemId: string }
  | { type: "set_workspace"; path: string };

export type ServerMessage =
  | {
      type: "snapshot";
      projects: Project[];
      transcripts: Record<string, TranscriptEvent[]>;
      statuses: Record<string, ProjectStatus>;
      permissions: PermissionRequest[];
      models: ModelChoice[];
      /** Turn summaries per project, keyed by the turn's user-event id. */
      summaries: Record<string, Record<string, string>>;
      /** Feature-tracker checklists per project. */
      tracker: Record<string, TrackerItem[]>;
      /** Whether the host can show a native folder-picker dialog. */
      canPickFolder: boolean;
      /** The workspace root the Home agent manages (where projects live). */
      workspaceDir: string;
    }
  | { type: "projects"; projects: Project[] }
  | { type: "folder_picked"; path: string | null }
  | { type: "turn_summary"; projectId: string; turnId: string; summary: string }
  | { type: "tracker"; projectId: string; items: TrackerItem[] }
  | { type: "workspace"; path: string }
  | { type: "event"; projectId: string; event: TranscriptEvent }
  | { type: "delta"; projectId: string; messageId: string; delta: string }
  | { type: "status"; projectId: string; status: ProjectStatus }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "models"; models: ModelChoice[] }
  | { type: "error"; message: string };
