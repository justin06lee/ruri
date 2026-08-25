import { randomUUID } from "node:crypto";
import {
  AgentSession,
  type AgentOptions,
  type PermissionDecision,
  type PermissionRequest as YagamiPermissionRequest,
  type SDKMessage,
} from "@justin06lee/yagami";
import type {
  ModelChoice,
  PermissionMode,
  PermissionRequest,
  Project,
  ProjectStatus,
  TranscriptEvent,
} from "../shared/protocol.js";

type PermissionUpdate = NonNullable<YagamiPermissionRequest["suggestions"]>[number];

export interface SessionEvents {
  onEvent(projectId: string, event: TranscriptEvent): void;
  onDelta(projectId: string, messageId: string, delta: string): void;
  onStatus(projectId: string, status: ProjectStatus): void;
  onPermission(request: PermissionRequest): void;
  onPermissionResolved(requestId: string): void;
  onModels(models: ModelChoice[]): void;
  /** The live Claude session id changed (used to resume across restarts). */
  onSessionId(projectId: string, sessionId: string): void;
}

/** Extra per-project session config (the Home agent's MCP tools live here). */
export interface SessionExtras {
  /** Tool names auto-allowed without a permission prompt. */
  autoAllow?: string[];
  /** Extra Agent SDK options, merged last. */
  options?: AgentOptions;
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined);
  let summary: string | undefined;
  switch (name) {
    case "Bash":
      summary = str("command");
      break;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      summary = str("file_path");
      break;
    case "Glob":
    case "Grep":
      summary = [str("pattern"), str("path")].filter(Boolean).join(" in ");
      break;
    case "WebFetch":
      summary = str("url");
      break;
    case "WebSearch":
      summary = str("query");
      break;
    case "Agent":
    case "Task":
      summary = str("description") ?? str("prompt");
      break;
    case "Skill":
      summary = str("skill") ?? str("command");
      break;
  }
  summary ??= JSON.stringify(input);
  return summary.length > 160 ? `${summary.slice(0, 157)}…` : summary;
}

interface PendingPermission {
  resolve(decision: PermissionDecision): void;
  toolName: string;
  suggestions?: PermissionUpdate[];
}

class ProjectSession {
  status: ProjectStatus = "idle";
  lastSessionId: string | undefined;
  dead = false;

  private readonly session: AgentSession;
  private draftId: string | null = null;
  private readonly pending = new Map<string, PendingPermission>();

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    resume?: string,
    extras?: SessionExtras,
  ) {
    this.lastSessionId = resume;
    this.session = new AgentSession({
      cwd: project.path,
      appName: "ruri",
      parity: "terminal",
      ...(project.model ? { model: project.model } : {}),
      onPermission: this.onPermission,
      ...(extras?.autoAllow ? { permission: { autoAllow: extras.autoAllow } } : {}),
      options: {
        ...(project.permissionMode ? { permissionMode: project.permissionMode } : {}),
        ...(resume ? { resume } : {}),
        ...extras?.options,
      },
    });
    void this.run();
  }

  send(text: string): void {
    this.pushEvent({ kind: "user", id: randomUUID(), text, ts: Date.now() });
    this.setStatus("working");
    this.session.send(text);
  }

  interrupt(): void {
    void this.session.interrupt().catch(() => {});
  }

  setModel(model: string): void {
    void this.session.setModel(model).catch(() => {});
  }

  setPermissionMode(mode: PermissionMode): void {
    void this.session.setPermissionMode(mode).catch(() => {});
  }

  dispose(): void {
    this.dead = true;
    this.session.close();
    this.rejectAllPending();
  }

  respondPermission(requestId: string, allow: boolean, always = false): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    if (allow && always && !pending.suggestions?.length) {
      // No CLI-suggested rule to persist — at least stop asking this session.
      this.session.permissions.allowTool(pending.toolName);
    }
    pending.resolve(
      allow
        ? {
            behavior: "allow",
            ...(always && pending.suggestions?.length
              ? { updatedPermissions: pending.suggestions }
              : {}),
          }
        : { behavior: "deny", message: "The user denied this tool use in ruri." },
    );
    this.events.onPermissionResolved(requestId);
    if (this.pending.size === 0 && this.status === "permission") this.setStatus("working");
    return true;
  }

  pendingRequests(): string[] {
    return [...this.pending.keys()];
  }

  private onPermission = (req: YagamiPermissionRequest): Promise<PermissionDecision> =>
    new Promise<PermissionDecision>((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, {
        resolve,
        toolName: req.toolName,
        ...(req.suggestions ? { suggestions: req.suggestions } : {}),
      });
      this.setStatus("permission");
      this.events.onPermission({
        requestId,
        projectId: this.project.id,
        toolName: req.toolName,
        input: req.input,
        ...(req.suggestions ? { suggestions: req.suggestions } : {}),
        ts: Date.now(),
      });
      req.signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(requestId)) return;
          this.pending.delete(requestId);
          resolve({ behavior: "deny", message: "aborted" });
          this.events.onPermissionResolved(requestId);
        },
        { once: true },
      );
    });

  private async run(): Promise<void> {
    try {
      for await (const msg of this.session) this.handle(msg);
    } catch (err) {
      this.pushEvent({
        kind: "info",
        id: randomUUID(),
        text: `session error: ${err instanceof Error ? err.message : String(err)}`,
        ts: Date.now(),
      });
      this.setStatus("error");
    } finally {
      this.dead = true;
      this.rejectAllPending();
    }
  }

  private handle(msg: SDKMessage): void {
    if (msg.type === "system" && msg.subtype === "init") {
      this.lastSessionId = msg.session_id;
      this.events.onSessionId(this.project.id, msg.session_id);
      void this.reportModels();
    } else if (msg.type === "stream_event" && msg.parent_tool_use_id === null) {
      const event = msg.event as { type: string; delta?: { type?: string; text?: string } };
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        this.draftId ??= randomUUID();
        this.events.onDelta(this.project.id, this.draftId, event.delta.text);
      }
    } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      const blocks =
        (msg.message as unknown as { content?: Array<Record<string, unknown> & { type: string }> })
          .content ?? [];
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => (typeof b["text"] === "string" ? (b["text"] as string) : ""))
        .join("");
      if (text) {
        this.pushEvent({ kind: "assistant", id: this.draftId ?? randomUUID(), text, ts: Date.now() });
      }
      this.draftId = null;
      for (const block of blocks) {
        if (block.type === "tool_use") {
          const name = typeof block["name"] === "string" ? (block["name"] as string) : "tool";
          const input = (block["input"] ?? {}) as Record<string, unknown>;
          this.pushEvent({
            kind: "tool",
            id: randomUUID(),
            name,
            summary: toolSummary(name, input),
            ts: Date.now(),
          });
        }
      }
    } else if (msg.type === "result") {
      this.lastSessionId = msg.session_id;
      this.events.onSessionId(this.project.id, msg.session_id);
      this.draftId = null;
      const ok = msg.subtype === "success";
      this.pushEvent({
        kind: "result",
        id: randomUUID(),
        ok,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        ...(ok ? {} : { error: "errors" in msg && msg.errors.length > 0 ? msg.errors.join("; ") : msg.subtype }),
        ts: Date.now(),
      });
      this.setStatus("idle");
    }
  }

  private async reportModels(): Promise<void> {
    try {
      this.events.onModels(await this.session.supportedModels());
    } catch {
      // model list is a nicety; the picker just stays empty
    }
  }

  private pushEvent(event: TranscriptEvent): void {
    this.events.onEvent(this.project.id, event);
  }

  private setStatus(status: ProjectStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(this.project.id, status);
  }

  private rejectAllPending(): void {
    for (const [requestId, pending] of this.pending) {
      pending.resolve({ behavior: "deny", message: "session ended" });
      this.events.onPermissionResolved(requestId);
    }
    this.pending.clear();
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, ProjectSession>();

  constructor(
    private readonly events: SessionEvents,
    /** Where to find the resumable session id for a project (the archive). */
    private readonly resumeFor: (projectId: string) => string | undefined = () => undefined,
    /** Per-project session extras (the Home agent's MCP tools and prompt). */
    private readonly extrasFor: (project: Project) => SessionExtras | undefined = () => undefined,
  ) {}

  /** Send a message, starting (or restarting, resuming context) the session as needed. */
  send(project: Project, text: string): void {
    let session = this.sessions.get(project.id);
    if (!session || session.dead) {
      session = new ProjectSession(
        project,
        this.events,
        session?.lastSessionId ?? this.resumeFor(project.id),
        this.extrasFor(project),
      );
      this.sessions.set(project.id, session);
    }
    session.send(text);
  }

  interrupt(projectId: string): void {
    this.sessions.get(projectId)?.interrupt();
  }

  /** Apply a model change to the live session, if one is running. An empty
   *  model means "CLI default", which only takes effect on the next session. */
  setModel(projectId: string, model: string): void {
    if (model) this.sessions.get(projectId)?.setModel(model);
  }

  /** Apply a permission-mode change to the live session, if one is running. */
  setPermissionMode(projectId: string, mode: PermissionMode): void {
    this.sessions.get(projectId)?.setPermissionMode(mode);
  }

  respondPermission(requestId: string, allow: boolean, always = false): void {
    for (const session of this.sessions.values()) {
      if (session.respondPermission(requestId, allow, always)) return;
    }
  }

  dispose(projectId: string): void {
    this.sessions.get(projectId)?.dispose();
    this.sessions.delete(projectId);
  }

  disposeAll(): void {
    for (const id of [...this.sessions.keys()]) this.dispose(id);
  }

  statuses(): Record<string, ProjectStatus> {
    return Object.fromEntries([...this.sessions].map(([id, s]) => [id, s.status]));
  }
}
