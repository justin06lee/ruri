/** Types (and the one shared constant) between the ruri server and the web UI. */

/** The pseudo-project id of the Home view — the workspace-manager agent. */
export const HOME_ID = "home";

/** The model a session runs on when none is picked — no ambiguous
 *  "default" entries anywhere; unset simply means Fable. */
export const DEFAULT_MODEL = "claude-fable-5[1m]";

/**
 * One live coding session inside a project. Transcripts, statuses,
 * drafts, summaries, and tracker items are keyed by the session id (the
 * protocol's `projectId` fields carry session ids for project sessions).
 */
export interface SessionInfo {
  id: string;
  /** Role title, auto-named by the small model ("Frontend UI", …). */
  title?: string;
}

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
  /** Bookmarked: shown in the Starred section above the project tree. */
  starred?: boolean;
  /** The project's sessions (at least one). */
  sessions: SessionInfo[];
}

export type ProjectStatus = "idle" | "working" | "permission" | "error";

/** A model in the device-wide catalog. Claude models are bare ids; other
 *  harnesses use yagami's "provider:model" convention. */
export interface ModelChoice {
  value: string;
  /** The model's own name, no provider prefix ("Opus", "GPT-5.6-Sol"). */
  displayName: string;
  /** Provider id when the model belongs to a non-Claude harness. */
  provider?: string;
  /** Human name of that harness ("Codex CLI"), for tags and placeholders. */
  providerLabel?: string;
}

/** A file attached to a prompt — image, video, or any other file (pdf,
 *  text, source, …); "file" kinds are saved to disk and read via tools. */
export interface Attachment {
  id: string;
  kind: "image" | "video" | "file";
  mediaType: string;
  name: string;
  /** Marker number as shown in the prompt text ([image #2] → 2). */
  n: number;
  /** Streaming URL once the server stored it (/uploads/…). */
  url?: string;
}

/** Wire form when sending: base64 payload plus optional region annotations. */
export interface AttachmentUpload extends Attachment {
  data: string;
  /** Region crops of an image, each carrying the user's note. */
  regions?: Array<{ note: string; data: string; mediaType: string }>;
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
  /** Marked needs-work in a past review — shown pinned with a repeat mark. */
  repeat?: boolean;
  ts: number;
}

/** A prompt held app-side until the running turn finishes (editable). */
export interface QueuedPrompt {
  id: string;
  text: string;
  attachments?: Attachment[];
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
  | { kind: "user"; id: string; text: string; attachments?: Attachment[]; ts: number }
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

/** What a native folder pick is for — routed back with the result. */
export type PickTarget = "workspace" | "music";

/** Home-agent settings (the Home composer's model/permission dropdowns). */
export interface HomeSettings {
  model?: string;
  permissionMode?: PermissionMode;
}

export type ClientMessage =
  | { type: "add_project"; name: string; path: string; folder?: string }
  | { type: "pick_folder"; target?: PickTarget }
  | { type: "remove_project"; projectId: string }
  | { type: "send"; projectId: string; text: string; attachments?: AttachmentUpload[] }
  | { type: "send_split"; projectId: string; text: string; attachments?: AttachmentUpload[] }
  /** Edit / drop a prompt still waiting in the app-side queue. */
  | { type: "queue_edit"; projectId: string; itemId: string; text: string }
  | { type: "queue_remove"; projectId: string; itemId: string }
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
  /** Finish a tracker review: liked items clear, needs-work become repeats,
   *  and the small model writes a fix-it prompt for the composer. */
  | { type: "tracker_review"; projectId: string }
  | { type: "toggle_star"; projectId: string }
  | { type: "new_session"; projectId: string }
  | { type: "remove_session"; sessionId: string }
  | { type: "set_workspace"; path: string }
  | { type: "set_music_dir"; path: string }
  /** Cycle a model's star: none → starred → small-tasks model → none. */
  | { type: "toggle_model_star"; model: string }
  /** Wipe the Home chat (transcript + session) — it's ephemeral. */
  | { type: "reset_home" }
  /** Re-probe every installed harness's live model catalog. */
  | { type: "refresh_models" };

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
      /** App-side prompt queues per channel (visible entries only). */
      queued: Record<string, QueuedPrompt[]>;
      /** Whether the host can show a native folder-picker dialog. */
      canPickFolder: boolean;
      /** The workspace root the Home agent manages (where projects live). */
      workspaceDir: string;
      /** Where the music player's playlists live. */
      musicDir: string;
      /** The Home agent's model/permission settings. */
      home: HomeSettings;
      /** Starred model ids — the composer picker shows only these. */
      starredModels: string[];
      /** The double-starred small-tasks model ("" = the built-in default). */
      smallModel: string;
      /** The local account name shown on the sidebar's account bar. */
      user: string;
    }
  | { type: "projects"; projects: Project[] }
  | { type: "folder_picked"; path: string | null; target?: PickTarget }
  | { type: "turn_summary"; projectId: string; turnId: string; summary: string }
  | { type: "tracker"; projectId: string; items: TrackerItem[] }
  | { type: "workspace"; path: string }
  | { type: "music_dir"; path: string }
  | { type: "home_settings"; home: HomeSettings }
  | { type: "starred_models"; models: string[] }
  | { type: "small_model"; model: string }
  | { type: "home_reset" }
  /** The app-side prompt queue for a channel (visible, editable entries). */
  | { type: "queued"; projectId: string; items: QueuedPrompt[] }
  /** A finished tracker review's generated prompt, for the composer. */
  | { type: "review_prompt"; projectId: string; text: string }
  | { type: "event"; projectId: string; event: TranscriptEvent }
  | { type: "delta"; projectId: string; messageId: string; delta: string }
  | { type: "status"; projectId: string; status: ProjectStatus }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "models"; models: ModelChoice[] }
  | { type: "error"; message: string };
