import { randomUUID } from "node:crypto";
import {
  AgentSession,
  AuthRequiredError,
  isSessionProvider,
  ProviderNotInstalledError,
  type AgentEvent,
  type AgentOptions,
  type ContentBlockParam,
  type ModelRef,
  type PermissionDecision,
  type PermissionRequest as YagamiPermissionRequest,
  type Provider,
  type ProviderSession,
  type SDKMessage,
  type SessionPermissionDecision,
  type SessionPermissionRequest,
  type SessionProvider,
} from "@justin06lee/yagami";
import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
  type Attachment,
  type ModelChoice,
  type PermissionMode,
  type PermissionRequest,
  type Project,
  type ProjectStatus,
  type TranscriptEvent,
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
  /** Context-window occupancy after the session's latest API call. */
  onContext(projectId: string, tokens: number): void;
  /** A turn's SDK chain uuid landed: the prompt's own uuid ("user", the
   *  file-rewind target) or the turn's latest entry ("last", the fork
   *  point for rewinding past it). Claude sessions only. */
  onChain(projectId: string, eventId: string, kind: "user" | "last", uuid: string): void;
}

/** Extra per-project session config (the Home agent's MCP tools live here). */
export interface SessionExtras {
  /** Tool names auto-allowed without a permission prompt. */
  autoAllow?: string[];
  /** Extra Agent SDK options, merged last. */
  options?: AgentOptions;
  /** System prompt for non-Claude harness sessions. Codex takes it natively
   *  (developer instructions on the thread); ACP agents can't, so it rides
   *  the first prompt of each app run as a <system> block. */
  providerSystem?: string;
  /** Runs when a non-Claude turn finishes (Home's drop-file pickup). */
  onProviderTurnEnd?: () => void;
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
  /** silent = no user transcript event (split sub-prompts ride under the
   *  original prompt the user already sees). */
  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent?: boolean,
  ): void;
  interrupt(): void;
  setModel(model: string): void;
  setPermissionMode(mode: PermissionMode): void;
  /** Apply a new reasoning effort. No harness changes it on a warm session,
   *  so implementations either take it for their next turn (run-per-turn)
   *  or retire themselves — the next send rebuilds with resume. */
  setEffort(effort: string): void;
  /** Restore tracked files to their state at a user message's chain uuid
   *  (Claude only — other harnesses answer canRewind: false). */
  rewindFiles(uuid: string): Promise<{ canRewind: boolean; error?: string }>;
  dispose(): void;
  respondPermission(requestId: string, allow: boolean, always?: boolean): boolean;
  pendingRequests(): string[];
}

/** Collapse absolute paths inside the project down to "name/relative" —
 *  paths outside the project keep their full string, which is the signal. */
function shortenPaths(text: string, project: Project): string {
  const root = project.path.replace(/\/+$/, "");
  if (!root) return text;
  return text.replaceAll(`${root}/`, `${project.name}/`).replaceAll(root, project.name);
}

function toolSummary(name: string, input: Record<string, unknown>, project: Project): string {
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
  summary = shortenPaths(summary, project);
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
  /** The user pressed stop — the next result reads "stopped", not as an
   *  error (the CLI reports an abort as a diagnostic-soup failure). */
  private interrupted = false;
  /** Sent prompts awaiting their SDK echo, to map event id → chain uuid. */
  private readonly pendingUserEvents: string[] = [];
  /** The user event whose turn the incoming chain uuids belong to. */
  private turnEventId: string | undefined;
  private readonly pending = new Map<string, PendingPermission>();

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    resume?: string,
    resumeAt?: string,
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
        // snapshot files before edits, so a rewind can restore them
        enableFileCheckpointing: true,
        ...(project.permissionMode ? { permissionMode: project.permissionMode } : {}),
        effort: (project.effort || DEFAULT_EFFORT) as AgentOptions["effort"],
        ...(resume ? { resume } : {}),
        // a rewind resumes truncated at the kept turn's last chain entry,
        // forked so the original chain stays intact on disk
        ...(resume && resumeAt ? { resumeSessionAt: resumeAt, forkSession: true } : {}),
        ...extras?.options,
      },
    });
    void this.run();
  }

  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent = false,
  ): void {
    if (!silent) {
      const id = randomUUID();
      // the SDK echoes the prompt back with its chain uuid; this queue
      // pairs that echo with the transcript event it belongs to
      this.pendingUserEvents.push(id);
      this.pushEvent({
        kind: "user",
        id,
        text,
        ...(attachments?.length ? { attachments } : {}),
        ts: Date.now(),
      });
    }
    this.setStatus("working");
    this.interrupted = false;
    this.session.send(text, images?.length ? { images } : {});
  }

  interrupt(): void {
    this.interrupted = true;
    void this.session.interrupt().catch(() => {});
  }

  async rewindFiles(uuid: string): Promise<{ canRewind: boolean; error?: string }> {
    try {
      const result = await this.session.rewindFiles(uuid);
      return { canRewind: result.canRewind, ...(result.error ? { error: result.error } : {}) };
    } catch (err) {
      return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  setModel(model: string): void {
    void this.session.setModel(model).catch(() => {});
  }

  setPermissionMode(mode: PermissionMode): void {
    void this.session.setPermissionMode(mode).catch(() => {});
  }

  /** Effort is a construction-time SDK option — retire; resume carries on. */
  setEffort(): void {
    this.dispose();
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
    } else if (msg.type === "user" && msg.parent_tool_use_id === null) {
      // The prompt's echo carries its chain uuid — pair it with the queued
      // transcript event; tool results and synthetic messages only extend
      // the running turn's "last" entry.
      const uuid = (msg as { uuid?: string }).uuid;
      if (uuid) {
        const content = (msg.message as { content?: unknown }).content;
        const toolResult =
          Array.isArray(content) &&
          content.some((block) => (block as { type?: string }).type === "tool_result");
        const synthetic = (msg as { isSynthetic?: boolean }).isSynthetic === true;
        if (!toolResult && !synthetic && this.pendingUserEvents.length > 0) {
          this.turnEventId = this.pendingUserEvents.shift()!;
          this.events.onChain(this.project.id, this.turnEventId, "user", uuid);
        }
        if (this.turnEventId) this.events.onChain(this.project.id, this.turnEventId, "last", uuid);
      }
    } else if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
      const chainUuid = (msg as { uuid?: string }).uuid;
      if (chainUuid && this.turnEventId) {
        this.events.onChain(this.project.id, this.turnEventId, "last", chainUuid);
      }
      // Each main-loop API call's usage tells us how full the context window
      // is right now: everything sent (fresh + cached) plus what came back.
      const usage = (
        msg.message as unknown as {
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          };
        }
      ).usage;
      if (usage) {
        const tokens =
          (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.output_tokens ?? 0);
        if (tokens > 0) this.events.onContext(this.project.id, tokens);
      }
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
            summary: toolSummary(name, input, this.project),
            ts: Date.now(),
          });
        }
      }
    } else if (msg.type === "result") {
      this.lastSessionId = msg.session_id;
      this.events.onSessionId(this.project.id, msg.session_id);
      this.draftId = null;
      const stopped = this.interrupted;
      this.interrupted = false;
      const ok = msg.subtype === "success";
      this.pushEvent({
        kind: "result",
        id: randomUUID(),
        ok: ok || stopped,
        costUsd: msg.total_cost_usd,
        durationMs: msg.duration_ms,
        ...(stopped ? { stopped: true } : {}),
        ...(ok || stopped
          ? {}
          : { error: "errors" in msg && msg.errors.length > 0 ? msg.errors.join("; ") : msg.subtype }),
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
  private effort: string;
  private abort: AbortController | null = null;
  private running = false;
  private readonly backlog: Array<{
    text: string;
    images?: Array<{ data: string; mediaType?: string }>;
  }> = [];

  /** Whether the system block already rode a prompt this app run. Sent on
   *  the first turn even when resuming, so updated instructions reach
   *  sessions that predate them. */
  private sentSystem = false;

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    readonly providerId: string,
    private readonly provider: Provider,
    nativeModel: string | undefined,
    resume: string | undefined,
    private readonly extras?: SessionExtras,
  ) {
    this.model = nativeModel;
    this.effort = project.effort || DEFAULT_EFFORT;
    if (resume?.startsWith(`${providerId}:`)) this.lastSessionId = resume;
  }

  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent = false,
  ): void {
    if (!silent) {
      this.pushEvent({
        kind: "user",
        id: randomUUID(),
        text,
        ...(attachments?.length ? { attachments } : {}),
        ts: Date.now(),
      });
    }
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
    let stopped = false;
    try {
      const media: ContentBlockParam[] = (images ?? []).map((img) => ({
        type: "image",
        source: { type: "base64", data: img.data, media_type: img.mediaType ?? "image/png" },
      })) as ContentBlockParam[];
      const resume = this.lastSessionId?.slice(this.providerId.length + 1);
      // system emulation, mirroring yagami's engine: the block prefixes the
      // prompt once, then lives on in the harness's own resumed context
      let prompt = text;
      if (this.extras?.providerSystem && !this.sentSystem) {
        prompt = `<system>\n${this.extras.providerSystem}\n</system>\n\n${text}`;
        this.sentSystem = true;
      }
      for await (const event of this.provider.run({
        prompt,
        ...(media.length ? { media } : {}),
        ...(this.model ? { model: this.model } : {}),
        effort: this.effort,
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
        stopped = true;
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
    // pick up anything the turn dropped for the app (Home's open requests)
    // before the result lands, so the sidebar is current when "done" shows
    try {
      this.extras?.onProviderTurnEnd?.();
    } catch {
      // a bad drop file must not kill the turn pipeline
    }
    this.pushEvent({
      kind: "result",
      id: randomUUID(),
      ok: error === undefined,
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: Date.now() - started,
      ...(stopped ? { stopped: true } : {}),
      ...(error !== undefined ? { error } : {}),
      ts: Date.now(),
    });
    this.running = false;
    const next = this.backlog.shift();
    if (next && !this.dead) {
      void this.run(next.text, next.images);
    } else {
      this.setStatus(error === undefined ? "idle" : "error");
    }
  }

  interrupt(): void {
    this.backlog.length = 0;
    this.abort?.abort();
  }

  rewindFiles(): Promise<{ canRewind: boolean; error?: string }> {
    return Promise.resolve({ canRewind: false, error: "rewind is a Claude-session feature" });
  }

  /** The native model for the next turn ("" = the harness's default). */
  setModel(model: string): void {
    this.model = model || undefined;
  }

  setPermissionMode(): void {
    // permission modes are a Claude concept; the harness sandbox stands in
  }

  /** Each turn is its own run — the new effort simply rides the next one. */
  setEffort(effort: string): void {
    this.effort = effort || DEFAULT_EFFORT;
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

/** A provider tool_call, shaped for a ruri transcript chip. */
function providerToolEvent(
  ev: Extract<AgentEvent, { type: "tool_call" }>,
  project: Project,
): { name: string; summary: string } {
  const name = ev.name.length > 0 ? ev.name[0]!.toUpperCase() + ev.name.slice(1) : "Tool";
  const summary = shortenPaths(ev.title ?? (ev.input !== undefined ? JSON.stringify(ev.input) : ""), project);
  return { name, summary: summary.length > 160 ? `${summary.slice(0, 157)}…` : summary };
}

/**
 * A session on a non-Claude harness that supports yagami's agentic session
 * layer (Codex via app-server, every ACP agent): the harness runs VERBATIM —
 * its own config, sandbox, and approval flow — warm across turns, with tool
 * calls streamed as transcript chips and approval requests surfaced as ruri
 * permission cards ("Always allow" maps to the harness's own
 * approve-for-session answer).
 */
class ProviderAgentSession implements ChannelSession {
  status: ProjectStatus = "idle";
  /** Prefixed "<provider>:<session>", so a Claude resume can never eat it. */
  lastSessionId: string | undefined;
  dead = false;

  private readonly session: ProviderSession;
  private nativeModel: string | undefined;
  private running = false;
  private readonly backlog: Array<{
    text: string;
    images?: Array<{ data: string; mediaType?: string }>;
  }> = [];
  private readonly pending = new Map<string, { resolve(d: SessionPermissionDecision): void }>();
  /** ACP can't take a system prompt natively — the first turn of each app
   *  run carries it as a <system> block (codex gets developerInstructions). */
  private sentSystem = false;

  constructor(
    private readonly project: Project,
    private readonly events: SessionEvents,
    readonly providerId: string,
    provider: SessionProvider,
    nativeModel: string | undefined,
    resume: string | undefined,
    private readonly extras?: SessionExtras,
  ) {
    this.nativeModel = nativeModel;
    if (resume?.startsWith(`${providerId}:`)) this.lastSessionId = resume;
    const nativeResume = this.lastSessionId?.slice(providerId.length + 1);
    this.session = provider.openSession({
      cwd: project.path,
      appName: "ruri",
      ...(nativeModel ? { model: nativeModel } : {}),
      effort: project.effort || DEFAULT_EFFORT,
      ...(nativeResume ? { resume: nativeResume } : {}),
      ...(extras?.providerSystem ? { systemPrompt: extras.providerSystem } : {}),
      permissions: { decide: (req) => this.decide(req) },
    });
  }

  send(
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent = false,
  ): void {
    if (!silent) {
      this.pushEvent({
        kind: "user",
        id: randomUUID(),
        text,
        ...(attachments?.length ? { attachments: attachments } : {}),
        ts: Date.now(),
      });
    }
    this.setStatus("working");
    if (this.running) {
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
    let acc = "";
    let costUsd: number | undefined;
    let error: string | undefined;
    let interrupted = false;
    const toolsSeen = new Set<string>();
    try {
      let prompt = text;
      if (this.extras?.providerSystem && this.providerId !== "codex" && !this.sentSystem) {
        prompt = `<system>\n${this.extras.providerSystem}\n</system>\n\n${text}`;
        this.sentSystem = true;
      }
      const input: string | ContentBlockParam[] = images?.length
        ? ([
            ...images.map((img) => ({
              type: "image",
              source: { type: "base64", data: img.data, media_type: img.mediaType ?? "image/png" },
            })),
            { type: "text", text: prompt },
          ] as ContentBlockParam[])
        : prompt;
      for await (const event of this.session.send(input)) {
        if (event.type === "session") {
          this.lastSessionId = `${this.providerId}:${event.sessionId}`;
          this.events.onSessionId(this.project.id, this.lastSessionId);
        } else if (event.type === "text") {
          acc += event.text;
          this.events.onDelta(this.project.id, draftId, event.text);
        } else if (event.type === "tool_call") {
          if (event.status !== "started" || toolsSeen.has(event.id)) continue;
          toolsSeen.add(event.id);
          const { name, summary } = providerToolEvent(event, this.project);
          this.pushEvent({ kind: "tool", id: randomUUID(), name, summary, ts: Date.now() });
        } else if (event.type === "done") {
          costUsd = event.costUsd;
          interrupted = event.stopReason === "interrupted";
        }
      }
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        error = err.message;
      } else if (err instanceof ProviderNotInstalledError) {
        error = err.message;
      } else {
        error = err instanceof Error ? err.message : String(err);
      }
    }
    this.rejectPending();
    if (acc) this.pushEvent({ kind: "assistant", id: draftId, text: acc, ts: Date.now() });
    // pick up anything the turn dropped for the app (Home's open requests)
    try {
      this.extras?.onProviderTurnEnd?.();
    } catch {
      // a bad drop file must not kill the turn pipeline
    }
    this.pushEvent({
      kind: "result",
      id: randomUUID(),
      ok: error === undefined,
      ...(costUsd !== undefined ? { costUsd } : {}),
      durationMs: Date.now() - started,
      ...(error !== undefined ? { error } : interrupted ? { stopped: true } : {}),
      ts: Date.now(),
    });
    this.running = false;
    const next = this.backlog.shift();
    if (next && !this.dead) {
      void this.run(next.text, next.images);
    } else {
      this.setStatus(error === undefined ? "idle" : "error");
    }
  }

  /** The harness asked to do something — show ruri's permission card. */
  private decide(req: SessionPermissionRequest): Promise<SessionPermissionDecision> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, { resolve });
      this.events.onPermission({
        requestId,
        projectId: this.project.id,
        toolName: req.tool,
        input: req.input ?? (req.title ? { request: req.title } : {}),
        ts: Date.now(),
      });
      this.setStatus("permission");
    });
  }

  respondPermission(requestId: string, allow: boolean, always = false): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.resolve(allow ? (always ? "allow_always" : "allow") : "deny");
    this.events.onPermissionResolved(requestId);
    if (this.running && this.pending.size === 0) this.setStatus("working");
    return true;
  }

  pendingRequests(): string[] {
    return [...this.pending.keys()];
  }

  private rejectPending(): void {
    for (const [requestId, pending] of this.pending) {
      pending.resolve("deny");
      this.events.onPermissionResolved(requestId);
    }
    this.pending.clear();
  }

  interrupt(): void {
    this.backlog.length = 0;
    void this.session.interrupt();
  }

  rewindFiles(): Promise<{ canRewind: boolean; error?: string }> {
    return Promise.resolve({ canRewind: false, error: "rewind is a Claude-session feature" });
  }

  /** A model change re-opens the session on the same thread via resume. */
  setModel(model: string): void {
    if ((model || undefined) === this.nativeModel) return;
    this.nativeModel = model || undefined;
    this.dead = true;
    void this.session.close();
  }

  setPermissionMode(): void {
    // permission modes are a Claude concept; the harness's own flow stands in
  }

  /** Effort is fixed at session open — retire; the rebuild resumes the thread. */
  setEffort(): void {
    this.dead = true;
    void this.session.close();
  }

  dispose(): void {
    this.dead = true;
    this.backlog.length = 0;
    this.rejectPending();
    void this.session.close();
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

/** The non-Claude provider id a live session runs on, if any. */
function providerSessionId(session: ChannelSession): string | undefined {
  if (session instanceof ProviderTurnSession || session instanceof ProviderAgentSession) {
    return session.providerId;
  }
  return undefined;
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
    /** A pending rewind's fork point, claimed when a Claude session builds
     *  (the archive's take-once resumeAt). */
    private readonly resumeAtFor: (projectId: string) => string | undefined = () => undefined,
  ) {}

  /** The non-Claude provider id a model routes to, if any. An unset model
   *  means the app default (Fable) — never the CLI's own notion of default. */
  private routeOf(model: string | undefined): { providerId?: string; model?: string } {
    const effective = model || DEFAULT_MODEL;
    const ref = this.providers ? this.providers.parse(effective) : { model: effective };
    if (ref.providerId && ref.providerId !== "claude") return ref;
    return { ...(ref.model !== undefined ? { model: ref.model } : {}) };
  }

  /** Send a message, starting (or restarting, resuming context) the session
   *  as needed. silent = no user transcript event (split sub-prompts). */
  send(
    project: Project,
    text: string,
    images?: Array<{ data: string; mediaType?: string }>,
    attachments?: Attachment[],
    silent?: boolean,
  ): void {
    this.acquire(project).send(text, images, attachments, silent);
  }

  /** Restore the project's files to a user message's checkpoint, starting
   *  (or resuming) the session if needed — Claude sessions only. */
  rewindFiles(project: Project, uuid: string): Promise<{ canRewind: boolean; error?: string }> {
    return this.acquire(project).rewindFiles(uuid);
  }

  /** The live session for a channel, built (with resume) when missing. */
  private acquire(project: Project): ChannelSession {
    const route = this.routeOf(project.model);
    let session = this.sessions.get(project.id);
    // The model moved to a different harness: retire the live session. The
    // transcript and archive are per-channel and survive; only warm state goes.
    if (session && !session.dead) {
      const providerOf = providerSessionId(session);
      const mismatch = route.providerId ? providerOf !== route.providerId : providerOf !== undefined;
      if (mismatch) {
        session.dispose();
        session = undefined;
        this.sessions.delete(project.id);
      }
    }
    if (!session || session.dead) {
      const resume = session?.lastSessionId ?? this.resumeFor(project.id);
      if (route.providerId && this.providers) {
        const provider = this.providers.create(route.providerId, project.path);
        // the agentic path (Codex app-server, ACP) is the harness verbatim;
        // run()-per-turn stays as the fallback for anything without it
        session = isSessionProvider(provider)
          ? new ProviderAgentSession(
              project,
              this.events,
              route.providerId,
              provider,
              route.model,
              resume,
              this.extrasFor(project),
            )
          : new ProviderTurnSession(
              project,
              this.events,
              route.providerId,
              provider,
              route.model,
              resume,
              this.extrasFor(project),
            );
      } else {
        // provider-prefixed resume ids never feed a Claude session
        const claudeResume = resume && !resume.includes(":") ? resume : undefined;
        session = new ProjectSession(
          { ...project, ...(route.model !== undefined ? { model: route.model } : {}) },
          this.events,
          claudeResume,
          claudeResume ? this.resumeAtFor(project.id) : undefined,
          this.extrasFor(project),
        );
      }
      this.sessions.set(project.id, session);
    }
    return session;
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
    const providerOf = providerSessionId(session);
    if (route.providerId) {
      if (providerOf === route.providerId) {
        session.setModel(route.model ?? "");
      } else {
        session.dispose();
        this.sessions.delete(projectId);
      }
    } else if (providerOf !== undefined) {
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

  /** Apply an effort change to the live session, if one is running. Only the
   *  run-per-turn path takes it live; warm sessions retire and rebuild
   *  (resuming their context) on the next send. */
  setEffort(projectId: string, effort: string): void {
    const session = this.sessions.get(projectId);
    if (!session || session.dead) return;
    session.setEffort(effort);
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
