/** Types shared between the ruri server and the web UI. Type-only module. */

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
  | { type: "remove_project"; projectId: string }
  | { type: "send"; projectId: string; text: string }
  | { type: "interrupt"; projectId: string }
  | { type: "permission_response"; requestId: string; allow: boolean; always?: boolean }
  | { type: "set_model"; projectId: string; model: string }
  | { type: "set_permission_mode"; projectId: string; mode: PermissionMode };

export type ServerMessage =
  | {
      type: "snapshot";
      projects: Project[];
      transcripts: Record<string, TranscriptEvent[]>;
      statuses: Record<string, ProjectStatus>;
      permissions: PermissionRequest[];
      models: ModelChoice[];
    }
  | { type: "projects"; projects: Project[] }
  | { type: "event"; projectId: string; event: TranscriptEvent }
  | { type: "delta"; projectId: string; messageId: string; delta: string }
  | { type: "status"; projectId: string; status: ProjectStatus }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "models"; models: ModelChoice[] }
  | { type: "error"; message: string };
