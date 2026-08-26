import { randomUUID } from "node:crypto";
import {
  AgentSession,
  AuthRequiredError,
  ProviderNotInstalledError,
  type AgentOptions,
  type ContentBlockParam,
  type ModelRef,
  type PermissionDecision,
  type PermissionRequest as YagamiPermissionRequest,
  type Provider,
  type SDKMessage,
} from "@justin06lee/yagami";
import type {
  Attachment,
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

/** How the manager reaches non-Claude harnesses (see server/providers.ts). */
export interface ProviderHooks {
  /** Split a model id into provider + native model. */
  parse(model: string | undefined): ModelRef;
  /** Build a provider instance working in the given project directory. */
  create(id: string, workDir: string): Provider;
}

/** What the manager needs from a live session, whichever harness runs it. */
interface ChannelSession {
  status: ProjectStatus;
  lastSessionId: string | undefined;
  dead: boolean;
  send(text: string, images?: Array<{ data: string; mediaType?: string }>, attachments?: Attachment[]): void;
  interrupt(): void;
  setModel(model: string): void;
  setPermissionMode(mode: PermissionMode): void;
  dispose(): void;
  respondPermission(requestId: string, allow: boolean, always?: boolean): boolean;
  pendingRequests(): string[];
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

class ProjectSession implements ChannelSession {
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

  send(text: string, images?: Array<{ data: string; mediaType?: string }>, attachments?: Attachment[]): void {
    this.pushEvent({
      kind: "user",
      id: randomUUID(),
      text,
      ...(attachments?.length ? { attachments } : {}),
      ts: Date.now(),
    });
    this.setStatus("working");
    this.session.send(text, images?.length ? { images } : {});
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

/**
 * A session on a non-Claude harness (Codex, OpenCode, …): each turn is one
 * sandboxed provider.run() with resume, streamed into the same event shapes
 * ProjectSession emits. No tool events or permission prompts — those stay
 * inside the harness; the sandbox is the safety boundary instead.
 */
class ProviderTurnSession implements ChannelSession {
  status: ProjectStatus = "idle";
  /** Prefixed "<provider>:<session>", so a Claude resume can never eat it. */
  lastSessionId: string | undefined;
  dead = false;

  private model: string | undefined;
  private abort: AbortController | null = null;
  private running = false;
  private readonly backlog: Array<{
    text: string;
    images?: Array<{ data: string; mediaType?: string }>;
  }> = [];

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    readonly providerId: string,
    private readonly provider: Provider,
    nativeModel: string | undefined,
    resume: string | undefined,
  ) {
    this.model = nativeModel;
    if (resume?.startsWith(`${providerId}:`)) this.lastSessionId = resume;
  }

  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
  ): void {
    this.pushEvent({
      kind: "user",
      id: randomUUID(),
      text,
      ...(attachments?.length ? { attachments } : {}),
      ts: Date.now(),
    });
    this.setStatus("working");
    if (this.running) {
      // the harness runs one turn at a time — later sends wait their turn
      this.backlog.push({ text, ...(images ? { images } : {}) });
      return;
    }
    void this.run(text, images);
  }

  private async run(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
  ): Promise<void> {
    this.running = true;
    const started = Date.now();
    const draftId = randomUUID();
    this.abort = new AbortController();
    let acc = "";
    let costUsd: number | undefined;
    let error: string | undefined;
    try {
      const media: ContentBlockParam[] = (images ?? []).map((img) => ({
        type: "image",
        source: { type: "base64", data: img.data, media_type: img.mediaType ?? "image/png" },
      })) as ContentBlockParam[];
      const resume = this.lastSessionId?.slice(this.providerId.length + 1);
      for await (const event of this.provider.run({
        prompt: text,
        ...(media.length ? { media } : {}),
        ...(this.model ? { model: this.model } : {}),
        ...(resume ? { resume } : {}),
        signal: this.abort.signal,
      })) {
        if (event.type === "session") {
          this.lastSessionId = `${this.providerId}:${event.sessionId}`;
          this.events.onSessionId(this.project.id, this.lastSessionId);
        } else if (event.type === "text") {
          acc += event.text;
          this.events.onDelta(this.project.id, draftId, event.text);
        } else if (event.type === "done") {
          costUsd = event.costUsd;
        }
      }
    } catch (err) {
      if (this.abort?.signal.aborted) {
        error = "interrupted";
      } else if (err instanceof AuthRequiredError) {
        error = `${this.provider.label} needs a sign-in — run: ${this.provider.loginCommand}`;
      } else if (err instanceof ProviderNotInstalledError) {
        error = err.message;
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
    } finally {
      this.abort = null;
    }
    if (acc) this.pushEvent({ kind: "assistant", id: draftId, text: acc, ts: Date.now() });
    this.pushEvent({
      kind: "result",
      id: randomUUID(),
      ok: error === undefined,
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: Date.now() - started,
      ...(error !== undefined ? { error } : {}),
      ts: Date.now(),
    });
    this.running = false;
    const next = this.backlog.shift();
    if (next && !this.dead) {
      void this.run(next.text, next.images);
    } else {
      this.setStatus(error === undefined || error === "interrupted" ? "idle" : "error");
    }
  }

  interrupt(): void {
    this.backlog.length = 0;
    this.abort?.abort();
  }

  /** The native model for the next turn ("" = the harness's default). */
  setModel(model: string): void {
    this.model = model || undefined;
  }

  setPermissionMode(): void {
    // permission modes are a Claude concept; the harness sandbox stands in
  }

  dispose(): void {
    this.dead = true;
    this.backlog.length = 0;
    this.abort?.abort();
  }

  respondPermission(): boolean {
    return false;
  }

  pendingRequests(): string[] {
    return [];
  }

  private pushEvent(event: TranscriptEvent): void {
    this.events.onEvent(this.project.id, event);
  }

  private setStatus(status: ProjectStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.events.onStatus(this.project.id, status);
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, ChannelSession>();

  constructor(
    private readonly events: SessionEvents,
    /** Where to find the resumable session id for a project (the archive). */
    private readonly resumeFor: (projectId: string) => string | undefined = () => undefined,
    /** Per-project session extras (the Home agent's MCP tools and prompt). */
    private readonly extrasFor: (project: Project) => SessionExtras | undefined = () => undefined,
    /** Non-Claude harness support; omitted = Claude-only. */
    private readonly providers?: ProviderHooks,
  ) {}

  /** The non-Claude provider id a model routes to, if any. */
  private routeOf(model: string | undefined): { providerId?: string; model?: string } {
    const ref = this.providers ? this.providers.parse(model) : { model };
    if (ref.providerId && ref.providerId !== "claude") return ref;
    return { ...(ref.model !== undefined ? { model: ref.model } : {}) };
  }

  /** Send a message, starting (or restarting, resuming context) the session as needed. */
  send(
    project: Project,
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
  ): void {
    const route = this.routeOf(project.model);
    let session = this.sessions.get(project.id);
    // The model moved to a different harness: retire the live session. The
    // transcript and archive are per-channel and survive; only warm state goes.
    if (session && !session.dead) {
      const mismatch = route.providerId
        ? !(session instanceof ProviderTurnSession && session.providerId === route.providerId)
        : session instanceof ProviderTurnSession;
      if (mismatch) {
        session.dispose();
        session = undefined;
        this.sessions.delete(project.id);
      }
    }
    if (!session || session.dead) {
      const resume = session?.lastSessionId ?? this.resumeFor(project.id);
      if (route.providerId && this.providers) {
        session = new ProviderTurnSession(
          project,
          this.events,
          route.providerId,
          this.providers.create(route.providerId, project.path),
          route.model,
          resume,
        );
      } else {
        // provider-prefixed resume ids never feed a Claude session
        const claudeResume = resume && !resume.includes(":") ? resume : undefined;
        session = new ProjectSession(
          { ...project, ...(route.model !== undefined ? { model: route.model } : {}) },
          this.events,
          claudeResume,
          this.extrasFor(project),
        );
      }
      this.sessions.set(project.id, session);
    }
    session.send(text, images, attachments);
  }

  interrupt(projectId: string): void {
    this.sessions.get(projectId)?.interrupt();
  }

  /** Apply a model change to the live session, if one is running. An empty
   *  model means "CLI default", which only takes effect on the next session.
   *  A change that moves to a different harness retires the live session —
   *  the next send rebuilds it on the right provider. */
  setModel(projectId: string, model: string): void {
    const session = this.sessions.get(projectId);
    if (!session || session.dead) return;
    const route = this.routeOf(model);
    if (route.providerId) {
      if (session instanceof ProviderTurnSession && session.providerId === route.providerId) {
        session.setModel(route.model ?? "");
      } else {
        session.dispose();
        this.sessions.delete(projectId);
      }
    } else if (session instanceof ProviderTurnSession) {
      session.dispose();
      this.sessions.delete(projectId);
    } else if (model) {
      session.setModel(route.model ?? model);
    }
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
