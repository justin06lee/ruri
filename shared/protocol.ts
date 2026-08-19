/** Types shared between the ruri server and the web UI. Type-only module. */

export interface Project {
  id: string;
  name: string;
  path: string;
  folder?: string;
}

export type ProjectStatus = "idle" | "working" | "permission" | "error";

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
  ts: number;
}

export type ClientMessage =
  | { type: "add_project"; name: string; path: string; folder?: string }
  | { type: "remove_project"; projectId: string }
  | { type: "send"; projectId: string; text: string }
  | { type: "interrupt"; projectId: string }
  | { type: "permission_response"; requestId: string; allow: boolean };

export type ServerMessage =
  | {
      type: "snapshot";
      projects: Project[];
      transcripts: Record<string, TranscriptEvent[]>;
      statuses: Record<string, ProjectStatus>;
      permissions: PermissionRequest[];
    }
  | { type: "projects"; projects: Project[] }
  | { type: "event"; projectId: string; event: TranscriptEvent }
  | { type: "delta"; projectId: string; messageId: string; delta: string }
  | { type: "status"; projectId: string; status: ProjectStatus }
  | { type: "permission_request"; request: PermissionRequest }
  | { type: "permission_resolved"; requestId: string }
  | { type: "error"; message: string };
